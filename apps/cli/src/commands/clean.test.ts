import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, RunStatus } from '@issueforge/contracts';
import { repoSlug, runId, sha } from '@issueforge/contracts';
import { SqliteRunStore } from '@issueforge/adapters';
import type { AppContext } from '../context.js';
import { planClean, executeClean, renderCleanPlan } from './clean.js';

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

/** A run with real artifacts on disk, so deletion has something to delete. */
function recordWithArtifacts(id: string, status: RunStatus, ageDays: number): string {
  const at = NOW - ageDays * DAY;
  const workdir = join(root, 'workspaces', id);
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'checkout.txt'), 'work');

  const transcript = join(root, 'runs', id);
  mkdirSync(transcript, { recursive: true });
  writeFileSync(join(transcript, 'events.jsonl'), '{}');

  store.createRun({
    id: runId(id),
    repo: repoSlug(),
    issueNumber: 1,
    task: 'reproduce',
    status,
    baseSha: sha(),
    harness: 'claude-code',
    workdir,
    createdAt: at,
    updatedAt: at,
  });
  return workdir;
}

describe('executeClean', () => {
  it('deletes the artifacts but KEEPS the ledger row', () => {
    // The row is the only record that the run happened. Deleting it would make
    // `clean` erase history rather than reclaim disk, and a user could no longer
    // see what an old run concluded.
    const workdir = recordWithArtifacts('gone1111', 'reproduced', 30);
    const context = { store, root } as unknown as AppContext;

    executeClean(context, planClean(context, { olderThanDays: 14, dryRun: false, now: NOW }));

    expect(existsSync(workdir)).toBe(false);
    expect(store.getRun(runId('gone1111'))?.status).toBe('reproduced');
  });

  it('says in the ledger why the artifacts are missing', () => {
    // Without this, a later `status` shows a finished run whose transcript is gone
    // with no explanation, which reads as data loss rather than housekeeping.
    recordWithArtifacts('noted111', 'fixed', 30);
    const context = { store, root } as unknown as AppContext;

    executeClean(context, planClean(context, { olderThanDays: 14, dryRun: false, now: NOW }));

    expect(store.getRun(runId('noted111'))?.detail).toContain('fixed');
  });

  it('leaves the artifacts of a recent run on disk', () => {
    const keep = recordWithArtifacts('recent11', 'fixed', 1);
    const context = { store, root } as unknown as AppContext;

    executeClean(context, planClean(context, { olderThanDays: 14, dryRun: false, now: NOW }));

    expect(existsSync(keep)).toBe(true);
  });

  it('does nothing when given nothing', () => {
    const keep = recordWithArtifacts('untouch1', 'fixed', 30);
    executeClean({ store, root } as unknown as AppContext, []);
    expect(existsSync(keep)).toBe(true);
  });
});

describe('renderCleanPlan', () => {
  it('says there is nothing rather than printing an empty plan', () => {
    expect(renderCleanPlan([], true)).toBe('Nothing to clean.');
  });

  it('distinguishes what WOULD be removed from what WAS', () => {
    // A dry run that reads like a completed deletion would make a user think their
    // disk was reclaimed when nothing happened.
    recordWithArtifacts('render11', 'reproduced', 30);
    const context = { store, root } as unknown as AppContext;
    const targets = planClean(context, { olderThanDays: 14, dryRun: true, now: NOW });

    expect(renderCleanPlan(targets, true)).toContain('would be removed');
    expect(renderCleanPlan(targets, true)).toContain('--yes');
    expect(renderCleanPlan(targets, false)).toContain('removed.');
    expect(renderCleanPlan(targets, false)).not.toContain('would be removed');
  });

  it('names every path it is about to delete', () => {
    recordWithArtifacts('paths111', 'fixed', 30);
    const context = { store, root } as unknown as AppContext;
    const targets = planClean(context, { olderThanDays: 14, dryRun: true, now: NOW });

    const text = renderCleanPlan(targets, true);
    for (const path of targets[0]?.paths ?? []) expect(text).toContain(path);
  });
});
