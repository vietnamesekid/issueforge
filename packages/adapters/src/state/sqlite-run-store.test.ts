import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '@issueforge/contracts';
import { spawn } from 'node:child_process';
import { SqliteRunStore } from './sqlite-run-store.js';

/** Built entry point, used by the cross-process test below. */
const distEntry = new URL('../../dist/index.js', import.meta.url).pathname;
import { SCHEMA_VERSION } from './migrations.js';

const SHA = 'a'.repeat(40);

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run_a1b2c3',
    repo: 'owner/repo',
    issueNumber: 7,
    task: 'reproduce',
    status: 'queued',
    baseSha: SHA,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as RunState;
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
    expect(store.getRun('run_a1b2c3')).not.toBeNull();
  });

  it('bring a fresh database to the current schema version', () => {
    const second = new SqliteRunStore(join(dir, 'other.db'));
    second.migrate();
    second.createRun(makeRun({ id: 'run_zzz999' }));
    expect(second.getRun('run_zzz999')?.repo).toBe('owner/repo');
    second.close();
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('creates the parent directory rather than failing on a fresh machine', () => {
    // dbPath is under a directory that did not exist; construction must handle it.
    expect(store.getRun('nope')).toBeNull();
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
    store.updateRun('run_a1b2c3', { status: 'running', harness: 'claude-code' });

    const run = store.getRun('run_a1b2c3');
    expect(run?.status).toBe('running');
    expect(run?.harness).toBe('claude-code');
    expect(run?.workdir).toBe('/tmp/wt'); // untouched
    expect(run?.updatedAt).toBeGreaterThan(1_000);
  });

  it('filters by repo, issue and status', () => {
    store.createRun(makeRun({ id: 'run_aaa111', status: 'running' }));
    store.createRun(makeRun({ id: 'run_bbb222', status: 'reproduced', issueNumber: 8 }));
    store.createRun(makeRun({ id: 'run_ccc333', status: 'cancelled', repo: 'other/repo' }));

    expect(store.listRuns({ repo: 'owner/repo' })).toHaveLength(2);
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
    store.updateRun('run_a1b2c3', { status: 'interrupted', detail: 'SIGINT' });
    store.close(); // stands in for the process ceasing to exist

    const reopened = new SqliteRunStore(dbPath);
    reopened.migrate(); // every start migrates; must not disturb existing data
    const run = reopened.getRun('run_a1b2c3');
    expect(run?.status).toBe('interrupted');
    expect(run?.detail).toBe('SIGINT');
    reopened.close();
  });

  it('two real PROCESSES can cold-start against the same new database', async () => {
    // The single-process test below passes even when concurrent startup is broken,
    // because both connections live in one process. Converting a fresh database to
    // WAL takes an exclusive lock, and before busy_timeout was moved ahead of that
    // conversion this failed in 6 of 8 attempts with "database is locked".
    //
    // The children must run CONCURRENTLY: spawnSync would start them one after the
    // other, and a sequential pair never races, so such a test passes against the
    // broken ordering and proves nothing.
    const racePath = join(dir, 'race', 'state.db');
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

    const results = await Promise.all([run(), run()]);

    for (const r of results) {
      expect(r.stderr).not.toMatch(/database is locked/i);
      expect(r.code).toBe(0);
    }
  });

  it('two connections read and write concurrently without SQLITE_BUSY', () => {
    // The CLI and the listener service both open this file.
    const other = new SqliteRunStore(dbPath);
    try {
      store.createRun(makeRun({ id: 'run_aaa111' }));
      expect(other.getRun('run_aaa111')).not.toBeNull();

      other.createRun(makeRun({ id: 'run_bbb222' }));
      store.updateRun('run_bbb222', { status: 'running' });

      expect(store.getRun('run_bbb222')?.status).toBe('running');
      expect(other.listRuns()).toHaveLength(2);
    } finally {
      other.close();
    }
  });
});

describe('issue locks', () => {
  beforeEach(() => {
    store.createRun(makeRun({ id: 'run_aaa111' }));
    store.createRun(makeRun({ id: 'run_bbb222' }));
  });

  it('grants the lock once and refuses a second holder for the same issue', () => {
    const first = store.tryAcquireLock({ repo: 'owner/repo', issueNumber: 7, runId: 'run_aaa111', acquiredAt: 1 });
    const second = store.tryAcquireLock({ repo: 'owner/repo', issueNumber: 7, runId: 'run_bbb222', acquiredAt: 2 });

    expect(first).toBe(true);
    expect(second).toBe(false); // mutual exclusion comes from the PRIMARY KEY, not a read-then-write
    expect(store.getLock('owner/repo', 7)?.runId).toBe('run_aaa111');
  });

  it('allows concurrent runs on different issues', () => {
    expect(store.tryAcquireLock({ repo: 'owner/repo', issueNumber: 7, runId: 'run_aaa111', acquiredAt: 1 })).toBe(true);
    expect(store.tryAcquireLock({ repo: 'owner/repo', issueNumber: 9, runId: 'run_bbb222', acquiredAt: 1 })).toBe(true);
  });

  it('releases so a later run can take the issue', () => {
    store.tryAcquireLock({ repo: 'owner/repo', issueNumber: 7, runId: 'run_aaa111', acquiredAt: 1 });
    store.releaseLock('owner/repo', 7);
    expect(store.getLock('owner/repo', 7)).toBeNull();
    expect(store.tryAcquireLock({ repo: 'owner/repo', issueNumber: 7, runId: 'run_bbb222', acquiredAt: 3 })).toBe(true);
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

    store.updateRun('run_a1b2c3', { ownership: null, status: 'reproduced' });

    expect(store.listReapCandidates()).toHaveLength(0);
    expect(store.getRun('run_a1b2c3')?.ownership).toBeUndefined();
  });

  it('a run that never spawned anything is not a reap candidate', () => {
    store.createRun(makeRun({ status: 'queued' }));
    expect(store.listReapCandidates()).toHaveLength(0);
  });
});

describe('artifacts', () => {
  beforeEach(() => store.createRun(makeRun()));

  it('records and lists artifacts in creation order', () => {
    store.recordArtifact({ runId: 'run_a1b2c3', path: 'a.patch', kind: 'patch', createdAt: 1, bytes: 10 });
    store.recordArtifact({ runId: 'run_a1b2c3', path: 'events.jsonl', kind: 'events', createdAt: 2 });

    const list = store.listArtifacts('run_a1b2c3');
    expect(list.map((a) => a.kind)).toEqual(['patch', 'events']);
    expect(list[0]?.bytes).toBe(10);
    expect(list[1]?.bytes).toBeUndefined(); // absent, not null
  });

  it('rejects an artifact for a run that does not exist', () => {
    // Foreign keys are ON, so a dangling artifact cannot be created. Retention
    // (IF-018) relies on ON DELETE CASCADE to clean these up with their run.
    expect(() =>
      store.recordArtifact({ runId: 'run_ghost1', path: 'x', kind: 'other', createdAt: 1 }),
    ).toThrow();
  });
});
