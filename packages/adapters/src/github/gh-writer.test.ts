import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMENT_MARKER } from '@issueforge/core';
import { GhWriter } from './gh-writer.js';

let dir: string;
let callLog: string;
const originalPath = process.env['PATH'];

const ISSUE = { repo: 'owner/repo', issueNumber: 7 };

/**
 * Put a fake `gh` first on PATH.
 *
 * It records every invocation's argv, one per line, so the argv contract can be
 * asserted exactly — which matters because these arguments carry attacker-authored
 * text and must never reach a shell.
 */
function fakeGh(stdout = ''): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callLog)}\ncat <<'STDOUT'\n${stdout}\nSTDOUT\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
}

const calls = (): string[] =>
  existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-gh-'));
  callLog = join(dir, 'calls.log');
});

afterEach(() => {
  process.env['PATH'] = originalPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('GhWriter', { timeout: 20_000 }, () => {
  it('applies a status label and removes the others in one call', async () => {
    // One call, so the issue never passes through a state with no status label.
    fakeGh();
    await new GhWriter('owner/repo').setStatusLabel(ISSUE, 'issueforge:reproduced');

    expect(calls()).toHaveLength(1);
    const call = calls()[0] as string;
    expect(call).toContain('--add-label issueforge:reproduced');
    expect(call).toContain('--remove-label issueforge:needs-info');
    expect(call).toContain('--remove-label issueforge:blocked');
    // The label being applied must not also be removed.
    expect(call).not.toContain('--remove-label issueforge:reproduced');
  });

  it('creates labels idempotently, so a first run and a hundredth behave alike', async () => {
    fakeGh();
    await new GhWriter('owner/repo').ensureLabels(ISSUE, ['issueforge:queued', 'issueforge:running']);

    expect(calls()).toHaveLength(2);
    expect(calls().every((c) => c.includes('--force'))).toBe(true);
  });

  it('posts a new comment via a file, never as an argument', async () => {
    // A comment body carries rendered issue content; a leak there would be permanent
    // and public, and argv is where shell metacharacters would matter.
    fakeGh('');
    await new GhWriter('owner/repo').upsertComment(ISSUE, `${COMMENT_MARKER}\nhello`);

    const post = calls().find((c) => c.includes('issue comment'));
    expect(post).toBeDefined();
    expect(post).toContain('--body-file');
    expect(post).not.toContain('hello');
  });

  it('updates its own comment instead of adding another', async () => {
    // A maintainer should see the current state, not a transcript of every attempt.
    fakeGh(JSON.stringify({ id: 12345, body: `${COMMENT_MARKER}\nold` }));
    await new GhWriter('owner/repo').upsertComment(ISSUE, `${COMMENT_MARKER}\nnew`);

    const update = calls().find((c) => c.includes('PATCH'));
    expect(update).toBeDefined();
    expect(update).toContain('issues/comments/12345');
    expect(calls().some((c) => c.includes('issue comment'))).toBe(false);
  });

  it('ignores comments that are not its own', async () => {
    // Matching on the marker, not the author, so a shared account still gets one
    // comment updated rather than one per run.
    fakeGh(JSON.stringify({ id: 999, body: 'a human wrote this' }));
    await new GhWriter('owner/repo').upsertComment(ISSUE, `${COMMENT_MARKER}\nnew`);

    expect(calls().some((c) => c.includes('issue comment'))).toBe(true);
    expect(calls().some((c) => c.includes('PATCH'))).toBe(false);
  });

  it('survives unparseable lines in the comment listing', async () => {
    fakeGh('not json\n' + JSON.stringify({ id: 42, body: COMMENT_MARKER }));
    await new GhWriter('owner/repo').upsertComment(ISSUE, `${COMMENT_MARKER}\nnew`);

    expect(calls().find((c) => c.includes('PATCH'))).toContain('issues/comments/42');
  });

  it('does not leave the comment body on disk', async () => {
    fakeGh('');
    await new GhWriter('owner/repo').upsertComment(ISSUE, `${COMMENT_MARKER}\nsecret-ish content`);

    const bodyFile = calls()
      .find((c) => c.includes('--body-file'))
      ?.split('--body-file ')[1]
      ?.trim();
    expect(bodyFile).toBeDefined();
    expect(existsSync(bodyFile as string)).toBe(false);
  });

  it('reports a gh failure rather than continuing silently', async () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "HTTP 403: Forbidden" >&2\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    process.env['PATH'] = `${bin}:${originalPath ?? ''}`;

    await expect(
      new GhWriter('owner/repo').setStatusLabel(ISSUE, 'issueforge:reproduced'),
    ).rejects.toThrow(/403/);
  });
});
