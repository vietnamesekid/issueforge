import { z } from 'zod';

/**
 * Primitives shared across every contract.
 *
 * All enumerations are `z.enum` over string literals rather than TypeScript enums,
 * which `erasableSyntaxOnly` bans (and which would break the build-free dev loop).
 */

/** A full 40-character git object id. Runs pin an exact commit, never a ref. */
export const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'expected a full 40-character git SHA');

/** Identifier for one local run, e.g. `run_a1b2c3`. */
export const RunId = z.string().regex(/^run_[0-9a-z]{6,}$/, 'expected a run id like "run_a1b2c3"');

/** `owner/repo`, as GitHub spells it. */
export const RepoSlug = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"');

/**
 * A command as an ARGV ARRAY — never a shell string.
 *
 * Two independent reasons this type exists:
 *  1. Security: issue text reaches commands as data. Passing argv with `shell: false`
 *     neutralises `$(...)`, backticks and `;` in a hostile issue body.
 *  2. Reality: a real agent returned its repro command as a single space-joined
 *     string ("node --test test/x.js"). Adapters must normalise to argv before the
 *     validator sees it; the validator never assumes it was given argv already.
 */
export const Argv = z.array(z.string().min(1)).min(1, 'expected a non-empty argv array');

/** Lifecycle state of a run. */
export const RunStatus = z.enum([
  'queued',
  'running',
  'reproduced',
  'cannot-reproduce',
  'needs-info',
  'interrupted',
  'blocked',
  'cancelled',
]);

/** What a maintainer asked for by applying a label. Status labels are outputs, never triggers. */
export const TaskIntent = z.enum(['reproduce', 'fix', 'retry', 'cancel']);

/** The three task contracts. Each has different inputs, write boundaries and expected artifacts. */
export const TaskKind = z.enum(['reproduce', 'fix', 'verify']);

/** Which harness executed a run. */
export const HarnessName = z.enum(['claude-code', 'codex']);

export type Sha = z.infer<typeof Sha>;
export type RunId = z.infer<typeof RunId>;
export type RepoSlug = z.infer<typeof RepoSlug>;
export type Argv = z.infer<typeof Argv>;
export type RunStatus = z.infer<typeof RunStatus>;
export type TaskIntent = z.infer<typeof TaskIntent>;
export type TaskKind = z.infer<typeof TaskKind>;
export type HarnessName = z.infer<typeof HarnessName>;
