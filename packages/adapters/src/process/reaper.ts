import type { ProcessOwnership, RunState } from '@issueforge/contracts';
import type { RunStore } from '@issueforge/core';
import { isGroupAlive, isSameProcess } from './identity.js';

/**
 * Cleans up process groups whose supervisor is gone.
 *
 * Why this exists at all: when a workflow run is cancelled, the runner kills the
 * step's process tree about ten seconds after SIGINT. The supervisor dies without
 * finishing, and any harness group it spawned can outlive it — still burning CPU,
 * still holding deleted inodes so the disk is never reclaimed.
 *
 * The critical detail, and the bug SPIKE-B caught: **`status` cannot detect an
 * orphan.** A SIGKILLed supervisor never gets to update its own row, so the run reads
 * `running` forever. A reaper that trusts `status` finds nothing and cleans up
 * nothing. An orphan is defined structurally instead:
 *
 *     a process group that is still alive while the supervisor that owned it is gone
 *
 * and the owner's start time is what makes acting on that safe, because PIDs are
 * recycled and an innocent process could otherwise inherit a dead supervisor's pid.
 */

/** Grace period between SIGTERM and SIGKILL, per group. */
const TERM_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 50;

export interface ReapedGroup {
  runId: string;
  pgid: number;
  /** Why it was reaped, for the log — the two cases have very different causes. */
  reason: 'owner-gone' | 'stale';
}

export interface ReapOptions {
  /**
   * Runs older than this whose owner still appears alive are reaped anyway.
   *
   * Covers the case a liveness check cannot: an owner that is alive but wedged, or a
   * pid whose start time was unreadable when it was recorded. Omit to reap only on
   * owner death.
   */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Reap orphaned process groups. Safe to call on every invocation, and cheap when
 * there is nothing to do — the common case is a handful of rows and no live groups.
 */
export function reapOrphans(store: RunStore, options: ReapOptions = {}): ReapedGroup[] {
  const now = options.now ?? Date.now;
  const reaped: ReapedGroup[] = [];

  for (const { run, ownership } of store.listReapCandidates()) {
    // A group that is already gone needs no signal; just clear the row so the next
    // invocation does not reconsider it.
    if (!isGroupAlive(ownership.pgid)) {
      store.updateRun(run.id, { ownership: null });
      continue;
    }

    const reason = classify(run, ownership, now(), options.maxAgeMs);
    if (reason === null) continue; // a live run, legitimately holding its processes

    killGroup(ownership.pgid);
    store.updateRun(run.id, {
      ownership: null,
      status: 'interrupted',
      detail: `orphaned process group ${ownership.pgid} reaped (${reason})`,
    });
    reaped.push({ runId: run.id, pgid: ownership.pgid, reason });
  }

  return reaped;
}

/** Why this group should be reaped, or null to leave it alone. */
function classify(
  run: RunState,
  ownership: ProcessOwnership,
  now: number,
  maxAgeMs: number | undefined,
): ReapedGroup['reason'] | null {
  // The structural test. Note it deliberately ignores `run.status`.
  if (!isSameProcess(ownership.ownerPid, ownership.ownerStart)) return 'owner-gone';
  if (maxAgeMs !== undefined && now - ownership.startedAt > maxAgeMs) return 'stale';
  return null;
}

/**
 * Terminate a process group: SIGTERM, a grace period, then SIGKILL.
 *
 * Signals the negative pgid so every member is reached, not just the leader — a
 * harness that backgrounds work leaves children the leader's death would not touch.
 */
export function killGroup(pgid: number, graceMs = TERM_GRACE_MS): void {
  if (!signalGroup(pgid, 'SIGTERM')) return;

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pgid)) return;
    sleepBriefly();
  }

  signalGroup(pgid, 'SIGKILL');
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    // ESRCH: already gone. EPERM: not ours to signal. Neither is actionable here.
    return false;
  }
}

/**
 * Block briefly.
 *
 * Deliberately synchronous: this runs on the interrupt path, where the process is
 * about to be killed and yielding to the event loop risks never being resumed.
 */
function sleepBriefly(): void {
  const until = Date.now() + POLL_INTERVAL_MS;
  while (Date.now() < until) {
    /* spin */
  }
}
