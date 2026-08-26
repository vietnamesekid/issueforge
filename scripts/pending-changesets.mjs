/**
 * Prints `found=true|false` for the release workflow's cheap pre-flight check.
 *
 * The workflow is chained to CI, so it cannot use `paths: ['.changeset/**']` the way
 * vercel/ai does — `paths` belongs to `push`, not `workflow_run`. This is the
 * equivalent: decide whether there is anything to release before installing a
 * toolchain to find out.
 *
 * A consumed changeset must not count as pending. Changesets has moved that
 * bookkeeping twice, and this script has to survive both shapes because the
 * repository's history contains both:
 *
 *  - CLI v2 left the applied file in `.changeset/` and recorded its NAME in
 *    `pre.json.changesets`. A naive count of `.changeset/*.md` therefore reported
 *    pending work forever — observed here, where one consumed changeset made the
 *    count say "true" while `changeset status` reported nothing to bump.
 *  - CLI v3 dropped that field and MOVES the applied file into `.changeset/pre/`
 *    instead. Nothing is left at the top level to miscount, but the v2 field is gone,
 *    so logic reading it silently degrades to "nothing consumed" — correct only
 *    because there is also nothing left to filter.
 *
 * Reading only top-level `*.md` is what makes both true: v3's `pre/` is a directory
 * and never matches, and the v2 filter still applies when the field is present.
 */
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../.changeset/', import.meta.url);

/**
 * Names already applied by a previous `changeset version`.
 *
 * Empty under CLI v3, which has no such field — there the files themselves have
 * moved out of the way, so there is nothing to exclude.
 */
function consumed() {
  try {
    const pre = JSON.parse(readFileSync(new URL('pre.json', dir), 'utf8'));
    return new Set(pre.changesets ?? []);
  } catch {
    // Not in prerelease mode, or no pre.json yet: nothing has been consumed.
    return new Set();
  }
}

const applied = consumed();

const pending = readdirSync(dir, { withFileTypes: true }).filter(
  (entry) =>
    entry.isFile() &&
    entry.name.endsWith('.md') &&
    entry.name !== 'README.md' &&
    !applied.has(entry.name.replace(/\.md$/, '')),
);

process.stdout.write(`found=${pending.length > 0 ? 'true' : 'false'}\n`);
