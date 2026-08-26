import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HarnessRunOutcome,
  IssueForgeConfig,
  RunId,
  RunState,
  Sha,
} from '@issueforge/contracts';
import {
  buildReproduceCard,
  classifyAttempt,
  classifyFailure,
  HarnessContractError,
  type AttemptFailure,
  type HarnessAdapter,
  type RunStore,
  type Workspace,
  type WorkspaceManager,
} from '@issueforge/core';
import { JsonlWriter, type Logger } from '../logger/index.js';
import { reapOrphans } from '../process/index.js';
import { auditWorkspace, WriteBoundaryError } from '../policy/index.js';
import { runPath } from '../workspace/index.js';

/**
 * Runs one reproduce attempt end to end.
 *
 * The ordering here is the whole point, and it is not arbitrary: cancellation gives
 * the process about seven and a half seconds before its tree is killed, so every
 * state transition is written BEFORE the side effect it describes. A kill at any
 * instant then leaves a row that can be reconciled, rather than a side effect nobody
 * recorded.
 */

export interface ReproduceRunnerDeps {
  store: RunStore;
  workspaces: WorkspaceManager;
  harness: HarnessAdapter;
  config: IssueForgeConfig;
  logger: Logger;
  /** Root for run artifacts. Injected so tests need no home directory. */
  root: string;
}

export interface ReproduceRequest {
  repo: string;
  issueNumber: number;
  issue: { number: number; title: string; body: string };
  remote: string;
  baseSha: Sha;
}

export interface ReproduceResult {
  runId: RunId;
  status: RunState['status'];
  detail: string;
  outcome?: HarnessRunOutcome;
}

/** The issue is already being worked on by another run on this machine. */
export class IssueBusyError extends Error {
  constructor(issueNumber: number, holder: RunId) {
    super(`issue #${issueNumber} is already held by run ${holder}`);
    this.name = 'IssueBusyError';
  }
}

export class ReproduceRunner {
  readonly #deps: ReproduceRunnerDeps;

  constructor(deps: ReproduceRunnerDeps) {
    this.#deps = deps;
  }

  async run(request: ReproduceRequest): Promise<ReproduceResult> {
    const { store, logger } = this.#deps;

    // Before anything else. A previous run killed outright cannot have cleaned up
    // after itself, and its process group may still be burning CPU and holding
    // deleted inodes.
    const reaped = reapOrphans(store);
    if (reaped.length > 0) {
      logger.warn({ reaped }, 'reaped orphaned process groups from earlier runs');
    }

    const runId = newRunId();
    const now = Date.now();

    const run: RunState = {
      id: runId,
      repo: request.repo,
      issueNumber: request.issueNumber,
      task: 'reproduce',
      status: 'queued',
      baseSha: request.baseSha,
      harness: this.#deps.harness.name,
      createdAt: now,
      updatedAt: now,
    };

    // The row exists before the lock, so a lock held by a run nobody recorded is
    // impossible — that would be unrecoverable, since nothing would name the holder.
    store.createRun(run);

    if (!store.tryAcquireLock({
      repo: request.repo,
      issueNumber: request.issueNumber,
      runId,
      acquiredAt: now,
    })) {
      const holder = store.getLock({ repo: request.repo, issueNumber: request.issueNumber });
      store.updateRun(runId, { status: 'blocked', detail: 'another run holds this issue' });
      throw new IssueBusyError(request.issueNumber, holder?.runId ?? ('unknown' as RunId));
    }

    let workspace: Workspace | undefined;
    try {
      return await this.#attempt(runId, request, (created) => { workspace = created; });
    } finally {
      // Always, even on an exception: a crashed run must not leave an issue stuck
      // forever. The workspace outlives the lock deliberately — its contents are the
      // evidence, and retention removes them later.
      store.releaseLock({ repo: request.repo, issueNumber: request.issueNumber });
      if (workspace !== undefined) {
        logger.debug({ path: workspace.path }, 'workspace retained for evidence');
      }
    }
  }

  async #attempt(
    runId: RunId,
    request: ReproduceRequest,
    onWorkspace: (workspace: Workspace) => void,
  ): Promise<ReproduceResult> {
    const { store, workspaces, harness, config, logger, root } = this.#deps;

    store.updateRun(runId, { status: 'running' });

    const workspace = await workspaces.create({
      repo: request.repo,
      issueNumber: request.issueNumber,
      task: 'reproduce',
      remote: request.remote,
      baseSha: request.baseSha,
    });
    onWorkspace(workspace);
    store.updateRun(runId, { workdir: workspace.path });

    const card = buildReproduceCard({
      issue: request.issue,
      repo: request.repo,
      baseSha: request.baseSha,
      config,
    });

    // Written here rather than in the adapter: every harness needs the card on disk
    // before it starts, and a precondition each adapter must remember is one the
    // second adapter will eventually forget.
    const taskCardPath = 'task-card.json';
    writeFileSync(join(workspace.path, taskCardPath), JSON.stringify(card, null, 2));

    const events = new JsonlWriter(join(runPath(root, runId), 'events.jsonl'));
    const attempt = nextAttempt(store, runId);
    store.startAttempt({
      runId,
      attempt,
      harness: harness.name,
      startedAt: Date.now(),
    });

    const run = harness.run({
      cwd: workspace.path,
      taskCard: card,
      taskCardPath,
      resultSchema: REPRODUCE_RESULT_SCHEMA,
      sessionId: randomUUID(),
    });

    // Immediately, before awaiting anything. A supervisor killed mid-run cannot write
    // this afterwards, and without it the process group is unreapable.
    //
    // The identity comes from the supervisor rather than being rebuilt here: an empty
    // or wrong `ownerStart` would silently disable the PID-reuse guard, and the
    // reaper could then kill an unrelated process that inherited the pid.
    store.updateRun(runId, { ownership: run.ownership });

    try {
      // Streamed while the run is live, so a run killed mid-flight still shows how
      // far it got. The transcript is often the only account of what happened.
      for await (const event of run.events()) {
        events.write(event);
      }
      events.flush();

      const outcome = await run.outcome();

      // Audit before interpreting anything the harness produced. A run that wrote
      // outside its permitted paths has misbehaved, and its output must not be read
      // as a finding about the bug — that would report a policy failure as a verdict.
      const audit = auditWorkspace(workspace.path, {
        // The task card is IssueForge's own file, written into the workspace so the
        // harness can read it. Auditing our own artefact against the harness's
        // boundary would fail every run for something the harness never did.
        allowedPaths: [...card.constraints.allowedPaths, taskCardPath],
        forbiddenPaths: card.constraints.forbiddenPaths,
      });

      if (audit.violations.length > 0) {
        const violation = new WriteBoundaryError(audit.violations);
        logger.warn({ runId, violations: audit.violations }, 'run violated its write boundary');
        return this.#finish(
          runId,
          attempt,
          classifyFailure({ kind: 'contract', message: violation.message }),
          undefined,
        );
      }

      return this.#finish(runId, attempt, classifyAttempt(outcome), outcome);
    } catch (error) {
      events.flush();
      return this.#finish(runId, attempt, classifyFailure(toFailure(error)), undefined);
    } finally {
      events.close();
      // The group is gone, so the row must stop advertising it — otherwise the next
      // invocation's reaper would reconsider a pgid that may have been recycled.
      store.updateRun(runId, { ownership: null });
      logger.debug({ runId }, 'reproduce attempt finished');
    }
  }

  #finish(
    runId: RunId,
    attempt: number,
    classification: ReturnType<typeof classifyAttempt>,
    outcome: HarnessRunOutcome | undefined,
  ): ReproduceResult {
    const { store } = this.#deps;

    store.finishAttempt(runId, {
      outcome: toTaskOutcome(classification.status),
      endedAt: Date.now(),
      ...(outcome?.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome?.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    });

    store.updateRun(runId, { status: classification.status, detail: classification.detail });

    return {
      runId,
      status: classification.status,
      detail: classification.detail,
      ...(outcome !== undefined ? { outcome } : {}),
    };
  }
}

/**
 * What the harness must return.
 *
 * Only a claim. Whether it holds is settled by replaying the evidence (IF-010), so
 * nothing here is treated as a verdict.
 */
const REPRODUCE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['reproduced', 'cannot-reproduce', 'needs-info'] },
    reproCommand: {
      type: 'array',
      items: { type: 'string' },
      description: 'Command as an argv array, e.g. ["npm","test"] — not a shell string.',
    },
    testFile: { type: 'string', description: 'Repo-relative path to the failing test.' },
    setupCommand: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What must run first in a CLEAN checkout for reproCommand to work — an install, ' +
        'a build, whatever this repository needs. Argv array, e.g. ["pnpm","install"]. ' +
        'Omit only if reproCommand works with nothing installed.',
    },
    expectedSignal: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'summary'],
} as const;

function newRunId(): RunId {
  return `run_${randomUUID().replace(/-/g, '').slice(0, 10)}` as RunId;
}

function nextAttempt(store: RunStore, runId: RunId): number {
  return store.listAttempts(runId).length + 1;
}

function toTaskOutcome(status: RunState['status']): 'completed' | 'timeout' | 'cancelled' | 'error' {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'error';
  return 'completed';
}

function toFailure(error: unknown): AttemptFailure {
  if (error instanceof HarnessContractError) {
    return { kind: 'contract', message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out/i.test(message)) return { kind: 'timeout', message };
  if (/cancel/i.test(message)) return { kind: 'cancelled', message };
  return { kind: 'crash', message };
}
