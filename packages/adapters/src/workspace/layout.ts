import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RepoSlug, TaskKind } from '@issueforge/contracts';

/**
 * Where local state lives. Pure, so paths can be asserted without touching disk.
 *
 * Everything is under one root, which is what makes `issueforge uninstall` able to
 * name exactly what it will delete.
 */

export function defaultRoot(): string {
  return process.env['ISSUEFORGE_HOME'] ?? join(homedir(), '.issueforge');
}

/**
 * `owner/repo` flattened for use as a directory name.
 *
 * A slug is attacker-influenced — it arrives in a webhook payload — so this must not
 * be able to escape the root. Anything outside a conservative character set is
 * replaced rather than passed through, and `..` cannot survive it.
 */
export function repoDirName(repo: RepoSlug): string {
  return repo.replace(/[^\w.-]+/g, '__').replace(/\.{2,}/g, '_');
}

export function repoRoot(root: string, repo: RepoSlug): string {
  return join(root, 'workspaces', repoDirName(repo));
}

/** The shared object store worktrees are cut from. One per repository. */
export function mirrorPath(root: string, repo: RepoSlug): string {
  return join(repoRoot(root, repo), 'mirror');
}

export function issueRoot(root: string, repo: RepoSlug, issueNumber: number): string {
  return join(repoRoot(root, repo), `issue-${issueNumber}`);
}

export function workspacePath(
  root: string,
  repo: RepoSlug,
  issueNumber: number,
  task: TaskKind,
): string {
  return join(issueRoot(root, repo, issueNumber), task);
}

export function runsRoot(root: string): string {
  return join(root, 'runs');
}

export function runPath(root: string, runId: string): string {
  return join(runsRoot(root), runId);
}

export function statePath(root: string): string {
  return join(root, 'state.db');
}
