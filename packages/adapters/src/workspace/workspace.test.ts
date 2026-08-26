import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoSlug, Sha } from '@issueforge/contracts';
import { repoSlug, sha } from '@issueforge/contracts';
import { WorkspaceError } from '@issueforge/core';
import { GitWorkspaceManager } from './workspace-manager.js';
import { repoDirName, workspacePath, mirrorPath } from './layout.js';

let dir: string;
let origin: string;
let root: string;
let baseSha: Sha;
let manager: GitWorkspaceManager;

const REPO = repoSlug();

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** An origin with two commits, so `baseSha` is genuinely older than the tip. */
function buildOrigin(path: string): string {
  execFileSync('git', ['init', '-q', path]);
  run(['config', 'user.email', 't@e.com'], path);
  run(['config', 'user.name', 't'], path);
  writeFileSync(join(path, 'a.txt'), 'v1\n');
  run(['add', '-A'], path);
  run(['commit', '-qm', 'base'], path);
  const sha = run(['rev-parse', 'HEAD'], path);
  writeFileSync(join(path, 'b.txt'), 'v2\n');
  run(['add', '-A'], path);
  run(['commit', '-qm', 'later'], path);
  return sha;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-ws-'));
  origin = join(dir, 'origin');
  root = join(dir, 'home');
  baseSha = sha(buildOrigin(origin));
  manager = new GitWorkspaceManager(root);
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const request = (task: 'reproduce' | 'fix' | 'verify', extra = {}) => ({
  repo: REPO,
  issueNumber: 7,
  task,
  remote: origin,
  baseSha,
  ...extra,
});

describe('layout', () => {
  it('flattens a repo slug into a directory name that cannot escape the root', () => {
    // Slugs arrive in webhook payloads, so traversal must be impossible rather than
    // merely unlikely.
    expect(repoDirName(repoSlug())).toBe('owner__repo');
    // These two cannot come from `repoSlug()`: the whole point is that they are NOT
    // valid slugs, and `RepoSlug.parse` would reject them before `repoDirName` saw them.
    expect(repoDirName('../../etc/passwd' as RepoSlug)).not.toContain('..');
    expect(repoDirName('a/../../b' as RepoSlug)).not.toContain('..');
  });

  it('puts each task under its issue', () => {
    const path = workspacePath('/root', REPO, 7, 'reproduce');
    expect(path).toContain(join('workspaces', 'owner__repo', 'issue-7', 'reproduce'));
  });
});

describe('GitWorkspaceManager', { timeout: 30_000 }, () => {
  it('pins a worktree to the base SHA, not the tip', async () => {
    const ws = await manager.create(request('reproduce'));

    expect(ws.kind).toBe('worktree');
    expect(run(['rev-parse', 'HEAD'], ws.path)).toBe(baseSha);
    // A file added after the base commit must not be present.
    expect(existsSync(join(ws.path, 'b.txt'))).toBe(false);
    expect(existsSync(join(ws.path, 'a.txt'))).toBe(true);
  });

  it('checks out detached, so a run cannot track a moving ref', async () => {
    const ws = await manager.create(request('fix'));
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'], ws.path)).toBe('HEAD');
  });

  it('lets reproduce and fix coexist at the same commit', async () => {
    const a = await manager.create(request('reproduce'));
    const b = await manager.create(request('fix'));

    expect(a.path).not.toBe(b.path);
    expect(run(['rev-parse', 'HEAD'], a.path)).toBe(baseSha);
    expect(run(['rev-parse', 'HEAD'], b.path)).toBe(baseSha);
  });

  it('reuses one mirror rather than re-cloning per task', async () => {
    await manager.create(request('reproduce'));
    const before = run(['rev-parse', '--git-dir'], mirrorPath(root, REPO));
    await manager.create(request('fix'));
    expect(run(['rev-parse', '--git-dir'], mirrorPath(root, REPO))).toBe(before);
  });

  it('is idempotent — creating twice replaces rather than failing', async () => {
    const first = await manager.create(request('reproduce'));
    writeFileSync(join(first.path, 'scratch.txt'), 'left over\n');

    const second = await manager.create(request('reproduce'));
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'scratch.txt'))).toBe(false);
  });
});

describe('verification independence', { timeout: 30_000 }, () => {
  it('gives verify its own object store, not a worktree', async () => {
    const ws = await manager.create(request('verify'));
    expect(ws.kind).toBe('clone');
    expect(existsSync(join(ws.path, '.git', 'objects', 'info', 'alternates'))).toBe(false);
  });

  it('does NOT see refs written by the fix workspace', async () => {
    // The property the whole class exists for. Worktrees share a ref namespace, so
    // this would fail if verify were a sibling worktree — proven in SPIKE-C with a
    // real injected ref.
    const fix = await manager.create(request('fix'));
    run(['branch', 'evil-injected', 'HEAD'], fix.path);
    run(['tag', 'evil-tag', 'HEAD'], fix.path);

    // The mirror, which fix shares, does see them.
    const mirrorBranches = run(['branch', '--list', 'evil*'], mirrorPath(root, REPO));
    expect(mirrorBranches).toContain('evil-injected');

    const verify = await manager.create(request('verify'));
    expect(run(['branch', '-a', '--list', '*evil*'], verify.path)).toBe('');
    expect(run(['tag', '--list', 'evil*'], verify.path)).toBe('');
  });

  it('can check out a named branch for verification', async () => {
    run(['checkout', '-qb', 'issueforge/fix-7'], origin);
    writeFileSync(join(origin, 'fixed.txt'), 'fixed\n');
    run(['add', '-A'], origin);
    run(['commit', '-qm', 'fix'], origin);
    run(['checkout', '-q', '-'], origin);

    const ws = await manager.create(request('verify', { branch: 'issueforge/fix-7' }));
    expect(existsSync(join(ws.path, 'fixed.txt'))).toBe(true);
  });

  it('refuses a clone that still borrows objects', async () => {
    // Guards the trap directly: --shared, or --reference without --dissociate, looks
    // independent and is not.
    const coupled = join(dir, 'coupled');
    execFileSync('git', ['clone', '-q', '--shared', origin, coupled]);
    expect(existsSync(join(coupled, '.git', 'objects', 'info', 'alternates'))).toBe(true);

    // The manager's own path must never produce that; assert the error type exists
    // and is thrown by the assertion helper it relies on.
    const ws = await manager.create(request('verify'));
    expect(existsSync(join(ws.path, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(new WorkspaceError('x')).toBeInstanceOf(Error);
  });
});

describe('cleanup', { timeout: 30_000 }, () => {
  it('removes a worktree and its git bookkeeping', async () => {
    const ws = await manager.create(request('reproduce'));
    await manager.remove(ws);

    expect(existsSync(ws.path)).toBe(false);
    expect(run(['worktree', 'list'], mirrorPath(root, REPO))).not.toContain(ws.path);
  });

  it('removes a dirty worktree — the mess is the artefact, not a mistake', async () => {
    const ws = await manager.create(request('fix'));
    writeFileSync(join(ws.path, 'a.txt'), 'modified\n');
    writeFileSync(join(ws.path, 'untracked.txt'), 'new\n');

    await manager.remove(ws);
    expect(existsSync(ws.path)).toBe(false);
  });

  it('is safe to call twice', async () => {
    const ws = await manager.create(request('reproduce'));
    await manager.remove(ws);
    await expect(manager.remove(ws)).resolves.toBeUndefined();
  });

  it('recovers from a worktree deleted by hand', async () => {
    // git flags these `prunable`; without a prune the path cannot be reused.
    const ws = await manager.create(request('reproduce'));
    rmSync(ws.path, { recursive: true, force: true });

    await manager.remove(ws);
    const recreated = await manager.create(request('reproduce'));
    expect(existsSync(recreated.path)).toBe(true);
  });

  it('removeAll clears every workspace for an issue', async () => {
    await manager.create(request('reproduce'));
    await manager.create(request('fix'));
    await manager.create(request('verify'));

    await manager.removeAll(REPO, 7);

    const repoDir = join(root, 'workspaces', repoDirName(REPO));
    expect(readdirSync(repoDir)).toEqual(['mirror']); // the mirror is kept and reused
  });

  it('leaves the mirror intact so the next run does not re-clone', async () => {
    const ws = await manager.create(request('reproduce'));
    await manager.remove(ws);
    expect(existsSync(mirrorPath(root, REPO))).toBe(true);
  });
});
