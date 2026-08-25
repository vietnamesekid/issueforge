import { execFileSync } from 'node:child_process';

/**
 * Process identity and liveness, as seen by the OS.
 *
 * The ledger cannot answer these questions. A supervisor killed outright never gets
 * to update its own row, so a run can read as `running` long after its processes are
 * gone — and the row alone can never prove they are still alive either. Deciding
 * whether a process group is an orphan means asking the OS directly.
 */

/**
 * When a process started, as an opaque string from `ps -o lstart=`.
 *
 * PIDs are recycled. Pairing a pid with its start time is what makes it safe to act
 * on one later: a *new* process that happens to inherit a dead supervisor's pid has a
 * different start time, so it is never mistaken for the original owner. Without this,
 * the reaper could kill an innocent unrelated process.
 *
 * Returns null when the process does not exist.
 */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // ps exits non-zero when the pid is gone.
    return null;
  }
}

/**
 * Whether a process group still has members.
 *
 * Signal 0 performs the permission and existence checks without delivering anything.
 * `EPERM` means the group exists but belongs to another user — still alive, and not
 * ours to touch.
 */
export function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether `pid` is alive AND is the same process that started at `startedAt`. */
export function isSameProcess(pid: number, startedAt: string): boolean {
  return processStartTime(pid) === startedAt;
}

/** Identity of the current process, to record as the owner of a spawned group. */
export function currentProcessIdentity(): { pid: number; startedAt: string } {
  return {
    pid: process.pid,
    // Falling back to a constant would make every future liveness check compare
    // equal, so an unreadable start time is recorded as such and the owner is then
    // treated as untrackable rather than as definitely-alive.
    startedAt: processStartTime(process.pid) ?? '',
  };
}
