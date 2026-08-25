import { describe, it, expect } from 'vitest';
import { ALWAYS_FORBIDDEN, checkWriteBoundary, describeViolations } from './write-boundary.js';

const allow = (...allowedPaths: string[]) => ({ allowedPaths });

describe('glob matching', () => {
  it('matches a single segment with *', () => {
    expect(checkWriteBoundary(['test/a.js'], allow('test/*'))).toEqual([]);
    // `*` must not cross a separator, or `test/*` would not be a boundary at all.
    expect(checkWriteBoundary(['test/deep/a.js'], allow('test/*'))).toHaveLength(1);
  });

  it('matches any depth with **, including none', () => {
    expect(checkWriteBoundary(['test/a.js'], allow('test/**'))).toEqual([]);
    expect(checkWriteBoundary(['test/deep/nested/a.js'], allow('test/**'))).toEqual([]);
    expect(checkWriteBoundary(['a.js'], allow('**'))).toEqual([]);
  });

  it('treats a dot as a literal, not a regex metacharacter', () => {
    // A regex-by-string-replacement matcher would let `axjs` match `a.js`.
    expect(checkWriteBoundary(['axjs'], allow('a.js'))).toHaveLength(1);
    expect(checkWriteBoundary(['a.js'], allow('a.js'))).toEqual([]);
  });

  it('treats regex metacharacters in a path as literals', () => {
    expect(checkWriteBoundary(['test/a+b.js'], allow('test/**'))).toEqual([]);
    expect(checkWriteBoundary(['test/(x).js'], allow('test/**'))).toEqual([]);
  });

  it('matches a suffix pattern within one segment', () => {
    expect(checkWriteBoundary(['test/a.test.js'], allow('test/*.test.js'))).toEqual([]);
    expect(checkWriteBoundary(['test/a.spec.js'], allow('test/*.test.js'))).toHaveLength(1);
  });

  it('normalises a leading ./ rather than treating it as a new segment', () => {
    expect(checkWriteBoundary(['./test/a.js'], allow('test/**'))).toEqual([]);
  });
});

describe('checkWriteBoundary', () => {
  it('accepts a change set entirely within the allowed paths', () => {
    expect(checkWriteBoundary(['test/repro.test.js'], allow('test/**'))).toEqual([]);
  });

  it('rejects a write outside the allowed paths', () => {
    const violations = checkWriteBoundary(['src/index.js'], allow('test/**'));
    expect(violations).toEqual([{ path: 'src/index.js', reason: 'not-allowed' }]);
  });

  it('blocks .github even when the configuration allows everything', () => {
    // This is how a run would rewrite the workflow that runs it, so no configuration
    // may permit it — forbidden has to win over allowed.
    const violations = checkWriteBoundary(['.github/workflows/ci.yml'], allow('**'));
    expect(violations).toEqual([{ path: '.github/workflows/ci.yml', reason: 'forbidden' }]);
  });

  it('blocks .git even when the configuration allows everything', () => {
    // Rewriting history would undermine the verifier that depends on it.
    expect(checkWriteBoundary(['.git/config'], allow('**'))[0]?.reason).toBe('forbidden');
  });

  it('blocks credential files anywhere in the tree', () => {
    for (const path of ['.env', 'packages/app/.env', 'keys/id_rsa', 'deploy/server.pem', '.npmrc']) {
      expect(checkWriteBoundary([path], allow('**')), path).toHaveLength(1);
    }
  });

  it('refuses a path that climbs out of the workspace', () => {
    // No allow-list entry can make `../` legitimate.
    expect(checkWriteBoundary(['../outside.txt'], allow('**'))).toEqual([
      { path: '../outside.txt', reason: 'escapes-workspace' },
    ]);
  });

  it('refuses an absolute path', () => {
    expect(checkWriteBoundary(['/etc/passwd'], allow('**'))[0]?.reason).toBe('escapes-workspace');
  });

  it('honours extra forbidden paths from configuration', () => {
    const violations = checkWriteBoundary(['infra/main.tf'], {
      allowedPaths: ['**'],
      forbiddenPaths: ['infra/**'],
    });
    expect(violations[0]?.reason).toBe('forbidden');
  });

  it('reports every violation, not just the first', () => {
    // A maintainer fixing one path should not have to re-run to discover the next.
    const violations = checkWriteBoundary(
      ['test/ok.js', 'src/bad.js', '.github/worse.yml'],
      allow('test/**'),
    );
    expect(violations.map((v) => v.path)).toEqual(['src/bad.js', '.github/worse.yml']);
  });

  it('describes violations in terms a maintainer can act on', () => {
    const text = describeViolations(checkWriteBoundary(['.github/ci.yml'], allow('**')));
    expect(text).toContain('.github/ci.yml');
    expect(text).toContain('forbidden path');
  });

  it('always-forbidden list covers the paths that matter', () => {
    expect(ALWAYS_FORBIDDEN).toContain('.github/**');
    expect(ALWAYS_FORBIDDEN).toContain('.git/**');
  });
});
