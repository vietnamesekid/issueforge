import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A repository with a real, subtle bug.
 *
 * `parsePair` splits on every `=`, so a value that itself contains one is truncated.
 * It is deliberately the kind of defect that looks fine at a glance and has a passing
 * test suite — a fixture whose bug is obvious would let a run pass by accident.
 */

export const BUGGY_SOURCE = `export function parsePair(s) {
  const [key, value] = s.split('=');
  return { key, value };
}
`;

export const FIXED_SOURCE = `export function parsePair(s) {
  const i = s.indexOf('=');
  return { key: s.slice(0, i), value: s.slice(i + 1) };
}
`;

/** A regression test that fails on the bug and passes once it is gone. */
export const GENUINE_REPRO = `import { test } from 'node:test';
import assert from 'node:assert';
import { parsePair } from '../src/parse.js';

test('a value containing "=" is not truncated', () => {
  assert.deepEqual(parsePair('url=http://x?a=1'), { key: 'url', value: 'http://x?a=1' });
});
`;

/** Fails for a reason that has nothing to do with the reported bug. */
export const UNRELATED_FAILURE = `import { test } from 'node:test';
import assert from 'node:assert';

test('unrelated', () => { assert.strictEqual(1, 2); });
`;

/** Cannot fail meaningfully: it asserts nothing. */
export const TRIVIAL_REPRO = `#!/bin/sh
exit 1
`;

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

/** Create an origin repository containing the bug. Returns the pinned base SHA. */
export function buildOrigin(path: string, source = BUGGY_SOURCE): string {
  mkdirSync(join(path, 'src'), { recursive: true });
  mkdirSync(join(path, 'test'), { recursive: true });

  writeFileSync(join(path, 'src', 'parse.js'), source);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  // A passing test, so the suite is green before the reproduction is added — the bug
  // is latent, exactly as a real one would be.
  writeFileSync(
    join(path, 'test', 'existing.test.js'),
    `import { test } from 'node:test';
import assert from 'node:assert';
import { parsePair } from '../src/parse.js';
test('simple pair', () => { assert.deepEqual(parsePair('a=1'), { key: 'a', value: '1' }); });
`,
  );

  execFileSync('git', ['init', '-q', path]);
  git(['config', 'user.email', 'fixture@example.com'], path);
  git(['config', 'user.name', 'fixture'], path);
  git(['add', '-A'], path);
  git(['commit', '-qm', 'initial'], path);

  return git(['rev-parse', 'HEAD'], path);
}
