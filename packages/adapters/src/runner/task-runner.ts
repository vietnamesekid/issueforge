import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  IssueForgeConfig} from '@issueforge/contracts';
import {
  optionalDefined,
  RunId as RunIdSchema,
  type HarnessRunOutcome,
  type RepoSlug,
  type RunId,
  type RunPhase,
  type RunPhaseEvent,
  type RunState,
  type TaskCard,
  type TaskKind,
  type Sha,
} from '@issueforge/contracts';
import {
  buildFixCard,
  buildReproduceCard,
  classifyAttempt,
  classifyFailure,
  HarnessContractError,
  HarnessRunError,
  type AttemptFailure,
  type HarnessAdapter,
  type RunStore,
  type TaskCardInput,
  type Workspace,
  type WorkspaceManager,
} from '@issueforge/core';
import { JsonlWriter, type Logger } from '../logger/index.js';
import { reapOrphans } from '../process/index.js';
import { auditWorkspace, WriteBoundaryError } from '../policy/index.js';
import { runPath } from '../workspace/index.js';

/**
 * Runs one task attempt end to end.
 *
 * The ordering here is the whole point, and it is not arbitrary: cancellation gives
 * the process about seven and a half seconds before its tree is killed, so every
 * state transition is written BEFORE the side effect it describes. A kill at any
 * instant then leaves a row that can be reconciled, rather than a side effect nobody
 * recorded.
 */

/**
 * What makes an attempt a *reproduce* rather than a *fix*.
 *
 * Everything else in this file is task-neutral: the lock, the workspace, the
 * transcript, the ownership record, the audit, and above all the ORDER those happen
 * in. Injecting the three task-specific values is what stops a second task copying
 * 300 lines of crash-safety ordering and letting one copy rot.
 */
export interface TaskDefinition {
  kind: TaskKind;
  /**
   * Turns this task needs, when the default is not enough.
   *
   * A fix does strictly more than a reproduce — read, change, write a test, run it
   * before and after, commit, push, open a PR — and a live run proved the point: the
   * agent finished the fix (`pass 2, fail 0`) and was cut off by `error_max_turns`
   * before it could open the PR. The work was done and thrown away.
   *
   * A repository's own config still overrides this.
   */
  maxTurns?: number;
  /** Builds the brief the harness receives. */
  buildCard(input: TaskCardInput): TaskCard;
  /** JSON Schema for the structured summary the harness returns for the ledger. */
  resultSchema: unknown;
}

export interface TaskRunnerDeps {
  store: RunStore;
  workspaces: WorkspaceManager;
  harness: HarnessAdapter;
  config: IssueForgeConfig;
  logger: Logger;
  /** Root for run artifacts. Injected so tests need no home directory. */
  root: string;
  /**
   * Called as each stage begins, so a caller can show progress.
   *
   * Purely an observer: it reports transitions this runner already makes and MUST NOT
   * influence them. A run takes minutes, and without this the CLI can say nothing
   * until it ends.
   *
   * Deliberately synchronous and deliberately unawaited — see `#phase`.
   */
  onPhase?: (event: RunPhaseEvent) => void;
}

export interface TaskRequest {
  repo: RepoSlug;
  issueNumber: number;
  issue: { number: number; title: string; body: string };
  remote: string;
  baseSha: Sha;
  /**
   * Lets the harness report its own findings to the issue.
   *
   * Passed through rather than used here: IssueForge sets the run up, the harness
   * says what it found, and a human reviews it.
   */
  githubToken?: string;
}

export interface TaskResult {
  runId: RunId;
  status: RunState['status'];
  detail: string;
  outcome?: HarnessRunOutcome;
}

/** The issue is already being worked on by another run on this machine. */
export class IssueBusyError extends Error {
  readonly issueNumber: number;
  /** The run holding the lock, when the row could still be read. */
  readonly holder: RunId | undefined;

  constructor(issueNumber: number, holder: RunId | undefined) {
    super(
      holder === undefined
        ? `issue #${issueNumber} is already held by another run`
        : `issue #${issueNumber} is already held by run ${holder}`,
    );
    this.name = 'IssueBusyError';
    this.issueNumber = issueNumber;
    this.holder = holder;
  }
}

export class TaskRunner {
  readonly #deps: TaskRunnerDeps;
  readonly #task: TaskDefinition;

  constructor(deps: TaskRunnerDeps, task: TaskDefinition = REPRODUCE) {
    this.#task = task;
    this.#deps = deps;
  }

  /**
   * Report a stage beginning.
   *
   * Wrapped in a catch that swallows: this is a progress display, and a renderer that
   * throws — a closed pipe, a terminal that went away — must never take down a run
   * that is mid-flight and holding an issue lock. Failure here IS the answer, which is
   * why the empty catch is allowed under the repo's rule for silent catches.
   */
  #phase(phase: RunPhase, detail?: string): void {
    const { onPhase } = this.#deps;
    if (onPhase === undefined) return;
    try {
      onPhase({ phase, at: Date.now(), ...optionalDefined('detail', detail) });
    } catch {
      // See above: a broken display must not break the run.
    }
  }

  async run(request: TaskRequest): Promise<TaskResult> {
    const { store, logger } = this.#deps;

    // Before anything else. A previous run killed outright cannot have cleaned up
    // after itself, and its process group may still be burning CPU and holding
    // deleted inodes.
    this.#phase('reaping');
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
      task: this.#task.kind,
      status: 'queued',
      baseSha: request.baseSha,
      harness: this.#deps.harness.name,
      createdAt: now,
      updatedAt: now,
    };

    // The row exists before the lock, so a lock held by a run nobody recorded is
    // impossible — that would be unrecoverable, since nothing would name the holder.
    store.createRun(run);

    this.#phase('locking', `issue #${request.issueNumber}`);
    if (!store.tryAcquireLock({
      repo: request.repo,
      issueNumber: request.issueNumber,
      runId,
      acquiredAt: now,
    })) {
      const holder = store.getLock({ repo: request.repo, issueNumber: request.issueNumber });
      store.updateRun(runId, { status: 'blocked', detail: 'another run holds this issue' });
      throw new IssueBusyError(request.issueNumber, holder?.runId);
    }

    let workspace: Workspace | undefined;
    try {
      return await this.#attempt(runId, request, (created) => { workspace = created; });
    } finally {
      // Always, even on an exception: a crashed run must not leave an issue stuck
      // forever. The workspace outlives the lock deliberately — its contents are the
      // evidence, and retention removes them later.
      store.releaseLock({ repo: request.repo, issueNumber: request.issueNumber });
      if (workspace) {
        logger.debug({ path: workspace.path }, 'workspace retained for evidence');
      }
    }
  }

  async #attempt(
    runId: RunId,
    request: TaskRequest,
    onWorkspace: (workspace: Workspace) => void,
  ): Promise<TaskResult> {
    const { store, workspaces, harness, config, logger, root } = this.#deps;

    store.updateRun(runId, { status: 'running' });

    this.#phase('cloning', `${request.repo} at ${request.baseSha.slice(0, 7)}`);
    const workspace = await workspaces.create({
      repo: request.repo,
      issueNumber: request.issueNumber,
      task: this.#task.kind,
      remote: request.remote,
      baseSha: request.baseSha,
    });
    onWorkspace(workspace);
    store.updateRun(runId, { workdir: workspace.path });

    this.#phase('preparing', 'building task card');
    const card = this.#task.buildCard({
      ...optionalDefined('maxTurns', this.#task.maxTurns),
      priorArtifacts: findPriorFindings(store, request),
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

    this.#phase('spawning', harness.name);
    const run = harness.run({
      cwd: workspace.path,
      taskCard: card,
      taskCardPath,
      resultSchema: this.#task.resultSchema,
      sessionId: randomUUID(),
      envAllow: config.env.allow,
      ...optionalDefined('githubToken', request.githubToken),
    });

    // Immediately, before awaiting anything. A supervisor killed mid-run cannot write
    // this afterwards, and without it the process group is unreapable.
    //
    // The identity comes from the supervisor rather than being rebuilt here: an empty
    // or wrong `ownerStart` would silently disable the PID-reuse guard, and the
    // reaper could then kill an unrelated process that inherited the pid.
    store.updateRun(runId, { ownership: run.ownership });

    // Only after ownership is recorded. Emitting before would put a display update
    // ahead of the write that makes the process group reapable, and a kill in that
    // window leaves an orphan nobody owns.
    this.#phase('working', `${this.#task.kind} on issue #${request.issueNumber}`);

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
      this.#phase('auditing', 'checking write boundary');
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

      this.#phase('finishing');
      return this.#finish(runId, attempt, classifyAttempt(outcome), outcome);
    } catch (error) {
      events.flush();

      // A cancel that landed while this run was dying already recorded the truth, and
      // it is more specific than "the process died". Overwriting it would replace
      // "cancelled by request" with "needs-info", which reads as a failure the
      // maintainer did not cause. Observed live: the ledger said `cancelled` while the
      // workflow log said exit 143.
      if (store.getRun(runId)?.status === 'cancelled') {
        return { runId, status: 'cancelled', detail: 'cancelled by request' };
      }

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
  ): TaskResult {
    const { store } = this.#deps;

    store.finishAttempt(runId, {
      // Taken from the classification, which knows why the attempt ended. Deriving it
      // from `status` here meant `timeout` was unreachable and every timed-out attempt
      // was filed as `completed`.
      outcome: classification.outcome,
      endedAt: Date.now(),
      ...optionalDefined('exitCode', outcome?.exitCode),
    });

    store.updateRun(runId, { status: classification.status, detail: classification.detail });

    return {
      runId,
      status: classification.status,
      detail: classification.detail,
      ...optionalDefined('outcome', outcome),
    };
  }
}

/**
 * What the harness returns.
 *
 * A summary for the ledger, so `issueforge status` can say what happened without
 * reading a transcript. The harness reports its actual findings to the issue itself,
 * where a human reads them — this is bookkeeping, not adjudication.
 */
const REPRODUCE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    // Derived, not hand-copied: a verdict the harness is told to produce but the
    // contract then rejects surfaces as "returned no structured result", silently.
    verdict: { type: 'string', enum: ['reproduced', 'cannot-reproduce', 'needs-info'] as const },
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
        'What a maintainer must run first for reproCommand to work in a clean checkout.',
    },
    expectedSignal: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'summary'],
} as const;

function newRunId(): RunId {
  // Parsed rather than asserted: this is the one place run ids are minted, so it is
  // where the format is guaranteed rather than merely intended.
  return RunIdSchema.parse(`run_${randomUUID().replace(/-/g, '').slice(0, 10)}`);
}

function nextAttempt(store: RunStore, runId: RunId): number {
  return store.listAttempts(runId).length + 1;
}

/**
 * Turn a thrown error into a classified failure.
 *
 * Structured first: the supervisor already determined whether the run timed out or was
 * cancelled, and `HarnessRunError` carries that as a value. This used to regex-match
 * the message instead — so any harness error mentioning "cancel" became `cancelled`, a
 * terminal status that stops retry, and a reworded upstream timeout string would have
 * silently become a crash.
 */
function toFailure(error: unknown): AttemptFailure {
  if (error instanceof HarnessContractError) {
    return { kind: 'contract', message: error.message };
  }

  if (error instanceof HarnessRunError) {
    switch (error.reason) {
      case 'timeout':
        return { kind: 'timeout', message: error.message };
      case 'cancelled':
        return { kind: 'cancelled', message: error.message };
      case 'crashed':
        return { kind: 'crash', message: error.message };
    }
  }

  return { kind: 'crash', message: error instanceof Error ? error.message : String(error) };
}

/**
 * The reproduce task.
 *
 * The default, and for now the only one — `fix` and `verify` are v0.2. It is a value
 * rather than a hardcoded branch so adding the second task is writing another one of
 * these, not editing the runner.
 */
export const REPRODUCE: TaskDefinition = {
  kind: 'reproduce',
  buildCard: buildReproduceCard,
  resultSchema: REPRODUCE_RESULT_SCHEMA,
};

/**
 * What the harness returns from a fix.
 *
 * Like the reproduce schema, a summary for the ledger — the real account goes in the
 * pull request and the issue comment, where a reviewer reads it.
 */
const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['fixed', 'could-not-fix', 'needs-info'] as const },
    branch: { type: 'string', description: 'Branch the fix was committed on.' },
    pullRequestUrl: { type: 'string', description: 'URL of the draft PR, if one was opened.' },
    testCommand: {
      type: 'array',
      items: { type: 'string' },
      description: 'Command as an argv array that fails before the fix and passes after.',
    },
    testFile: { type: 'string', description: 'Repo-relative path to the test covering the fix.' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'summary'],
} as const;

/**
 * The fix task.
 *
 * Ends at a DRAFT pull request: the agent does the work and opens it, a human reviews
 * and merges. There is deliberately no verify stage and no gate requiring a prior
 * reproduce — both would put IssueForge back to adjudicating a decision the maintainer
 * already made by applying the label.
 */
export const FIX: TaskDefinition = {
  kind: 'fix',
  // Measured: 30 was not enough. See TaskDefinition.maxTurns.
  maxTurns: 60,
  buildCard: buildFixCard,
  resultSchema: FIX_RESULT_SCHEMA,
};

/**
 * What an earlier task on this issue already established.
 *
 * A fix that re-derives the cause from scratch wastes the reproduce run and can reach a
 * different conclusion about the same bug. Vercel's agent does the same thing in the
 * other direction — its fix PR opens with "The reproduction confirmed that..." — and
 * that continuity is what makes the two runs read as one investigation.
 *
 * Deliberately not a gate. An empty list is normal: a maintainer may label an issue
 * `fix` directly, and refusing to run without a prior reproduce would put IssueForge
 * back to adjudicating a decision the maintainer already made.
 */
function findPriorFindings(store: RunStore, request: TaskRequest): string[] {
  const priors = store
    .listRuns({ repo: request.repo, issueNumber: request.issueNumber, limit: 20 })
    .filter((run) => run.task !== 'fix' && run.detail !== undefined && run.detail.length > 0);
  // `listRuns` already returns newest first (ORDER BY created_at DESC), and a later run
  // supersedes an earlier one on the same issue.

  const latest = priors[0];
  if (latest === undefined) return [];

  return [`${latest.task} run ${latest.id} (${latest.status}): ${latest.detail ?? ''}`];
}
