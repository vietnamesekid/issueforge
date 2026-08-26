import type { RunStatus } from '@issueforge/contracts';

/**
 * Where a run sits in its lifecycle.
 *
 * `active` — the run may still own a live process group.
 * `finished` — it holds no lock, owns no processes, and will not advance on its own.
 */
type Lifecycle = 'active' | 'finished';

/**
 * Every status, classified exactly once.
 *
 * A total `Record` rather than two arrays, because two arrays are how this drifted:
 * `interrupted` was previously in neither, so a run the reaper had killed read as
 * neither finished nor active. `clean` filters on `isTerminal`, so those runs — the
 * ones most likely to have left a dirty worktree — were the only ones it never
 * removed, and the leak grew with every crash.
 *
 * Adding a status to `RunStatus` now fails to compile until it is classified here.
 */
const LIFECYCLE: Record<RunStatus, Lifecycle> = {
  queued: 'active',
  running: 'active',

  reproduced: 'finished',
  'cannot-reproduce': 'finished',
  fixed: 'finished',
  'could-not-fix': 'finished',
  'needs-info': 'finished',
  blocked: 'finished',
  cancelled: 'finished',
  // Written by the reaper once it has killed the orphaned group: the processes are
  // already gone, so the run is over and its workspace can be reclaimed.
  interrupted: 'finished',
};

/** Whether the run is over: no lock held, nothing left to wait for. */
export function isTerminal(status: RunStatus): boolean {
  return LIFECYCLE[status] === 'finished';
}

/**
 * Whether a run in this state might still own processes.
 *
 * Necessary but not sufficient for reaping: a supervisor killed outright never
 * updates its row, so a run can read as `running` long after its processes are gone —
 * and the row alone can never prove they are still alive. Deciding that requires
 * checking the owning process against the OS.
 */
export function mayHoldProcesses(status: RunStatus): boolean {
  return LIFECYCLE[status] === 'active';
}
