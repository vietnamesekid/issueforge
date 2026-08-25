/**
 * All I/O lives here: harness processes, GitHub (gh), git workspaces, SQLite, logging.
 * Adapters implement ports declared by @issueforge/core.
 *
 * Boundary rule: harness adapters must not import the GitHub adapter, and vice versa.
 */
export * from './logger/index.js';
export * from './state/index.js';
export * from './process/index.js';
export * from './harness/index.js';
export * from './workspace/index.js';
export * from './runner/index.js';
export * from './validation/index.js';
export * from './github/index.js';
export * from './policy/index.js';
