import { RepoSlug, RunId, Sha } from './common.js';

/**
 * Constructors for branded identifiers in tests.
 *
 * The brands exist so a `RunId` cannot be passed where a `Sha` belongs. That guarantee
 * costs something at every fixture, because a branded value can only come from
 * `.parse()` — and a test that writes `RunId.parse('run_a1b2c3')` fifty times is noisy
 * without being any safer.
 *
 * These keep the parse (so a malformed fixture still fails loudly, which has caught
 * real typos) while reading like the literal it replaces.
 *
 * Exported from the package root deliberately: they are only useful in tests, but
 * putting them behind a separate entry point would mean a second build target for four
 * one-line functions.
 */

/** `runId('a1b2c3')` → `run_a1b2c3`. Accepts a full id too. */
export function runId(suffix = 'a1b2c3'): RunId {
  return RunId.parse(suffix.startsWith('run_') ? suffix : `run_${suffix}`);
}

/** A valid 40-character SHA made of one repeated hex character. */
export function sha(fill = 'a'): Sha {
  return Sha.parse(fill.length === 40 ? fill : fill.repeat(40));
}

/** `repoSlug()` → `owner/repo`. */
export function repoSlug(slug = 'owner/repo'): RepoSlug {
  return RepoSlug.parse(slug);
}
