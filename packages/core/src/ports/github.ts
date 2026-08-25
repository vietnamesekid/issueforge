import type { IssueKey } from '@issueforge/contracts';

/**
 * Writes status back to GitHub.
 *
 * Narrow on purpose: IssueForge posts a verdict and a short account of how it was
 * reached. It does not manage the issue — no assignees, no reactions, no closing —
 * because those are a maintainer's decisions, not a supervisor's.
 */
export interface GitHubWriter {
  /**
   * Replace IssueForge's own status labels with `label`, leaving every other label
   * on the issue untouched.
   */
  setStatusLabel(issue: IssueKey, label: string): Promise<void>;

  /**
   * Post or update IssueForge's status comment.
   *
   * One comment per issue, updated in place. Re-running a transition must not add
   * another comment — a maintainer reading the issue should see the current state,
   * not a transcript of every attempt.
   */
  upsertComment(issue: IssueKey, body: string): Promise<void>;

  /** Create any status label that does not exist yet, so applying one cannot fail. */
  ensureLabels(issue: IssueKey, labels: readonly string[]): Promise<void>;
}
