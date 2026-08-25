import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  checkWriteBoundary,
  describeViolations,
  type BoundaryViolation,
  type WriteBoundary,
} from '@issueforge/core';

/**
 * Audits what a run actually wrote.
 *
 * The write boundary in `core` decides policy from a list of paths; this supplies the
 * list honestly, which is the harder half. Two details do the work:
 *
 *  - The inventory comes from `git status --porcelain`, not `git diff`. A reproduce
 *    task's output is a NEW file, and `diff` does not report untracked files at all —
 *    so a `diff`-based audit would miss exactly what a reproduce task produces.
 *  - Symlinks are resolved before the boundary sees them. A link inside `test/`
 *    pointing at `/etc/passwd` satisfies any path check while writing somewhere else
 *    entirely.
 */

export interface AuditResult {
  changedFiles: string[];
  violations: BoundaryViolation[];
}

export class WriteBoundaryError extends Error {
  readonly violations: readonly BoundaryViolation[];

  constructor(violations: readonly BoundaryViolation[]) {
    super(`the run wrote outside its permitted paths: ${describeViolations(violations)}`);
    this.name = 'WriteBoundaryError';
    this.violations = violations;
  }
}

/** Every path the run touched, including untracked files. */
export function changedFilesIn(cwd: string): string[] {
  // `--untracked-files=all` matters: by default git collapses an untracked directory
  // into a single `test/` entry, which would hide every file inside it from an audit
  // — and a new directory is exactly what a reproduce task creates.
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  });

  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    // Porcelain v1: two status characters, a space, then the path.
    .map((line) => line.slice(3).trim())
    // A rename reads as "old -> new"; the destination is what was written.
    .map((path) => (path.includes(' -> ') ? (path.split(' -> ')[1] ?? path) : path))
    .map(stripQuotes);
}

export function auditWorkspace(cwd: string, boundary: WriteBoundary): AuditResult {
  const changedFiles = changedFilesIn(cwd);
  const violations: BoundaryViolation[] = [];
  const inspected: string[] = [];

  for (const file of changedFiles) {
    const escaped = resolvesOutside(cwd, file);
    if (escaped) {
      // Reported against the declared path, since that is what a maintainer sees in
      // the diff — the resolved target is in the message, not the inventory.
      violations.push({ path: file, reason: 'escapes-workspace' });
      continue;
    }
    inspected.push(file);
  }

  violations.push(...checkWriteBoundary(inspected, boundary));
  return { changedFiles, violations };
}

/** Throw unless every write stayed inside the boundary. */
export function assertWithinBoundary(cwd: string, boundary: WriteBoundary): AuditResult {
  const result = auditWorkspace(cwd, boundary);
  if (result.violations.length > 0) throw new WriteBoundaryError(result.violations);
  return result;
}

/**
 * Whether a path leaves the workspace once symlinks are followed.
 *
 * Uses `lstat` first so the link itself is examined rather than its target, and
 * resolves the workspace root too — on macOS `/tmp` is itself a symlink, so comparing
 * an unresolved root against a resolved path reports every file as an escape.
 */
function resolvesOutside(cwd: string, file: string): boolean {
  const root = realpathSync(cwd);
  const path = join(root, file);

  if (!existsSync(path)) {
    // A deleted file cannot be a symlink escape; the boundary still judges its path.
    return false;
  }

  const target = lstatSync(path).isSymbolicLink() ? realpathSync(path) : resolve(path);
  const rel = relative(root, target);
  return rel.startsWith('..') || rel.startsWith('/');
}

/** git quotes paths containing unusual characters; the quotes are not part of the name. */
function stripQuotes(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}
