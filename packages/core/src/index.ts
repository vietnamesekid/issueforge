/**
 * Pure domain logic: state transitions, evidence validation, policy, and the ports
 * that adapters implement.
 *
 * Dependency rule: this package may import ONLY @issueforge/contracts. No execa, no
 * node:sqlite, no gh, no node:fs. I/O lives behind the ports declared here.
 * Enforced by tests/import-boundaries.test.ts.
 */
import type { RunStatus } from '@issueforge/contracts';

export type {
  RunStore,
  RunPatch,
  RunFilter,
  ArtifactRecord,
} from './ports/run-store.js';

/** Terminal states hold no lock and will not advance without new maintainer intent. */
const TERMINAL: readonly RunStatus[] = [
  'reproduced',
  'cannot-reproduce',
  'needs-info',
  'blocked',
  'cancelled',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** A run in one of these states may still own a live process group. */
export function mayHoldProcesses(status: RunStatus): boolean {
  return status === 'running' || status === 'queued';
}
