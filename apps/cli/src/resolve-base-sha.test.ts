import { describe, it, expect } from 'vitest';
import { resolveBaseSha } from './main.js';

/**
 * The first thing a new user hits when they mistype a repository name.
 *
 * Reaching a real remote is the point: the failure being tested is git's, and a fake
 * would assert only that the fake was called.
 */
describe('resolveBaseSha', () => {
  it('explains an unreachable repository instead of echoing git', () => {
    // The bug this test exists for: git wrote its own "Repository not found" to the
    // terminal AND execFileSync threw "Command failed: git ls-remote <url> HEAD", so
    // the user saw five lines, the same message twice, an internal command line, and
    // nothing telling them what to check.
    let message = '';
    try {
      resolveBaseSha('issueforge-does-not-exist-xyz/nope', 'HEAD');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('issueforge-does-not-exist-xyz/nope');
    expect(message).toMatch(/gh auth status/);
    // The internals must not be the interface.
    expect(message).not.toMatch(/Command failed/);
    expect(message).not.toMatch(/ls-remote/);
  }, 30_000);
});
