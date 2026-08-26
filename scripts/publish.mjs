/**
 * Publishes with an explicit dist-tag derived from the version itself.
 *
 * `changeset publish` will not do this. In prerelease mode it publishes to the
 * prerelease tag "except for packages that have not had normal releases, which will
 * be published to latest" — its own warning, observed on a real run: 0.1.0-alpha.3
 * went to `latest` while `alpha` stayed on alpha.2, the exact inversion the
 * prerelease setup exists to prevent. `publishConfig.tag` does not override it.
 *
 * The rule here is mechanical instead: anything with a hyphen in its version is a
 * prerelease (0.1.0-alpha.3) and gets that identifier as its tag; anything else is
 * stable and gets `latest`. That holds on a package with no stable release yet,
 * which is the case changesets gets wrong.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = new URL('../apps/cli/package.json', import.meta.url);
const { version, name } = JSON.parse(readFileSync(manifest, 'utf8'));

// 0.1.0-alpha.3 -> "alpha"; 1.2.3 -> undefined
const preId = /-([a-z][a-z0-9]*)\./.exec(version)?.[1];
const tag = preId ?? 'latest';

// Publishing an already-published version is not a failure worth breaking the run
// over: it happens whenever a release re-runs with no new changeset.
const published = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim() || null;

if (published) {
  process.stdout.write(`${name}@${version} is already published; nothing to do\n`);
  process.exit(0);
}

process.stdout.write(`publishing ${name}@${version} under dist-tag "${tag}"\n`);

execFileSync('npm', ['publish', '--provenance', '--tag', tag], {
  cwd: new URL('../apps/cli/', import.meta.url),
  stdio: 'inherit',
});
