import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HarnessCapabilities,
  HarnessEvent,
  HarnessRunOutcome,
  IssueForgeConfig,
  ProcessOwnership,
  Sha,
  TaskCard,
} from '@issueforge/contracts';
import { IssueForgeConfig as ConfigSchema, repoSlug, runId, sha } from '@issueforge/contracts';
import {
  HarnessContractError,
  HarnessRunError,
  type HarnessAdapter,
  type HarnessRun,
} from '@issueforge/core';
import { SqliteRunStore } from '../state/index.js';
import { GitWorkspaceManager } from '../workspace/index.js';
import { createLogger } from '../logger/index.js';
import { TaskRunner, IssueBusyError, FIX } from './task-runner.js';

let dir: string;
let origin: string;
let root: string;
let baseSha: Sha;
let store: SqliteRunStore;

const REPO = repoSlug();
const config: IssueForgeConfig = ConfigSchema.parse({});
const logger = createLogger({ level: 'fatal' });

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A harness under the test's control, so every branch can be exercised cheaply. */
class FakeHarness implements HarnessAdapter {
  readonly name = 'claude-code' as const;
  events: HarnessEvent[] = [];
  outcome: HarnessRunOutcome | undefined;
  failure: Error | undefined;
  observedCwd: string | undefined;
  observedEnvAllow: readonly string[] | undefined;
  observedCard: TaskCard | undefined;
  /** Lets a test act on the ledger mid-run, e.g. to simulate a concurrent cancel. */
  onRun: (() => void) | undefined;

  async detect(): Promise<HarnessCapabilities> {
    return { installed: true, version: 'fake', authenticated: true };
  }

  run(request: { cwd: string; envAllow?: readonly string[]; taskCard: TaskCard }): HarnessRun {
    this.observedCwd = request.cwd;
    this.observedEnvAllow = request.envAllow;
    this.observedCard = request.taskCard;
    this.onRun?.();
    const events = this.events;
    const outcome = this.outcome;
    const failure = this.failure;
    const ownership: ProcessOwnership = {
      pgid: 424242,
      ownerPid: process.pid,
      ownerStart: 'Mon Aug 25 10:00:00 2026',
      startedAt: Date.now(),
    };

    return {
      pgid: ownership.pgid,
      ownership,
      async *events() {
        for (const event of events) yield event;
      },
      async outcome(): Promise<HarnessRunOutcome> {
        if (failure !== undefined) throw failure;
        return outcome ?? { harness: 'claude-code', ok: false, denials: 0, injectionSuspected: false };
      },
      cancel() {},
    };
  }
}

let harness: FakeHarness;
let runner: TaskRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-run-'));
  origin = join(dir, 'origin');
  root = join(dir, 'home');

  execFileSync('git', ['init', '-q', origin]);
  git(['config', 'user.email', 't@e.com'], origin);
  git(['config', 'user.name', 't'], origin);
  writeFileSync(join(origin, 'a.txt'), 'v1\n');
  git(['add', '-A'], origin);
  git(['commit', '-qm', 'base'], origin);
  baseSha = sha(git(['rev-parse', 'HEAD'], origin));

  store = new SqliteRunStore(join(root, 'state.db'));
  store.migrate();
  harness = new FakeHarness();
  runner = new TaskRunner(deps());
});

/** The same dependency bundle the default runner uses, for tests that need a second. */
function deps() {
  return { store, workspaces: new GitWorkspaceManager(root), harness, config, logger, root };
}

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const request = () => ({
  repo: REPO,
  issueNumber: 7,
  issue: { number: 7, title: 'it breaks', body: 'when I do X' },
  remote: origin,
  baseSha,
});

const claimed = (verdict: string): HarnessRunOutcome => ({
  harness: 'claude-code',
  ok: true,
  denials: 0,
  injectionSuspected: false,
  exitCode: 0,
  result: { verdict, summary: 's', reproCommand: ['npm', 'test'], testFile: 't.js' },
} as HarnessRunOutcome);

describe('TaskRunner', { timeout: 30_000 }, () => {
  it('runs a full attempt and records it', async () => {
    harness.events = [
      { type: 'session_started', sessionId: 's1', tools: [], mcpServers: [] },
      { type: 'text', text: 'looking' },
    ];
    harness.outcome = claimed('reproduced');

    const result = await runner.run(request());

    // A completed run reaches a terminal state. It read 'running' until the
    // validator it deferred to was removed, which left every successful run
    // looking unfinished and exiting non-zero.
    expect(result.status).toBe('reproduced');
    expect(result.outcome?.result?.verdict).toBe('reproduced');

    const run = store.getRun(result.runId);
    expect(run?.task).toBe('reproduce');
    expect(run?.baseSha).toBe(baseSha);
    expect(run?.workdir).toContain(join('issue-7', 'reproduce'));
  });

  it('gives the harness a workspace pinned to the base SHA', async () => {
    harness.outcome = claimed('reproduced');
    await runner.run(request());

    const cwd = harness.observedCwd;
    if (cwd === undefined) throw new Error('the harness was never given a workspace');

    expect(git(['rev-parse', 'HEAD'], cwd)).toBe(baseSha);
    // The task card is a file, so the issue body never becomes argv.
    const card = JSON.parse(readFileSync(join(cwd, 'task-card.json'), 'utf8')) as {
      issue: { body: string };
      instructions: string;
    };
    expect(card.issue.body).toBe('when I do X');
    expect(card.instructions).toMatch(/UNTRUSTED/);
  });

  it('streams the transcript to disk while the run is live', async () => {
    // A run killed mid-flight must still show how far it got.
    harness.events = [
      { type: 'session_started', sessionId: 's1', tools: [], mcpServers: [] },
      { type: 'tool_started', toolId: 't1', name: 'Bash' },
    ];
    harness.outcome = claimed('reproduced');

    const result = await runner.run(request());
    const transcript = join(root, 'runs', result.runId, 'events.jsonl');

    expect(existsSync(transcript)).toBe(true);
    const lines = readFileSync(transcript, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ type: 'session_started' });
  });

  it('records one attempt row, closed with its cost', async () => {
    harness.outcome = claimed('reproduced');
    const result = await runner.run(request());

    const attempts = store.listAttempts(result.runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attempt).toBe(1);
    expect(attempts[0]?.outcome).toBe('completed');
    expect(attempts[0]?.endedAt).toBeGreaterThan(0);
  });

  it('persists ownership during the run and clears it afterwards', async () => {
    // Recorded before awaiting so an orphan stays reapable; cleared after so the
    // reaper does not reconsider a pgid that may have been recycled.
    harness.outcome = claimed('reproduced');
    const result = await runner.run(request());

    expect(store.getRun(result.runId)?.ownership).toBeUndefined();
    expect(store.listReapCandidates()).toHaveLength(0);
  });

  it('releases the issue lock when the run finishes', async () => {
    harness.outcome = claimed('reproduced');
    await runner.run(request());
    expect(store.getLock({ repo: REPO, issueNumber: 7 })).toBeNull();
  });

  it('releases the lock even when the harness throws', async () => {
    // A crashed run must never leave an issue permanently stuck.
    harness.failure = new Error('harness exploded');
    const result = await runner.run(request());

    expect(result.status).toBe('needs-info');
    expect(store.getLock({ repo: REPO, issueNumber: 7 })).toBeNull();
  });

  it('refuses to start when another run holds the issue', async () => {
    store.createRun({
      id: runId('holder01'),
      repo: REPO,
      issueNumber: 7,
      task: 'reproduce',
      status: 'running',
      baseSha,
      createdAt: 1,
      updatedAt: 1,
    });
    store.tryAcquireLock({ repo: REPO, issueNumber: 7, runId: runId('holder01'), acquiredAt: 1 });

    await expect(runner.run(request())).rejects.toThrow(IssueBusyError);
    // The pre-existing holder keeps the lock.
    expect(store.getLock({ repo: REPO, issueNumber: 7 })?.runId).toBe(runId('holder01'));
  });

  it('treats a contract breach as blocked, not as a finding about the bug', async () => {
    // The sandbox was wrong, so nothing the harness produced may be interpreted.
    // Reporting that as `cannot-reproduce` would tell a maintainer something false.
    harness.failure = new HarnessContractError('harness started with MCP servers enabled');
    const result = await runner.run(request());

    expect(result.status).toBe('blocked');
    expect(result.detail).toMatch(/MCP servers/);
    expect(store.listAttempts(result.runId)[0]?.outcome).toBe('error');
  });

  it('passes the configured environment allowlist to the harness', async () => {
    // `env.allow` used to be inert: the only function that read it had no callers, so
    // a repository could configure the list and the spawn silently ignored it.
    await runner.run(request());

    expect(harness.observedEnvAllow).toEqual(config.env.allow);
  });

  it('hands the fix task what the reproduce run found', async () => {
    // Without this the two runs read as unrelated investigations: the fix re-derives
    // the cause from scratch and can reach a different conclusion about the same bug.
    store.createRun({
      id: runId('earlier1'), repo: repoSlug(), issueNumber: 7, task: 'reproduce',
      status: 'reproduced', baseSha: sha(), harness: 'claude-code',
      detail: 'the defect is exactly "no = present"', createdAt: 1, updatedAt: 1,
    });

    const fixRunner = new TaskRunner(deps(), FIX);
    await fixRunner.run({ ...request(), issueNumber: 7 });

    expect(harness.observedCard?.priorArtifacts[0]).toContain('no = present');
    expect(harness.observedCard?.priorArtifacts[0]).toContain('reproduced');
  });

  it('runs a fix with no prior findings — labelling `fix` directly is allowed', async () => {
    // Requiring a prior reproduce would put IssueForge back to adjudicating a decision
    // the maintainer already made by applying the label.
    const fixRunner = new TaskRunner(deps(), FIX);
    const result = await fixRunner.run({ ...request(), issueNumber: 99 });

    expect(harness.observedCard?.priorArtifacts).toEqual([]);
    expect(result.status).not.toBe('blocked');
  });

  it('prefers the most recent prior run when there are several', async () => {
    for (const [n, detail] of [['old12345', 'stale finding'], ['new12345', 'current finding']] as const) {
      store.createRun({
        id: runId(n), repo: repoSlug(), issueNumber: 8, task: 'reproduce',
        status: 'reproduced', baseSha: sha(), harness: 'claude-code',
        detail, createdAt: n.startsWith('old') ? 1 : 2, updatedAt: 1,
      });
    }

    await new TaskRunner(deps(), FIX).run({ ...request(), issueNumber: 8 });

    expect(harness.observedCard?.priorArtifacts[0]).toContain('current finding');
  });

  it('does not overwrite a cancellation with the death it caused', async () => {
    // Cancelling kills the process group, so the run then fails with a signal — and the
    // runner would classify that as `needs-info`, replacing "cancelled by request" with
    // something that reads as a failure the maintainer did not cause. Observed live: the
    // ledger said `cancelled` while the workflow log said exit 143, and only the order
    // of two writes decided which survived.
    harness.failure = new HarnessRunError('crashed', 'Command failed with exit code 143');
    harness.onRun = () => {
      // The run whose issue is being cancelled. Ownership is persisted just after the
      // harness starts, so a cancel arriving this early sees the row but not the pgid —
      // which is exactly the window that matters.
      for (const run of store.listRuns({ issueNumber: 7, status: 'running' })) {
        store.updateRun(run.id, { status: 'cancelled', detail: 'cancelled by request' });
      }
    };

    const result = await runner.run({ ...request(), issueNumber: 7 });

    expect(result.status).toBe('cancelled');
    expect(store.getRun(result.runId)?.status).toBe('cancelled');
  });

  it('records a TIMEOUT as a timeout, not as a completed attempt', async () => {
    // The `tasks` table exists so a retry adds history rather than overwriting why the
    // previous attempt failed — and exhausting the time budget is the most common way
    // an agent run fails. It was being recorded as `completed`: the status mapper had
    // no branch that could ever produce 'timeout', so the ledger said the run finished
    // normally.
    harness.failure = new HarnessRunError('timeout', 'exceeded its 900000ms budget');
    const result = await runner.run(request());

    expect(result.status).toBe('needs-info');
    expect(store.listAttempts(result.runId)[0]?.outcome).toBe('timeout');
  });

  it('records a CANCELLED run as cancelled', async () => {
    harness.failure = new HarnessRunError('cancelled', 'run cancelled');
    const result = await runner.run(request());

    expect(result.status).toBe('cancelled');
    expect(store.listAttempts(result.runId)[0]?.outcome).toBe('cancelled');
  });

  it('does not classify a crash as cancelled just because it says "cancel"', async () => {
    // Classification used to regex-match the error message, so any harness error
    // mentioning the word — a git error about a cancelled upstream, or the agent's own
    // prose — became `cancelled`: a TERMINAL status that stops retry.
    harness.failure = new Error('upstream build was cancelled by the provider');
    const result = await runner.run(request());

    expect(result.status).toBe('needs-info');
    expect(store.listAttempts(result.runId)[0]?.outcome).toBe('error');
  });

  it('records needs-info when the harness returns no structured claim', async () => {
    harness.outcome = { harness: 'claude-code', ok: true, denials: 0, injectionSuspected: false };
    const result = await runner.run(request());

    expect(result.status).toBe('needs-info');
    expect(result.detail).toMatch(/no structured result/);
  });

  it('records needs-info when the harness did not complete', async () => {
    harness.outcome = { harness: 'claude-code', ok: false, denials: 0, injectionSuspected: false };
    const result = await runner.run(request());
    expect(result.status).toBe('needs-info');
  });

  it('numbers a second attempt without erasing the first', async () => {
    harness.outcome = claimed('reproduced');
    const first = await runner.run(request());
    const second = await runner.run(request());

    expect(first.runId).not.toBe(second.runId);
    expect(store.listAttempts(first.runId)).toHaveLength(1);
    expect(store.listAttempts(second.runId)).toHaveLength(1);
    // Both runs remain readable; retry history is not overwritten.
    expect(store.listRuns({ repo: REPO, issueNumber: 7 })).toHaveLength(2);
  });

  it('reaps an orphan left by an earlier run before starting', async () => {
    store.createRun({
      id: runId('orphan01'),
      repo: REPO,
      issueNumber: 99,
      task: 'reproduce',
      status: 'running',
      baseSha,
      createdAt: 1,
      updatedAt: 1,
      ownership: {
        pgid: 0x7ffffff, // no such group; the row must simply be cleared
        ownerPid: process.pid,
        ownerStart: 'Mon Jan  1 00:00:00 2001',
        startedAt: 1,
      },
    });
    expect(store.listReapCandidates()).toHaveLength(1);

    harness.outcome = claimed('reproduced');
    await runner.run(request());

    expect(store.listReapCandidates()).toHaveLength(0);
  });
});
