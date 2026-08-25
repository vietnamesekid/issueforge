/**
 * All I/O lives here: harness processes, GitHub (gh), git workspaces, SQLite, logging.
 * Adapters implement ports declared by @issueforge/core.
 *
 * Boundary rule: harness adapters must not import the GitHub adapter, and vice versa.
 */
export * from './logger/index.js';
export * from './state/index.js';
