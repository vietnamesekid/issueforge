import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessOwnership, RunState } from '@issueforge/contracts';
import { repoSlug, runId, sha } from '@issueforge/contracts';
import { SqliteRunStore } from '@issueforge/adapters';
import type { AppContext } from '../context.js';
import { cancelRuns } from './cancel.js';

let root: string;
let store: SqliteRunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'if-cancel-'));
  store = new SqliteRunStore(join(root, 'runs.db'));
  store.migrate();
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true });
});

/** A run the ledger believes is live, owned by this very process so it reads as alive. */
function liveRun(id: string, issueNumber: number, pgid: number): RunState {
  const ownership: ProcessOwnership = {
    pgid,
    ownerPid: process.pid,
    ownerStart: 'Mon Aug 26 10:00:00 2026',
    startedAt: Date.now(),
  };
  const run: RunState = {
    id: runId(id),
    repo: repoSlug(),
    issueNumber,
    task: 'reproduce',
    status: 'running',
    baseSha: sha(),
    harness: 'claude-code',
    ownership,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.createRun(run);
  return run;
}

const context = () => ({ store, root }) as unknown as AppContext;

describe('cancelRuns', () => {
  it('reports nothing to cancel rather than failing', () => {
    // Cancelling an issue with no live run is not an error — a maintainer may have
    // labelled it after the run already finished.
    expect(cancelRuns(context(), { issueNumber: 42 })).toEqual([]);
  });

  it('only touches runs for the issue it was asked about', () => {
    // A run on an unrelated issue must survive: cancelling #7 stopping #8 would be
    // worse than not cancelling at all.
    liveRun('other111', 8, 999_001);
    const target = liveRun('target11', 7, 999_002);

    const cancelled = cancelRuns(context(), { issueNumber: 7 });

    expect(cancelled.map((c) => c.runId)).toEqual([target.id]);
    expect(store.getRun(runId('other111'))?.status).toBe('running');
  });

  it('marks the run cancelled and clears its ownership', () => {
    // Ownership must go, or the reaper reconsiders a pgid that may have been recycled.
    const run = liveRun('target22', 7, 999_003);

    cancelRuns(context(), { issueNumber: 7 });

    const after = store.getRun(run.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.ownership).toBeUndefined();
    expect(after?.detail).toMatch(/cancelled/i);
  });

  it('leaves a finished run alone', () => {
    // Only runs that may still own processes are candidates.
    const run = liveRun('done1111', 7, 999_004);
    store.updateRun(run.id, { status: 'reproduced', ownership: null });

    expect(cancelRuns(context(), { issueNumber: 7 })).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('reproduced');
  });
});
