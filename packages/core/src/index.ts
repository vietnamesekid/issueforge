/**
 * Pure domain logic: state transitions, evidence validation, policy, and the ports
 * that adapters implement.
 *
 * Dependency rule: this package may import ONLY @issueforge/contracts. No execa, no
 * node:sqlite, no gh, no node:fs. I/O lives behind the ports declared here, so the
 * domain stays testable without a filesystem, a database, a network or a subprocess.
 * Enforced by tests/import-boundaries.test.ts.
 */
export type {
  RunStore,
  RunPatch,
  RunFilter,
  TaskAttemptOutcome,
} from './ports/run-store.js';
export { isTerminal, mayHoldProcesses } from './domain/run-status.js';
export { classifyAttempt, classifyFailure } from './domain/reproduce-outcome.js';
export type { AttemptClassification, AttemptFailure } from './domain/reproduce-outcome.js';
export { buildReproduceCard } from './domain/task-card.js';
export { validateReproduction } from './domain/evidence-validator.js';
export { checkWriteBoundary, describeViolations, ALWAYS_FORBIDDEN } from './domain/write-boundary.js';
export type { WriteBoundary, BoundaryViolation } from './domain/write-boundary.js';
export type { ValidationRequest } from './domain/evidence-validator.js';
export type { Replayer, ReplayOptions, DefectToggle } from './ports/replay.js';
export type { GitHubWriter } from './ports/github.js';
export {
  renderStatusComment,
  statusLabelFor,
  STATUS_LABELS,
  ALL_STATUS_LABELS,
  COMMENT_MARKER,
} from './domain/status-report.js';
export type { StatusReport } from './domain/status-report.js';
export type { TaskCardInput } from './domain/task-card.js';
export { HarnessContractError } from './ports/harness.js';
export type { HarnessAdapter, HarnessRun, HarnessRunRequest } from './ports/harness.js';
export { WorkspaceError } from './ports/workspace.js';
export type { Workspace, WorkspaceManager, WorkspaceRequest } from './ports/workspace.js';
