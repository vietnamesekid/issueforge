/**
 * Prints `found=true|false` for the release workflow's cheap pre-flight check.
 *
 * The workflow is chained to CI, so it cannot use `paths: ['.changeset/**']` the way
 * vercel/ai does — `paths` belongs to `push`, not `workflow_run`. This is the
 * equivalent: decide whether there is anything to release before installing a
 * toolchain to find out.
 *
 * Counting `.changeset/*.md` is NOT equivalent. In prerelease mode `changeset
 * version` leaves the consumed file on disk and records its name in pre.json, so a
 * naive count reports pending work forever — observed on this repo, where one
 * consumed changeset made the count say "true" while `changeset status` reported
 * nothing to bump.
 */
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../.changeset/', import.meta.url);

/** Names already applied by a previous `changeset version`, in prerelease mode. */
function consumed() {
  try {
    return new Set(JSON.parse(readFileSync(new URL('pre.json', dir), 'utf8')).changesets);
  } catch {
    // Not in prerelease mode, or no pre.json yet: nothing has been consumed.
    return new Set();
  }
}

const applied = consumed();

const pending = readdirSync(dir).filter(
  (f) => f.endsWith('.md') && f !== 'README.md' && !applied.has(f.replace(/\.md$/, '')),
);

process.stdout.write(`found=${pending.length > 0 ? 'true' : 'false'}\n`);
