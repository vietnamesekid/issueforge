import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '@issueforge/contracts';
import { repoSlug, runId, sha } from '@issueforge/contracts';
import { spawn } from 'node:child_process';
import { SqliteRunStore } from './sqlite-run-store.js';

/**
 * Entry point for the cross-process test below. Child processes cannot import
 * TypeScript, so it runs against the built output — `pnpm test` builds first.
 *
 * It skips rather than fails when `dist/` is absent (someone running `vitest` alone),
 * but announces itself, because this is the only test that exercises two real
 * processes and a silent skip would hide the loss of that coverage.
 */
const distEntry = new URL('../../dist/index.js', import.meta.url).pathname;
const hasBuild = existsSync(distEntry);
if (!hasBuild) {
  console.warn('[sqlite-run-store] dist/ missing — skipping the cross-process race test. Run `pnpm build` first.');
}
import { SCHEMA_VERSION } from './migrations.js';

const SHA = sha();

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: runId(),
    repo: repoSlug(),
    issueNumber: 7,
    task: 'reproduce',
    status: 'queued',
    baseSha: SHA,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

let dir: string;
let dbPath: string;
let store: SqliteRunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-db-'));
  dbPath = join(dir, 'nested', 'state.db');
  store = new SqliteRunStore(dbPath);
  store.migrate();
});

afterEach(() => {
  try { store.close(); } catch { /* already closed by a test */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('are idempotent — safe to run on every process start', () => {
    store.migrate();
    store.migrate();
    store.createRun(makeRun());
    expect(store.getRun(runId('a1b2c3'))).not.toBeNull();
  });

  it('bring a fresh database to the current schema version', () => {
    const second = new SqliteRunStore(join(dir, 'other.db'));
    second.migrate();
    second.createRun(makeRun({ id: runId('zzz999') }));
    expect(second.getRun(runId('zzz999'))?.repo).toBe(repoSlug());
    second.close();
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('creates the parent directory rather than failing on a fresh machine', () => {
    // dbPath is under a directory that did not exist; construction must handle it.
    // A well-formed id for a run that was never created — the store returns null for
    // absence, and a malformed id could never reach it now that RunId is branded.
    expect(store.getRun(runId('nosuch'))).toBeNull();
  });
});

describe('run lifecycle', () => {
  it('round-trips a run', () => {
    const run = makeRun();
    store.createRun(run);
    expect(store.getRun(run.id)).toEqual(run);
  });

  it('applies partial updates without clobbering untouched fields', () => {
    store.createRun(makeRun({ workdir: '/tmp/wt' }));
    store.updateRun(runId('a1b2c3'), { status: 'running', harness: 'claude-code' });

    const run = store.getRun(runId('a1b2c3'));
    expect(run?.status).toBe('running');
    expect(run?.harness).toBe('claude-code');
    expect(run?.workdir).toBe('/tmp/wt'); // untouched
    expect(run?.updatedAt).toBeGreaterThan(1_000);
  });

  it('filters by repo, issue and status', () => {
    store.createRun(makeRun({ id: runId('aaa111'), status: 'running' }));
    store.createRun(makeRun({ id: runId('bbb222'), status: 'reproduced', issueNumber: 8 }));
    store.createRun(makeRun({ id: runId('ccc333'), status: 'cancelled', repo: repoSlug('other/repo') }));

    expect(store.listRuns({ repo: repoSlug() })).toHaveLength(2);
    expect(store.listRuns({ issueNumber: 8 })).toHaveLength(1);
    expect(store.listRuns({ status: ['running', 'reproduced'] })).toHaveLength(2);
    expect(store.listRuns({ limit: 1 })).toHaveLength(1);
  });
});

describe('durability — the database is the source of truth, not the process', () => {
  it('a run written before a hard kill is readable on restart', () => {
    // Simulates the cancellation path: transition written, then the process dies
    // with no chance to clean up. Reopening must find the recorded state.
    store.createRun(makeRun({ status: 'running' }));
    store.updateRun(runId('a1b2c3'), { status: 'interrupted', detail: 'SIGINT' });
    store.close(); // stands in for the process ceasing to exist

    const reopened = new SqliteRunStore(dbPath);
    reopened.migrate(); // every start migrates; must not disturb existing data
    const run = reopened.getRun(runId('a1b2c3'));
    expect(run?.status).toBe('interrupted');
    expect(run?.detail).toBe('SIGINT');
    reopened.close();
  });

  it.skipIf(!hasBuild)('two real PROCESSES can cold-start and migrate the same new database', async () => {
    // Guards two distinct races that only appear across real processes:
    //
    //  1. WAL conversion — converting a fresh database takes an exclusive lock, and
    //     before busy_timeout was ordered ahead of it this failed in 6 of 8 attempts
    //     with "database is locked".
    //  2. Concurrent migration — both processes read user_version = 0, both ran
    //     migration 1, and the loser failed with "table runs already exists". Fixed
    //     by re-reading the version inside the write transaction.
    //
    // The single-process test below catches neither: both its connections live in
    // one process. The children must also run CONCURRENTLY — spawnSync starts them
    // sequentially, and a sequential pair never races, so such a test passes against
    // the broken code and proves nothing.
    // Its own directory, not the shared `dir`: afterEach removes that one, and a
    // child still exiting when the removal lands would fail for that reason instead
    // of the one under test.
    const raceDir = mkdtempSync(join(tmpdir(), 'if-race-'));
    const racePath = join(raceDir, 'state.db');
    const script = `
      const { SqliteRunStore } = await import(${JSON.stringify(distEntry)});
      const s = new SqliteRunStore(${JSON.stringify(racePath)});
      s.migrate();
      s.close();
      console.log('OK');
    `;

    const run = (): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('exit', (code) => resolve({ code, stderr }));
      });

    try {
      // Four rather than two: a race is probabilistic, and with two processes the
      // migration bug reproduced in only 2 of 5 runs — too weak to defend a fix in
      // CI. Four makes the collision near-certain while staying fast.
      const results = await Promise.all([run(), run(), run(), run()]);

      for (const r of results) {
        expect(r.stderr, r.stderr).not.toMatch(/database is locked/i);
        expect(r.code, r.stderr).toBe(0);
      }
    } finally {
      rmSync(raceDir, { recursive: true, force: true });
    }
  });

  it('two connections read and write concurrently without SQLITE_BUSY', () => {
    // The CLI and the listener service both open this file.
    const other = new SqliteRunStore(dbPath);
    try {
      store.createRun(makeRun({ id: runId('aaa111') }));
      expect(other.getRun(runId('aaa111'))).not.toBeNull();

      other.createRun(makeRun({ id: runId('bbb222') }));
      store.updateRun(runId('bbb222'), { status: 'running' });

      expect(store.getRun(runId('bbb222'))?.status).toBe('running');
      expect(other.listRuns()).toHaveLength(2);
    } finally {
      other.close();
    }
  });
});

describe('issue locks', () => {
  beforeEach(() => {
    store.createRun(makeRun({ id: runId('aaa111') }));
    store.createRun(makeRun({ id: runId('bbb222') }));
  });

  it('grants the lock once and refuses a second holder for the same issue', () => {
    const first = store.tryAcquireLock({ repo: repoSlug(), issueNumber: 7, runId: runId('aaa111'), acquiredAt: 1 });
    const second = store.tryAcquireLock({ repo: repoSlug(), issueNumber: 7, runId: runId('bbb222'), acquiredAt: 2 });

    expect(first).toBe(true);
    expect(second).toBe(false); // mutual exclusion comes from the PRIMARY KEY, not a read-then-write
    expect(store.getLock({ repo: repoSlug(), issueNumber: 7 })?.runId).toBe(runId('aaa111'));
  });

  it('allows concurrent runs on different issues', () => {
    expect(store.tryAcquireLock({ repo: repoSlug(), issueNumber: 7, runId: runId('aaa111'), acquiredAt: 1 })).toBe(true);
    expect(store.tryAcquireLock({ repo: repoSlug(), issueNumber: 9, runId: runId('bbb222'), acquiredAt: 1 })).toBe(true);
  });

  it('releases so a later run can take the issue', () => {
    store.tryAcquireLock({ repo: repoSlug(), issueNumber: 7, runId: runId('aaa111'), acquiredAt: 1 });
    store.releaseLock({ repo: repoSlug(), issueNumber: 7 });
    expect(store.getLock({ repo: repoSlug(), issueNumber: 7 })).toBeNull();
    expect(store.tryAcquireLock({ repo: repoSlug(), issueNumber: 7, runId: runId('bbb222'), acquiredAt: 3 })).toBe(true);
  });
});

describe('process ownership and reaping', () => {
  const ownership = { pgid: 4242, ownerPid: 4241, ownerStart: 'Mon Aug 25 10:00:00 2026', startedAt: 1 };

  it('persists ownership so an orphan is detectable after the supervisor dies', () => {
    // An orphan cannot be found from `status`: a SIGKILLed supervisor never updates
    // its own row, so the run stays "running" forever. Ownership is what makes the
    // structural check possible — a live group whose owner is gone.
    store.createRun(makeRun({ status: 'running', ownership }));
    store.close();

    const reopened = new SqliteRunStore(dbPath);
    const candidates = reopened.listReapCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ownership.pgid).toBe(4242);
    // ownerStart guards against PID reuse; without it a recycled pid looks alive.
    expect(candidates[0]?.ownership.ownerStart).toBe('Mon Aug 25 10:00:00 2026');
    expect(candidates[0]?.run.status).toBe('running');
    reopened.close();
  });

  it('clearing ownership removes the run from reap candidates', () => {
    store.createRun(makeRun({ status: 'running', ownership }));
    expect(store.listReapCandidates()).toHaveLength(1);

    store.updateRun(runId('a1b2c3'), { ownership: null, status: 'reproduced' });

    expect(store.listReapCandidates()).toHaveLength(0);
    expect(store.getRun(runId('a1b2c3'))?.ownership).toBeUndefined();
  });

  it('a run that never spawned anything is not a reap candidate', () => {
    store.createRun(makeRun({ status: 'queued' }));
    expect(store.listReapCandidates()).toHaveLength(0);
  });
});

describe('task attempts', () => {
  beforeEach(() => store.createRun(makeRun()));

  it('records one row per attempt so a retry adds history instead of erasing it', () => {
    // `runs` holds only the CURRENT state. Without per-attempt rows, retrying an
    // issue would overwrite the record of why the previous attempt failed — which is
    // exactly what a maintainer needs to see before retrying again.
    store.startAttempt({ runId: runId('a1b2c3'), attempt: 1, harness: 'claude-code', startedAt: 10 });
    store.finishAttempt(runId('a1b2c3'), { outcome: 'timeout', exitCode: 143, endedAt: 20 });

    store.startAttempt({ runId: runId('a1b2c3'), attempt: 2, harness: 'claude-code', startedAt: 30 });
    store.finishAttempt(runId('a1b2c3'), { outcome: 'completed', exitCode: 0, endedAt: 40 });

    const attempts = store.listAttempts(runId('a1b2c3'));
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(attempts[0]?.outcome).toBe('timeout');   // first failure still legible
    expect(attempts[0]?.exitCode).toBe(143);
    expect(attempts[1]?.outcome).toBe('completed');
  });

  it('finishAttempt closes the latest attempt, not an earlier one', () => {
    store.startAttempt({ runId: runId('a1b2c3'), attempt: 1, startedAt: 10 });
    store.finishAttempt(runId('a1b2c3'), { outcome: 'error', endedAt: 20 });
    store.startAttempt({ runId: runId('a1b2c3'), attempt: 2, startedAt: 30 });
    store.finishAttempt(runId('a1b2c3'), { outcome: 'cancelled', endedAt: 40 });

    const [first, second] = store.listAttempts(runId('a1b2c3'));
    expect(first?.outcome).toBe('error');       // untouched by the second finish
    expect(second?.outcome).toBe('cancelled');
  });

  it('rejects a duplicate attempt number for the same run', () => {
    // A unique index, not a check in code: two supervisors racing the same retry
    // must not both claim attempt 2.
    store.startAttempt({ runId: runId('a1b2c3'), attempt: 1, startedAt: 10 });
    expect(() => store.startAttempt({ runId: runId('a1b2c3'), attempt: 1, startedAt: 11 })).toThrow();
  });

  it('leaves an in-flight attempt open until it is finished', () => {
    // A supervisor killed mid-run cannot close its own row, so an attempt with no
    // outcome is the signal that something ended abruptly.
    store.startAttempt({ runId: runId('a1b2c3'), attempt: 1, startedAt: 10 });
    const [open] = store.listAttempts(runId('a1b2c3'));
    expect(open?.outcome).toBeUndefined();
    expect(open?.endedAt).toBeUndefined();
  });

  it('rejects an attempt for a run that does not exist', () => {
    expect(() => store.startAttempt({ runId: runId('ghost1'), attempt: 1, startedAt: 1 })).toThrow();
  });
});

describe('artifacts', () => {
  beforeEach(() => store.createRun(makeRun()));

  it('records and lists artifacts in creation order', () => {
    store.recordArtifact({ runId: runId('a1b2c3'), path: 'a.patch', kind: 'patch', createdAt: 1, bytes: 10 });
    store.recordArtifact({ runId: runId('a1b2c3'), path: 'events.jsonl', kind: 'events', createdAt: 2 });

    const list = store.listArtifacts(runId('a1b2c3'));
    expect(list.map((a) => a.kind)).toEqual(['patch', 'events']);
    expect(list[0]?.bytes).toBe(10);
    expect(list[1]?.bytes).toBeUndefined(); // absent, not null
  });

  it('rejects an artifact for a run that does not exist', () => {
    // Foreign keys are ON, so a dangling artifact cannot be created. Retention
    // (IF-018) relies on ON DELETE CASCADE to clean these up with their run.
    expect(() =>
      store.recordArtifact({ runId: runId('ghost1'), path: 'x', kind: 'other', createdAt: 1 }),
    ).toThrow();
  });
});
