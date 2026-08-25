import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sha } from '@issueforge/contracts';
import { validateReproduction } from '@issueforge/core';
import { ProcessReplayer } from './process-replayer.js';
import { FileDefectToggle } from './git-defect-toggle.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-val-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const BASE = 'a'.repeat(40) as Sha;

/** The fixture from SPIKE-D: parsePair truncates values containing '='. */
const BUGGY = `export function parsePair(s){const [k,v]=s.split('=');return {key:k,value:v};}\n`;
const FIXED = `export function parsePair(s){const i=s.indexOf('=');return {key:s.slice(0,i),value:s.slice(i+1)};}\n`;
const REGRESSION_TEST = `
import { test } from 'node:test';
import assert from 'node:assert';
import { parsePair } from '../src/parse.js';
test('value containing = is not truncated', () => {
  assert.deepEqual(parsePair('url=http://x?a=1'), { key: 'url', value: 'http://x?a=1' });
});
`;

function buildFixture(): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'src', 'parse.js'), BUGGY);
  writeFileSync(join(dir, 'test', 'repro.test.js'), REGRESSION_TEST);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f', type: 'module' }));
}

const validate = (claim: Record<string, unknown>, defect?: FileDefectToggle) =>
  validateReproduction({
    claim: claim as never,
    cwd: dir,
    baseSha: BASE,
    headSha: BASE,
    changedFiles: ['test/repro.test.js'],
    readArtifact: (path) => {
      try { return readFileSync(join(dir, path), 'utf8'); } catch { return null; }
    },
    replayer: new ProcessReplayer(),
    timeoutMs: 30_000,
    ...(defect !== undefined ? { defect } : {}),
  });

describe('ProcessReplayer', { timeout: 30_000 }, () => {
  it('reports a failing command without interpreting it', async () => {
    const observation = await new ProcessReplayer().run(['sh', '-c', 'echo boom >&2; exit 3'], {
      cwd: dir,
    });

    expect(observation.exitCode).toBe(3);
    expect(observation.output).toContain('boom');
    expect(observation.timedOut).toBe(false);
    expect(observation.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('enforces a timeout the command cannot opt out of', async () => {
    const observation = await new ProcessReplayer().run(['sh', '-c', 'sleep 30'], {
      cwd: dir,
      timeoutMs: 700,
    });

    expect(observation.timedOut).toBe(true);
    // -1, not 0: a process that never exited normally must not read as success.
    expect(observation.exitCode).toBe(-1);
  });

  it('does not interpret shell metacharacters in the command', async () => {
    // Replay runs agent-written code responding to attacker-authored text.
    const observation = await new ProcessReplayer().run(
      ['echo', '$(touch /tmp/if-replay-pwned)'],
      { cwd: dir },
    );
    expect(observation.output).toContain('$(touch');
  });
});

describe('end to end against a real bug', { timeout: 60_000 }, () => {
  beforeEach(buildFixture);

  it('confirms a genuine reproduction, and the differential proves it discriminates', async () => {
    const outcome = await validate(
      {
        verdict: 'reproduced',
        reproCommand: ['node', '--test', 'test/repro.test.js'],
        testFile: 'test/repro.test.js',
        summary: 'parsePair truncates values containing =',
      },
      new FileDefectToggle(new Map([['src/parse.js', FIXED]])),
    );

    expect(outcome.verdict).toBe('reproduced');
    expect(outcome.evidence.baseReplay?.exitCode).not.toBe(0); // fails with the bug
    expect(outcome.evidence.postFixReplay?.exitCode).toBe(0);  // passes without it

    // The workspace is the evidence, so the defect must be back afterwards.
    expect(readFileSync(join(dir, 'src', 'parse.js'), 'utf8')).toBe(BUGGY);
  });

  it('REJECTS the same claim when the bug is not actually present', async () => {
    // The adversarial case from SPIKE-D: a real agent's claim, but the code is fine.
    writeFileSync(join(dir, 'src', 'parse.js'), FIXED);

    const outcome = await validate({
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'claims a bug that is already fixed',
    });

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/PASSED on the pinned base/);
  });

  it('REJECTS a failure that has nothing to do with the reported bug', async () => {
    // Fails for real, and keeps failing once the defect is gone. Only the
    // differential separates this from a genuine reproduction.
    writeFileSync(
      join(dir, 'test', 'repro.test.js'),
      `
import { test } from 'node:test';
import assert from 'node:assert';
test('unrelated', () => { assert.strictEqual(1, 2); });
`,
    );

    const outcome = await validate(
      {
        verdict: 'reproduced',
        reproCommand: ['node', '--test', 'test/repro.test.js'],
        testFile: 'test/repro.test.js',
        summary: 'unrelated failure',
      },
      new FileDefectToggle(new Map([['src/parse.js', FIXED]])),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/does not isolate the reported bug/);
  });

  it('REJECTS a repro script that only exits non-zero', async () => {
    writeFileSync(join(dir, 'repro.sh'), '#!/bin/sh\nexit 1\n');
    execFileSync('chmod', ['+x', join(dir, 'repro.sh')]);

    const outcome = await validate({
      verdict: 'reproduced',
      reproCommand: ['sh', './repro.sh'],
      summary: 'lazy repro',
    });

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/does nothing but exit/);
  });
});

describe('FileDefectToggle', () => {
  beforeEach(buildFixture);

  it('applies and reverts exactly', async () => {
    const toggle = new FileDefectToggle(new Map([['src/parse.js', FIXED]]));

    await toggle.applyFix(dir);
    expect(readFileSync(join(dir, 'src', 'parse.js'), 'utf8')).toBe(FIXED);

    await toggle.revertFix(dir);
    expect(readFileSync(join(dir, 'src', 'parse.js'), 'utf8')).toBe(BUGGY);
  });
});
