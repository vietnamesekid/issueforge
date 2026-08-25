import type { RepoSlug, Sha, TaskKind } from '@issueforge/contracts';

/**
 * Where a task's code lives while it runs.
 *
 * Two properties matter and they are not the same thing:
 *
 *  - **Isolation** — a task sees only its own working files. A git worktree gives
 *    this, and is cheap.
 *  - **Independence** — a task cannot be influenced by another task's writes.
 *    A worktree does NOT give this: siblings share one object store and ref
 *    namespace, so a branch created in one is instantly visible from another.
 *
 * Verification needs independence, because "IssueForge replays the evidence itself"
 * is only true if the replay cannot read what the run being checked wrote. So verify
 * gets its own clone while reproduce and fix get worktrees.
 */
export interface WorkspaceManager {
  /**
   * A workspace for a task, pinned to an exact commit.
   *
   * Reproduce and fix share a mirror; verify is cloned separately. Callers do not
   * choose — the boundary is a property of the task, not of the caller.
   */
  create(request: WorkspaceRequest): Promise<Workspace>;

  /** Remove a workspace and its git bookkeeping. Safe to call twice. */
  remove(workspace: Workspace): Promise<void>;

  /** Remove every workspace for an issue, e.g. once it reaches a terminal state. */
  removeAll(repo: RepoSlug, issueNumber: number): Promise<void>;
}

export interface WorkspaceRequest {
  repo: RepoSlug;
  issueNumber: number;
  task: TaskKind;
  /** Remote to clone from. Never a path inside the user's own working repository. */
  remote: string;
  /** The exact commit to pin to. Runs never track a moving ref. */
  baseSha: Sha;
  /** For verify: the branch to check out instead of `baseSha`. */
  branch?: string;
}

export interface Workspace {
  repo: RepoSlug;
  issueNumber: number;
  task: TaskKind;
  /** Absolute path the harness runs in. */
  path: string;
  baseSha: Sha;
  /**
   * How this workspace was created.
   *
   * `worktree` shares an object store with its siblings; `clone` does not. Recorded
   * so cleanup knows what to undo and so an independence claim can be checked.
   */
  kind: 'worktree' | 'clone';
}

/** The workspace could not be created, or was created without the isolation it claims. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
