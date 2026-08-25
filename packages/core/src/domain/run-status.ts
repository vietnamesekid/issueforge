import type { RunStatus } from '@issueforge/contracts';

/**
 * Predicates over run lifecycle state.
 *
 * These encode two questions the rest of the system keeps asking, in one place so
 * the answers cannot drift: is this run finished, and might it still own processes?
 */

/** States that hold no lock and will not advance without new maintainer intent. */
const TERMINAL: readonly RunStatus[] = [
  'reproduced',
  'cannot-reproduce',
  'needs-info',
  'blocked',
  'cancelled',
];

/** States in which a run may still own a live process group. */
const ACTIVE: readonly RunStatus[] = ['queued', 'running'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Whether a run in this state might still own processes.
 *
 * Note this is necessary but not sufficient for reaping: a supervisor killed outright
 * never updates its row, so a run can read as `running` long after its processes are
 * gone — and conversely the row alone can never prove they are still alive. Deciding
 * that requires checking the owning process against the OS.
 */
export function mayHoldProcesses(status: RunStatus): boolean {
  return ACTIVE.includes(status);
}
