/**
 * Pure domain logic and the ports adapters implement.
 *
 * Dependency rule: this package may import ONLY @issueforge/contracts. No execa, no
 * node:sqlite, no gh, no node:fs. I/O lives behind the ports declared here, so the
 * domain stays testable without a filesystem, a database, a network or a subprocess.
 * Enforced by tests/import-boundaries.test.ts.
 *
 * Deliberately small. IssueForge orchestrates the outer workflow; the harness decides
 * how to do the work and reports its own findings to a human who reviews them. What
 * remains here is what the harness has no view of: run state, workspace layout, and
 * the boundaries that limit blast radius on a developer's machine.
 */
export type { RunStore, RunPatch, RunFilter, TaskAttemptOutcome } from './ports/run-store.js';
export { isTerminal, mayHoldProcesses } from './domain/run-status.js';
export { classifyAttempt, classifyFailure } from './domain/attempt-outcome.js';
export type { AttemptClassification, AttemptFailure } from './domain/attempt-outcome.js';
export { buildReproduceCard } from './domain/task-card.js';
export type { TaskCardInput } from './domain/task-card.js';
export { checkWriteBoundary, describeViolations, ALWAYS_FORBIDDEN } from './domain/write-boundary.js';
export type { WriteBoundary, BoundaryViolation } from './domain/write-boundary.js';
export { HarnessContractError } from './ports/harness.js';
export type { HarnessAdapter, HarnessRun, HarnessRunRequest } from './ports/harness.js';
export { WorkspaceError } from './ports/workspace.js';
export type { Workspace, WorkspaceManager, WorkspaceRequest } from './ports/workspace.js';
