import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listenerPath,
  listenerStatus,
  renderListenerInstructions,
  uninstallListener,
  listenerDeletionTargets,
  ensureListenerDir,
} from './listener.js';

/**
 * A real directory rather than a filesystem fake: every function here is a thin
 * layer over `fs`, so a fake would only assert that the mock was called and would
 * miss the one thing that matters — `uninstallListener` deletes recursively.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'issueforge-listener-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An installed-and-registered listener: config.sh plus the .runner GitHub writes. */
function installListener(): string {
  const path = ensureListenerDir(root);
  writeFileSync(join(path, 'config.sh'), '#!/bin/sh\n');
  writeFileSync(join(path, '.runner'), '{}');
  return path;
}

describe('listenerStatus', () => {
  it('reports absent when nothing is installed', () => {
    const status = listenerStatus(root);
    expect(status.installed).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.path).toBe(join(root, 'listener'));
  });

  it('separates installed from configured', () => {
    // The distinction is the whole point of the two flags: the runner binary can be
    // unpacked without ever being registered against a repository, and a user in
    // that state needs to be told to register rather than to install again.
    const path = ensureListenerDir(root);
    writeFileSync(join(path, 'config.sh'), '#!/bin/sh\n');

    expect(listenerStatus(root)).toMatchObject({ installed: true, configured: false });

    writeFileSync(join(path, '.runner'), '{}');
    expect(listenerStatus(root)).toMatchObject({ installed: true, configured: true });
  });
});

describe('renderListenerInstructions', () => {
  it('names the path the commands will actually use', () => {
    const text = renderListenerInstructions('owner/repo', root);
    expect(text).toContain(listenerPath(root));
  });

  it('tells the user to register it themselves', () => {
    // Registration needs a short-lived token only a repository admin can mint, and
    // acquiring one quietly on someone's behalf would be the wrong default for a
    // tool that runs code on their machine. The instructions must say so rather
    // than looking like a step IssueForge forgot to automate.
    const text = renderListenerInstructions('owner/repo', root);
    expect(text).toContain('owner/repo');
    expect(text).toMatch(/config\.sh/);
  });
});

describe('listenerDeletionTargets', () => {
  it('lists nothing when there is nothing to delete', () => {
    expect(listenerDeletionTargets(root)).toEqual([]);
  });

  it('shows what would be removed BEFORE anything is removed', () => {
    const path = installListener();
    const targets = listenerDeletionTargets(root);

    expect(targets[0]).toBe(path);
    expect(targets.join('\n')).toContain('config.sh');
    // Listing must not be destructive — a user asking "what would this delete?"
    // has not yet agreed to delete it.
    expect(existsSync(path)).toBe(true);
  });

  it('caps the listing rather than printing a whole runner install', () => {
    // A configured runner directory holds hundreds of files; dumping them all
    // buries the answer to the question being asked.
    const path = ensureListenerDir(root);
    for (let i = 0; i < 20; i++) writeFileSync(join(path, `file-${i}`), '');

    // The path itself, plus at most 8 entries.
    expect(listenerDeletionTargets(root).length).toBeLessThanOrEqual(9);
  });
});

describe('uninstallListener', () => {
  it('says so plainly when there is nothing to remove', () => {
    expect(uninstallListener(undefined, root)).toEqual(['nothing to remove']);
  });

  it('removes the directory and everything under it', () => {
    const path = installListener();
    mkdirSync(join(path, 'work', 'nested'), { recursive: true });
    writeFileSync(join(path, 'work', 'nested', 'deep.txt'), 'x');

    const done = uninstallListener(undefined, root);

    expect(existsSync(path)).toBe(false);
    expect(done.join('\n')).toContain(path);
  });

  it('leaves the rest of the IssueForge home alone', () => {
    // listenerPath is a subdirectory of the home that also holds the run ledger and
    // the workspaces. Removing the listener must not take those with it.
    installListener();
    writeFileSync(join(root, 'runs.db'), 'ledger');
    mkdirSync(join(root, 'workspaces'), { recursive: true });

    uninstallListener(undefined, root);

    expect(readdirSync(root).sort()).toEqual(['runs.db', 'workspaces']);
  });

  it('does not try to unregister when no repo is given', () => {
    // Passing no repo is the "just delete the files" path. It must not reach for
    // `gh`, which would fail or prompt on a machine that has no credentials.
    const path = installListener();
    const done = uninstallListener(undefined, root);

    expect(done.join('\n')).not.toMatch(/unregister/);
    expect(existsSync(path)).toBe(false);
  });
});

describe('ensureListenerDir', () => {
  it('is idempotent', () => {
    const first = ensureListenerDir(root);
    const second = ensureListenerDir(root);
    expect(second).toBe(first);
    expect(existsSync(first)).toBe(true);
  });
});
