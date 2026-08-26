import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RepoSlug } from '@issueforge/contracts';
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceManager,
  type WorkspaceRequest,
} from '@issueforge/core';
import { git, gitSucceeds } from './git.js';
import { defaultRoot, issueRoot, mirrorPath, workspacePath } from './layout.js';

/**
 * Creates and destroys task workspaces.
 *
 * Reproduce and fix run in worktrees cut from a shared mirror — cheap, and isolation
 * of working files is all they need from each other.
 *
 * Verify gets its own clone. That is the whole point of the class: worktrees share an
 * object store and ref namespace, so a fix run can write refs the verifier would then
 * read. "IssueForge replays the evidence independently" is only true if the replay
 * cannot see what the run under scrutiny wrote.
 */
export class GitWorkspaceManager implements WorkspaceManager {
  readonly #root: string;

  constructor(root: string = defaultRoot()) {
    this.#root = root;
  }

  async create(request: WorkspaceRequest): Promise<Workspace> {
    const path = workspacePath(this.#root, request.repo, request.issueNumber, request.task);

    // Clear any previous workspace at this path, including git's bookkeeping.
    // Removing the directory alone is not enough: git still believes the worktree
    // exists (it flags it `prunable`) and refuses to register a new one there, so a
    // retried run would fail on a path it is entitled to reuse.
    await this.#discardExisting(request, path);
    await mkdir(dirname(path), { recursive: true });

    const kind = request.task === 'verify' ? 'clone' : 'worktree';
    if (kind === 'clone') {
      await this.#createVerifyClone(request, path);
    } else {
      await this.#createWorktree(request, path);
    }

    return {
      repo: request.repo,
      issueNumber: request.issueNumber,
      task: request.task,
      path,
      baseSha: request.baseSha,
      kind,
    };
  }

  async remove(workspace: Workspace): Promise<void> {
    if (workspace.kind === 'worktree') {
      const mirror = mirrorPath(this.#root, workspace.repo);
      // --force because the harness leaves the tree dirty by design; that is the
      // artefact, not a mistake. A live process holding an open file does not block
      // removal on POSIX, though it would on Windows.
      await gitSucceeds(['worktree', 'remove', '--force', workspace.path], { cwd: mirror });
      // Clears bookkeeping for a directory that is already gone — including one a
      // user deleted by hand, which git flags as `prunable`.
      await gitSucceeds(['worktree', 'prune'], { cwd: mirror });
    }

    await rm(workspace.path, { recursive: true, force: true });
  }

  async removeAll(repo: RepoSlug, issueNumber: number): Promise<void> {
    const root = issueRoot(this.#root, repo, issueNumber);
    const mirror = mirrorPath(this.#root, repo);

    for (const task of ['reproduce', 'fix', 'verify'] as const) {
      await gitSucceeds(['worktree', 'remove', '--force', join(root, task)], { cwd: mirror });
    }
    await gitSucceeds(['worktree', 'prune'], { cwd: mirror });
    await rm(root, { recursive: true, force: true });
  }

  /**
   * Remove whatever occupies `path`, so creating is always safe to repeat.
   *
   * Tolerant by design: the mirror may not exist yet, and the path may be a stale
   * registration, a live worktree, a plain directory, or nothing at all.
   */
  async #discardExisting(request: WorkspaceRequest, path: string): Promise<void> {
    const mirror = mirrorPath(this.#root, request.repo);
    if (existsSync(mirror)) {
      await gitSucceeds(['worktree', 'remove', '--force', path], { cwd: mirror });
      await gitSucceeds(['worktree', 'prune'], { cwd: mirror });
    }
    await rm(path, { recursive: true, force: true });
  }

  /**
   * A worktree pinned to an exact commit, in detached HEAD.
   *
   * Detached on purpose: a run must never track a moving ref, and must never leave a
   * branch behind that a later run could inherit.
   */
  async #createWorktree(request: WorkspaceRequest, path: string): Promise<void> {
    const mirror = await this.#ensureMirror(request);
    await git(['worktree', 'add', '--detach', path, request.baseSha], { cwd: mirror });
  }

  /**
   * An independent clone for verification.
   *
   * `--reference` borrows objects from the local mirror so this is nearly as fast as
   * a worktree; `--dissociate` then copies what is needed and severs the link.
   *
   * ⚠️ `--shared`, or `--reference` without `--dissociate`, leaves the clone
   * permanently coupled to the mirror while looking independent — which is exactly
   * the failure this class exists to prevent. Hence the assertion below.
   */
  async #createVerifyClone(request: WorkspaceRequest, path: string): Promise<void> {
    const mirror = await this.#ensureMirror(request);

    const args = ['clone', '--reference', mirror, '--dissociate'];
    if (request.branch !== undefined) args.push('--branch', request.branch);
    args.push(request.remote, path);

    await git(args);
    assertIndependent(path);

    // Pin even when a branch was named: the branch may have moved since the fix ran.
    if (request.branch === undefined) {
      await git(['checkout', '--detach', request.baseSha], { cwd: path });
    }
  }

  /**
   * The per-repository mirror, created on first use.
   *
   * Cloned from the remote, never from a repository the user works in: pinning a base
   * SHA inside their checkout would detach their HEAD and carry their uncommitted
   * work across, and a harness running there would see all their private branches.
   */
  async #ensureMirror(request: WorkspaceRequest): Promise<string> {
    const mirror = mirrorPath(this.#root, request.repo);

    if (!existsSync(join(mirror, '.git')) && !existsSync(join(mirror, 'HEAD'))) {
      await mkdir(dirname(mirror), { recursive: true });
      await git(['clone', '--no-checkout', request.remote, mirror]);
    }

    // The pinned commit may post-date the mirror. Fetching by SHA keeps a run from
    // failing merely because the local copy is stale.
    if (!(await gitSucceeds(['cat-file', '-e', `${request.baseSha}^{commit}`], { cwd: mirror }))) {
      await git(['fetch', '--quiet', 'origin', request.baseSha], { cwd: mirror });
    }

    return mirror;
  }
}

/**
 * Verify a clone really has its own object store.
 *
 * One cheap mechanical check, because the failure it catches is silent: a coupled
 * clone behaves identically until the day a fix run writes something the verifier
 * then reads and trusts.
 */
function assertIndependent(path: string): void {
  const alternates = join(path, '.git', 'objects', 'info', 'alternates');
  if (existsSync(alternates)) {
    throw new WorkspaceError(
      `verify clone at ${path} still borrows objects from another repository ` +
        `(${alternates} exists); it is not independent and must not be used to verify a fix`,
    );
  }
}
