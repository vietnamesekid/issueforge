/**
 * Guards the invariants that only break once the package is PUBLISHED.
 *
 * Every bug this file exists for was invisible to the rest of the suite: the source
 * was correct, the tests were green, and the failure appeared only in the tarball a
 * user installs. `pnpm check` does not install anything, so nothing else here can
 * see them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const manifest: Record<string, unknown> = JSON.parse(
  readFileSync(join(ROOT, 'apps/cli/package.json'), 'utf8'),
) as Record<string, unknown>;

describe('published manifest', () => {
  it('is NOT private — `private: true` makes npm refuse to publish at all', () => {
    expect(manifest['private']).toBeUndefined();
  });

  it('carries the metadata npm renders on the package page', () => {
    // Without these the page shows no repository link, no licence and no way back
    // to the source. They are free to add and invisible until the page is live.
    for (const field of ['repository', 'license', 'homepage', 'bugs', 'description']) {
      expect(manifest[field], `missing "${field}"`).toBeDefined();
    }
  });

  it('ships the README and LICENSE, not just dist', () => {
    // The bug this test exists for: `files: ["dist"]` packed exactly two files, so
    // the npm page would have rendered no README at all — npm reads it from the
    // tarball, never from the git repository.
    const files = manifest['files'];
    expect(files).toContain('README.md');
    expect(files).toContain('LICENSE');
  });

  it('declares a bin path npm will not strip', () => {
    // The bug this test exists for: `"issueforge": "./dist/main.js"` is REMOVED by npm
    // at publish time ("bin[issueforge] script name was invalid and removed"), so the
    // package installs with no command at all. npm only accepts the unprefixed form.
    // A dry-run warning is easy to miss; the installed package is simply broken.
    const bin = (manifest['bin'] ?? {}) as Record<string, string>;
    for (const [name, path] of Object.entries(bin)) {
      expect(path, `bin "${name}" must not start with "./"`).not.toMatch(/^\.\//);
    }
  });

  it('does not ship the TypeScript build cache', () => {
    // tsconfig.tsbuildinfo lands in dist/ and added 84kB of incremental-build state to
    // the tarball — machine-specific, useless to a consumer, and pure download weight.
    const ignore = readFileSync(join(ROOT, 'apps/cli/.npmignore'), 'utf8');
    expect(ignore).toMatch(/tsbuildinfo/);
  });

  it('declares every workspace package as a devDependency', () => {
    // tsup bundles `@issueforge/*` via noExternal. A `workspace:*` range in
    // `dependencies` is unresolvable outside this monorepo, so npm would try to
    // fetch it and the install would fail — the one failure a local build cannot
    // reproduce.
    const deps = (manifest['dependencies'] ?? {}) as Record<string, string>;
    for (const [name, range] of Object.entries(deps)) {
      expect(range, `${name} must not use a workspace: range`).not.toMatch(/^workspace:/);
    }
  });
});

describe('build configuration', () => {
  const tsup = readFileSync(join(ROOT, 'apps/cli/tsup.config.ts'), 'utf8');

  it('keeps the CommonJS dependencies external', () => {
    // The bug this test exists for: bundling commander or pino into the ESM output
    // rewrites their internal require() into a stub, and the CLI dies at first run
    // with `Dynamic require of "events" is not supported`. Development never sees it
    // — `node src/main.ts` does not take the bundled path — so only the installed
    // binary is broken. Measured: bundling saves tens of KB gzipped and costs this.
    for (const cjs of ['pino', 'commander']) {
      expect(tsup, `${cjs} must stay external`).toMatch(
        new RegExp(`external:[^\\]]*'${cjs}'`),
      );
    }
  });

  it('does not minify — stack traces are the product here', () => {
    // Minifying shrinks the bundle ~42% and renames every frame in a stack trace.
    // This CLI reports its own failures to users, and tsup, vitest and prisma all
    // ship unminified for the same reason.
    expect(tsup).not.toMatch(/minify:\s*true/);
  });
});

describe('release workflow', () => {
  it('publishes with a provenance attestation', () => {
    // Provenance needs `id-token: write`; without it the publish still succeeds but
    // silently ships no attestation, and npm shows no Provenance panel. The failure
    // is invisible until someone looks at the package page.
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(release).toMatch(/id-token:\s*write/);
    expect(release).toMatch(/--provenance/);
  });
});

describe('version', () => {
  it('matches the constant the CLI reports for --version', () => {
    // The bug this test exists for: VERSION is a hand-written constant in main.ts,
    // so a release that bumps only package.json ships a binary that reports the
    // OLD number — and the version a user pastes into a bug report is the wrong one.
    const main = readFileSync(join(ROOT, 'apps/cli/src/main.ts'), 'utf8');
    const found = /const VERSION = '([^']+)'/.exec(main);
    expect(found?.[1]).toBe(manifest['version']);
  });

  it('is no longer the 0.0.0 placeholder', () => {
    expect(manifest['version']).not.toBe('0.0.0');
  });
});
