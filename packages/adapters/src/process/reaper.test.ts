import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '@issueforge/contracts';
import { repoSlug, runId, sha } from '@issueforge/contracts';
import type { RunStore } from '@issueforge/core';
import { SqliteRunStore } from '../state/index.js';
import { currentProcessIdentity, isGroupAlive, reapOrphans, spawnSupervised } from './index.js';

let dir: string;
let store: SqliteRunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-reap-'));
  store = new SqliteRunStore(join(dir, 'state.db'));
  store.migrate();
});

afterEach(() => {
  killIssuedTags();
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: runId(),
    repo: repoSlug(),
    issueNumber: 7,
    task: 'reproduce',
    status: 'running',
    baseSha: sha(),
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function countSleepers(tag: number): number {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  const re = new RegExp(`^\\s*\\d+\\s+(/bin/)?sleep\\s+${tag}\\s*$`);
  return out.split('\n').filter((line) => re.test(line)).length;
}

function backgroundingScript(tag: number): string {
  const path = join(dir, `h-${tag}.sh`);
  writeFileSync(path, `#!/bin/sh\nsleep ${tag} &\nsleep ${tag}\n`);
  chmodSync(path, 0o755);
  return path;
}

const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A `sleep` duration unique to this process and this call.
 *
 * Test files run in parallel workers and each spawns real processes, so a hardcoded
 * duration is a shared global: one file's leftovers get counted by another's
 * assertion — and reused worker pids make a pid-derived base collide too. A random
 * base per module is the only seed that is actually unique here.
 */
/** Every tag handed out here, so afterEach can guarantee nothing outlives the run. */
const issuedTags: number[] = [];
let tagCounter = 0;
const TAG_BASE = 20_000 + Math.floor(Math.random() * 40_000);
const nextTag = (): number => {
  const tag = TAG_BASE + tagCounter++;
  issuedTags.push(tag);
  return tag;
};

/**
 * Kill anything this file spawned.
 *
 * A test that leaves processes behind is a test that pollutes the developer's
 * machine and the next run's counts. Assertions cover the code under test; this
 * covers the cases where an assertion failed before its own cleanup could run.
 */
function killIssuedTags(): void {
  for (const tag of issuedTags) {
    try {
      execFileSync('pkill', ['-f', `sleep ${tag}`], { stdio: 'ignore' });
    } catch {
      // pkill exits non-zero when nothing matched, which is the expected case.
    }
  }
}

/**
 * Wait until the spawned tree is actually running.
 *
 * A fixed delay is a guess about scheduler latency: too short and the assertion runs
 * before the shell has forked, too long and every test pays for it. Polling for the
 * condition removes the guess.
 */
async function expectSleepers(tag: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countSleepers(tag) > 0) return;
    await settle(50);
  }
  expect(countSleepers(tag), `no process matching "sleep ${tag}" ever started`).toBeGreaterThan(0);
}

async function expectNoSleepers(tag: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countSleepers(tag) === 0) return;
    await settle(50);
  }
  expect(countSleepers(tag), `processes matching "sleep ${tag}" survived`).toBe(0);
}

describe('reapOrphans', { timeout: 20_000 }, () => {
  it('kills a group whose owner is gone — the case `status` cannot detect', async () => {
    // The bug SPIKE-B caught: a supervisor killed outright never updates its own row,
    // so the run reads `running` forever. Detection is structural — a live group whose
    // owner is no longer the process that started it.
    const tag = nextTag();
    const child = spawnSupervised(backgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);

    // Record ownership naming a plausible but DEAD owner pid, standing in for a
    // supervisor that has since exited.
    store.createRun(
      makeRun({
        status: 'running',
        ownership: {
          pgid: child.pgid,
          ownerPid: process.pid,
          ownerStart: 'Mon Jan  1 00:00:00 2001', // start time cannot match
          startedAt: Date.now(),
        },
      }),
    );

    const reaped = reapOrphans(store);

    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.reason).toBe('owner-gone');
    await expectNoSleepers(tag);

    // The row is cleared and marked, so the next invocation does not reconsider it.
    const run = store.getRun(runId());
    expect(run?.ownership).toBeUndefined();
    expect(run?.status).toBe('interrupted');
    expect(store.listReapCandidates()).toHaveLength(0);
  });

  it('leaves a live run alone — the dangerous failure mode', async () => {
    // Killing a healthy run would be far worse than leaking a process. The owner here
    // is this very process, alive and matching.
    const tag = nextTag();
    const child = spawnSupervised(backgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);

    const me = currentProcessIdentity();
    store.createRun(
      makeRun({
        status: 'running',
        ownership: { pgid: child.pgid, ownerPid: me.pid, ownerStart: me.startedAt, startedAt: Date.now() },
      }),
    );

    const reaped = reapOrphans(store);

    expect(reaped).toHaveLength(0);
    expect(countSleepers(tag)).toBeGreaterThan(0);
    expect(isGroupAlive(child.pgid)).toBe(true);

    child.terminate();
    await child.wait();
    await expectNoSleepers(tag);
  });

  it('clears ownership for a group that already exited, without signalling', () => {
    // Nothing to kill, but the row must stop being reconsidered on every invocation.
    store.createRun(
      makeRun({
        status: 'running',
        ownership: {
          pgid: 0x7ffffff, // no such group
          ownerPid: process.pid,
          ownerStart: 'Mon Jan  1 00:00:00 2001',
          startedAt: Date.now(),
        },
      }),
    );

    expect(reapOrphans(store)).toHaveLength(0);
    expect(store.getRun(runId())?.ownership).toBeUndefined();
    expect(store.listReapCandidates()).toHaveLength(0);
  });

  it('reaps a stale run even when its owner still looks alive', async () => {
    // Covers what a liveness check cannot: an owner that is alive but wedged.
    const tag = nextTag();
    const child = spawnSupervised(backgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);

    const me = currentProcessIdentity();
    store.createRun(
      makeRun({
        status: 'running',
        ownership: {
          pgid: child.pgid,
          ownerPid: me.pid,
          ownerStart: me.startedAt,
          startedAt: Date.now() - 60_000, // started a minute ago
        },
      }),
    );

    const reaped = reapOrphans(store, { maxAgeMs: 1_000 });

    expect(reaped[0]?.reason).toBe('stale');
    await expectNoSleepers(tag);
  });

  it('is a no-op when nothing was ever spawned', () => {
    store.createRun(makeRun({ status: 'queued' }));
    expect(reapOrphans(store)).toEqual([]);
  });

  it('survives a store with no candidates at all', () => {
    expect(reapOrphans(store as RunStore)).toEqual([]);
  });
});
