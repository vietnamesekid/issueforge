/**
 * Shared vocabulary: schemas and types only. No behaviour, no I/O.
 * Everything else in the monorepo may depend on this; it depends on nothing.
 */

/** Lifecycle state of a single run. A union of literals, not a TS enum (erasableSyntaxOnly). */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'reproduced'
  | 'cannot-reproduce'
  | 'needs-info'
  | 'interrupted'
  | 'blocked'
  | 'cancelled';

/** Intent expressed by a maintainer applying a label. Status labels are outputs, never triggers. */
export type TaskIntent = 'reproduce' | 'fix' | 'retry' | 'cancel';

export const PACKAGE_NAME = '@issueforge/contracts';
