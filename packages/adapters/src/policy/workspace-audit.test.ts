import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWithinBoundary, auditWorkspace, changedFilesIn, WriteBoundaryError } from './index.js';

let dir: string;
let repo: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-audit-'));
  repo = join(dir, 'repo');
  outside = join(dir, 'outside');

  mkdirSync(repo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'do not touch\n');

  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const allow = (...allowedPaths: string[]) => ({ allowedPaths });

describe('changedFilesIn', () => {
  it('lists files inside a NEW directory, not the directory itself', () => {
    // git collapses an untracked directory into one entry by default, which would
    // hide every file inside it — and a new directory is what a reproduce task makes.
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'a.test.js'), 'x');
    writeFileSync(join(repo, 'test', 'b.test.js'), 'y');

    expect(changedFilesIn(repo).sort()).toEqual(['test/a.test.js', 'test/b.test.js']);
  });

  it('reports modified tracked files', () => {
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect(changedFilesIn(repo)).toEqual(['README.md']);
  });

  it('reports the destination of a rename, which is what was written', () => {
    execFileSync('git', ['mv', 'README.md', 'DOCS.md'], { cwd: repo });
    expect(changedFilesIn(repo)).toContain('DOCS.md');
  });

  it('reports nothing for a clean workspace', () => {
    expect(changedFilesIn(repo)).toEqual([]);
  });
});

describe('auditWorkspace', () => {
  it('accepts a run that stayed inside its allowed paths', () => {
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'repro.test.js'), 'x');

    expect(auditWorkspace(repo, allow('test/**')).violations).toEqual([]);
  });

  it('rejects a write outside the allowed paths', () => {
    writeFileSync(join(repo, 'src.js'), 'x');
    const { violations } = auditWorkspace(repo, allow('test/**'));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('not-allowed');
  });

  it('REFUSES a symlink pointing outside the workspace', () => {
    // The obvious way around a path check: the link satisfies `test/**` while
    // writing somewhere else entirely.
    mkdirSync(join(repo, 'test'));
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'test', 'innocent.js'));

    const { violations } = auditWorkspace(repo, allow('test/**'));
    expect(violations).toEqual([{ path: 'test/innocent.js', reason: 'escapes-workspace' }]);
  });

  it('allows a symlink that stays inside the workspace', () => {
    // Not every link is an escape; refusing them all would be a different bug.
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'real.js'), 'x');
    symlinkSync(join(repo, 'test', 'real.js'), join(repo, 'test', 'alias.js'));

    expect(auditWorkspace(repo, allow('test/**')).violations).toEqual([]);
  });

  it('blocks .github even when everything is allowed', () => {
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: x\n');

    expect(auditWorkspace(repo, allow('**')).violations[0]?.reason).toBe('forbidden');
  });

  it('does not trip over a deleted file', () => {
    // A deletion cannot be a symlink escape, and the path is still judged normally.
    rmSync(join(repo, 'README.md'));
    const { violations } = auditWorkspace(repo, allow('**'));
    expect(violations).toEqual([]);
  });
});

describe('assertWithinBoundary', () => {
  it('passes silently for a compliant run', () => {
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'a.js'), 'x');

    expect(() => assertWithinBoundary(repo, allow('test/**'))).not.toThrow();
  });

  it('throws with every offending path named, so one re-run is enough', () => {
    writeFileSync(join(repo, 'a.js'), 'x');
    writeFileSync(join(repo, 'b.js'), 'y');

    try {
      assertWithinBoundary(repo, allow('test/**'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WriteBoundaryError);
      expect((error as WriteBoundaryError).violations).toHaveLength(2);
      expect((error as Error).message).toContain('a.js');
      expect((error as Error).message).toContain('b.js');
    }
  });
});
