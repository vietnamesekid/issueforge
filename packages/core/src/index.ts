/**
 * Pure domain logic: state transitions, evidence validation, policy, and the ports
 * that adapters implement.
 *
 * Dependency rule: this package may import ONLY @issueforge/contracts. No execa, no
 * node:sqlite, no gh, no node:fs. I/O lives behind the ports declared here, so the
 * domain stays testable without a filesystem, a database, a network or a subprocess.
 * Enforced by tests/import-boundaries.test.ts.
 */
export type { RunStore, RunPatch, RunFilter } from './ports/run-store.js';
export { isTerminal, mayHoldProcesses } from './domain/run-status.js';
