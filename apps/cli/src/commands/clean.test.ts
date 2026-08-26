import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, RunStatus } from '@issueforge/contracts';
import { repoSlug, runId, sha } from '@issueforge/contracts';
import { SqliteRunStore } from '@issueforge/adapters';
import type { AppContext } from '../context.js';
import { planClean } from './clean.js';

let root: string;
let store: SqliteRunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'if-clean-'));
  store = new SqliteRunStore(join(root, 'runs.db'));
  store.migrate();
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function record(id: string, status: RunStatus, ageDays: number): void {
  const at = NOW - ageDays * DAY;
  const run: RunState = {
    id: runId(id),
    repo: repoSlug(),
    issueNumber: 1,
    task: 'reproduce',
    status,
    baseSha: sha(),
    harness: 'claude-code',
    createdAt: at,
    updatedAt: at,
  };
  // createRun writes the timestamps as given, so age is set here rather than patched.
  store.createRun(run);
}

function plan(): ReturnType<typeof planClean> {
  const context = { store, root } as unknown as AppContext;
  return planClean(context, { olderThanDays: 14, dryRun: true, now: NOW });
}

describe('planClean', () => {
  it('reclaims a run the reaper interrupted', () => {
    // The bug this test exists for: `interrupted` was classified as neither terminal
    // nor active, and planClean filters on isTerminal — so runs killed by the reaper,
    // the ones most likely to have left a dirty worktree, were the only ones never
    // cleaned. The leak grew with every crash.
    record('interrupted1', 'interrupted', 30);

    expect(plan().map((t) => t.status)).toEqual(['interrupted']);
  });

  it('reclaims every finished run, whatever its conclusion', () => {
    for (const status of ['reproduced', 'cannot-reproduce', 'needs-info', 'blocked', 'cancelled'] as const) {
      record(status.replace(/-/g, ''), status, 30);
    }

    expect(plan()).toHaveLength(5);
  });

  it('never reclaims a run that may still own processes', () => {
    record('queued1', 'queued', 30);
    record('running1', 'running', 30);

    expect(plan()).toEqual([]);
  });

  it('leaves recent runs alone regardless of status', () => {
    record('recent1', 'reproduced', 1);

    expect(plan()).toEqual([]);
  });
});
