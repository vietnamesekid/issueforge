import { z } from 'zod';

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
 * Intent labels applied by a maintainer.
 *
 * Status labels are OUTPUTS ONLY, never triggers: GitHub does not create workflow
 * runs from events triggered by GITHUB_TOKEN, so a label IssueForge writes can never
 * start the next stage. Every transition is driven by a human.
 */
export const INTENT_LABELS = {
  'issueforge:reproduce': 'reproduce',
  'issueforge:fix': 'fix',
  'issueforge:retry': 'retry',
  'issueforge:cancel': 'cancel',
} as const;

export const STATUS_LABELS = [
  'issueforge:queued',
  'issueforge:running',
  'issueforge:reproduced',
  'issueforge:cannot-reproduce',
  'issueforge:needs-info',
  'issueforge:fix-pr-open',
  'issueforge:verification-failed',
  'issueforge:ready-for-review',
  'issueforge:blocked',
  'issueforge:cancelled',
] as const;

export type GitHubIssueEvent = z.infer<typeof GitHubIssueEvent>;
export type IntentLabel = keyof typeof INTENT_LABELS;
export type StatusLabel = (typeof STATUS_LABELS)[number];
