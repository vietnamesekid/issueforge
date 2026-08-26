import { z } from 'zod';
import { Verdict } from './common.js';

/**
 * The subset of the `issues.labeled` webhook payload IssueForge actually reads,
 * as delivered at `$GITHUB_EVENT_PATH`.
 *
 * Deliberately permissive about everything else: GitHub adds fields over time and an
 * unknown field must never fail a run.
 */

export const GitHubIssueEvent = z
  .object({
    action: z.literal('labeled'),
    issue: z
      .object({
        number: z.number().int().positive(),
        /** UNTRUSTED — anyone can open an issue. */
        title: z.string(),
        /** UNTRUSTED. GitHub sends null for an empty body. */
        body: z.string().nullable().default(''),
        labels: z.array(z.object({ name: z.string() }).loose()).default([]),
      })
      .loose(),
    label: z.object({ name: z.string() }).loose(),
    repository: z
      .object({
        full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        default_branch: z.string().default('main'),
      })
      .loose(),
    sender: z.object({ login: z.string() }).loose(),
  })
  .loose();

/**
 * Intent labels applied by a maintainer. These are the only labels IssueForge reads.
 *
 * There is no matching set of status labels, because IssueForge does not write labels:
 * the harness reports its findings to the issue itself. Even if it did, a label written
 * with GITHUB_TOKEN cannot start the next stage — GitHub does not create workflow runs
 * from GITHUB_TOKEN events — so every transition is driven by a human either way.
 */
export const INTENT_LABELS = {
  'issueforge:reproduce': 'reproduce',
  'issueforge:fix': 'fix',
  'issueforge:retry': 'retry',
  'issueforge:cancel': 'cancel',
} as const;


/**
 * The label a run leaves behind, naming its outcome.
 *
 * Derived from `Verdict` rather than hand-listed: the verdict vocabulary has been
 * copied by hand before and drifted, and a label nobody creates is a label the agent
 * cannot apply.
 *
 * These are written by the HARNESS, not by IssueForge — the same principle as the
 * harness writing its own comment: it knows what it did. What they buy is a maintainer
 * being able to see, and filter, a run's outcome from the issue list without opening
 * the Actions tab. Vercel drives 4,213 issues this way.
 */
export const outcomeLabel = (verdict: Verdict): string => `issueforge:${verdict}`;

/** Every label `issueforge init` should create in a repository. */
export const ALL_LABELS: readonly string[] = [
  ...Object.keys(INTENT_LABELS),
  ...Verdict.options.map(outcomeLabel),
];

export type GitHubIssueEvent = z.infer<typeof GitHubIssueEvent>;
export type IntentLabel = keyof typeof INTENT_LABELS;
