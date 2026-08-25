import { z } from 'zod';
import { Argv, Sha } from './common.js';

/**
 * Evidence is what IssueForge OBSERVED, as distinct from what the harness claimed.
 * Only this decides a state transition.
 */

/** One execution IssueForge performed itself. */
export const ReplayObservation = z.object({
  command: Argv,
  exitCode: z.number().int(),
  /** Combined stdout+stderr, truncated for storage. */
  output: z.string().default(''),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean().default(false),
});

/**
 * The seven-step validation ladder, cheapest check first.
 *
 * Order matters: each step costs more than the last, and steps 5 and 7 are the two
 * that actually decide. Both were proven necessary:
 *  - step 4 exists because a repro script containing only `exit 1` initially passed;
 *  - step 7 exists because "the command failed" is weak evidence — a genuine
 *    reproduction must also PASS once the bug is removed, which is the only way to
 *    catch a failure that is real but unrelated to the reported defect.
 */
export const ValidationStep = z.enum([
  'claim-structure',
  'artifacts-exist',
  'base-sha-matches',
  'artifacts-assert-something',
  'replay-fails-on-base',
  'failure-is-not-environmental',
  'differential-passes-after-fix',
]);

export const ValidationCheck = z.object({
  step: ValidationStep,
  passed: z.boolean(),
  /** Human-readable reason, surfaced in the GitHub comment when it decides the outcome. */
  detail: z.string().default(''),
});

export const Evidence = z.object({
  baseSha: Sha,
  /** Every file the harness touched — from `git status --porcelain`, which unlike
   *  `git diff` also reports untracked files. A reproduce task creates exactly those. */
  changedFiles: z.array(z.string().min(1)).default([]),
  /** Unified diff of the staged change set, stored locally as the patch artifact. */
  patch: z.string().optional(),
  /** Replay on the pinned base SHA. Must fail for a reproduction to be real. */
  baseReplay: ReplayObservation.optional(),
  /** Replay after the defect is removed. Must pass — this is the differential check. */
  postFixReplay: ReplayObservation.optional(),
  checks: z.array(ValidationCheck).default([]),
});

/** The verdict IssueForge reached, which may contradict the harness's claim. */
export const ValidationOutcome = z.object({
  verdict: z.enum(['reproduced', 'cannot-reproduce', 'needs-info']),
  /** The check that decided it. */
  why: z.string().min(1),
  evidence: Evidence,
});

export type ReplayObservation = z.infer<typeof ReplayObservation>;
export type ValidationStep = z.infer<typeof ValidationStep>;
export type ValidationCheck = z.infer<typeof ValidationCheck>;
export type Evidence = z.infer<typeof Evidence>;
export type ValidationOutcome = z.infer<typeof ValidationOutcome>;
