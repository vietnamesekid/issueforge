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

  it('publishes to npmjs, using the registry API host', () => {
    // Two ways to get this wrong, both of which publish somewhere nobody installs
    // from: the package's WEB url (npmjs.com/package/...), which is not an API
    // endpoint at all, and npm.pkg.github.com, which is GitHub Packages — a
    // different registry that also requires a scoped name and does not accept the
    // npmjs OIDC trusted publisher this repo is set up with.
    const config = (manifest['publishConfig'] ?? {}) as Record<string, string>;
    const registry = config['registry'];
    if (registry !== undefined) {
      expect(registry).toMatch(/^https:\/\/registry\.npmjs\.org\/?$/);
    }
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
  const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }).scripts;

  it('builds before publishing', () => {
    // The bug this test exists for: an earlier workflow reached `pnpm build` only
    // through `prepublishOnly`, three scripts deep. A fresh clone has no dist/, and
    // `files` limits the tarball to dist/, so if that chain broke npm would publish
    // a package whose bin points at a file that does not exist — it installs fine
    // and then cannot run at all. `ci:release` now builds explicitly.
    const ciRelease = scripts['ci:release'] ?? '';
    expect(ciRelease).toMatch(/pnpm build/);
    expect(ciRelease.indexOf('pnpm build')).toBeLessThan(ciRelease.indexOf('publish.mjs'));
  });

  it('does not count a consumed changeset as pending work', () => {
    // The bug this test exists for: in prerelease mode `changeset version` leaves the
    // applied file on disk and records it in pre.json, so counting .changeset/*.md
    // reports pending work forever. Observed here — one consumed changeset made a
    // naive count say "true" while `changeset status` said there was nothing to bump,
    // which would wake the release job on every push it was meant to skip.
    const gate = readFileSync(join(ROOT, 'scripts/pending-changesets.mjs'), 'utf8');
    expect(gate).toMatch(/pre\.json/);
    expect(gate).toMatch(/applied\.has/);
  });

  it('only releases a commit whose CI went green', () => {
    // The gate is no longer a step inside this workflow — it is CI, which this run
    // is chained to. That is only safe if the conclusion is actually checked: a
    // `workflow_run` trigger fires on FAILURE too, so without this condition a red
    // build would publish. Manual dispatch has no upstream run, so it is exempt.
    expect(release).toMatch(/workflow_run:/);
    expect(release).toMatch(/workflow_run\.conclusion == 'success'/);
  });

  it('versions the commit CI tested, not the branch tip', () => {
    // `workflow_run` checks out the default branch by default, not the commit that
    // triggered it. Without an explicit ref, a push landing mid-run would be
    // versioned and published having never been tested.
    expect(release).toMatch(/workflow_run\.head_sha/);
  });

  it('lints the tarball npm will actually publish', () => {
    // publint packs the real thing and checks bin paths, exports and layout — the
    // only gate that would have caught a bin npm silently strips.
    expect(scripts['check']).toMatch(/publint/);
  });

  it('derives the dist-tag from the version, never from changesets', () => {
    // The bug this test exists for: `changeset publish` in prerelease mode publishes
    // to the prerelease tag "except for packages that have not had normal releases,
    // which will be published to latest" — its own warning, observed on a real run.
    // 0.1.0-alpha.3 landed on `latest` while `alpha` stayed on alpha.2: the exact
    // inversion prerelease mode exists to prevent, on a bare `npm i -g issueforge`.
    // publishConfig.tag does not override it, so publishing goes through a script
    // that passes --tag explicitly.
    expect(scripts['ci:release']).toMatch(/scripts\/publish\.mjs/);
    expect(scripts['ci:release'], 'changeset publish picks the wrong tag here').not.toMatch(
      /changeset publish/,
    );

    const publish = readFileSync(join(ROOT, 'scripts/publish.mjs'), 'utf8');
    expect(publish).toMatch(/'--tag', tag/);
  });

  it('publishes with a provenance attestation', () => {
    // Provenance needs `id-token: write`; without it the publish still succeeds but
    // silently ships no attestation, invisible until someone opens the package page.
    expect(release).toMatch(/id-token:\s*write/);
    const publish = readFileSync(join(ROOT, 'scripts/publish.mjs'), 'utf8');
    expect(publish).toMatch(/--provenance/);
  });

  it('never publishes from a fork', () => {
    // A fork has no npm identity; running there fails in a way a contributor cannot
    // fix, and the noise trains people to ignore red builds.
    expect(release).toMatch(/github\.repository == 'vietnamesekid\/issueforge'/);
  });
});

describe('README claims', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('quotes no test count that a single commit would falsify', () => {
    // The bug this test exists for: the README said "292 tests" while the suite had
    // grown to 299. A hardcoded count is stale the moment anyone adds a test, and a
    // README that is wrong about something checkable is worse than one that omits
    // it — a reader who catches it stops trusting the rest.
    expect(readme).not.toMatch(/\b\d{2,}\s+tests\b/);
  });

  it('does not claim there is only one published version', () => {
    // Written when alpha.1 was the only release, and false from alpha.2 onward.
    expect(readme).not.toMatch(/the only published version/);
  });

  it('points its install instructions at the alpha tag', () => {
    // A bare `npm install -g issueforge` resolves to a prerelease until a stable
    // release exists; the documented command has to name the tag.
    expect(readme).toMatch(/npm install -g issueforge@alpha/);
  });
});

describe('version', () => {
  it('is injected from the manifest at build time, never hand-written', () => {
    // The bug this test exists for: VERSION used to be a hand-written constant, so a
    // release that bumped only package.json shipped a binary reporting the OLD
    // number. `changeset version` edits the manifest and nothing else, which would
    // make that drift automatic. tsup now substitutes the value via `define`.
    const main = readFileSync(join(ROOT, 'apps/cli/src/main.ts'), 'utf8');
    const tsup = readFileSync(join(ROOT, 'apps/cli/tsup.config.ts'), 'utf8');

    expect(main).toMatch(/__ISSUEFORGE_VERSION__/);
    expect(tsup).toMatch(/define:\s*\{\s*__ISSUEFORGE_VERSION__/);
    // A literal semver assigned to VERSION means someone reintroduced the constant.
    expect(main).not.toMatch(/const VERSION = '\d+\.\d+\.\d+/);
  });

  it('reports the manifest version from the BUILT binary', () => {
    // Reads the artifact rather than the source: the substitution happens at build
    // time, so only the bundle can prove it actually took effect.
    const bundle = readFileSync(join(ROOT, 'apps/cli/dist/main.js'), 'utf8');
    expect(bundle).toContain(`"${String(manifest['version'])}"`);
    expect(bundle, 'define did not substitute').not.toMatch(/__ISSUEFORGE_VERSION__/);
  });

  it('is no longer the 0.0.0 placeholder', () => {
    expect(manifest['version']).not.toBe('0.0.0');
  });
});
