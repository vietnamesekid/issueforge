import type { RunStatus, ValidationOutcome, Verdict } from '@issueforge/contracts';

/**
 * Turns a run's outcome into what a maintainer sees on the issue.
 *
 * Pure, so the wording can be reviewed and tested without touching GitHub.
 *
 * Two rules shape everything here. The comment reports **what IssueForge observed**,
 * never what the harness asserted — a claim that was rejected must not read as though
 * it were a finding. And nothing local leaks: paths, environment and transcripts stay
 * on the machine, so the comment carries a run id and a verdict, not a debug dump.
 */

/** Status labels IssueForge owns. Applying one removes the others. */
export const STATUS_LABELS = {
  queued: 'issueforge:queued',
  running: 'issueforge:running',
  reproduced: 'issueforge:reproduced',
  'cannot-reproduce': 'issueforge:cannot-reproduce',
  'needs-info': 'issueforge:needs-info',
  blocked: 'issueforge:blocked',
  cancelled: 'issueforge:cancelled',
  interrupted: 'issueforge:needs-info',
} as const satisfies Record<RunStatus, string>;

export const ALL_STATUS_LABELS: readonly string[] = [...new Set(Object.values(STATUS_LABELS))];

/** Identifies IssueForge's own comment so it can be updated rather than duplicated. */
export const COMMENT_MARKER = '<!-- issueforge:status -->';

export function statusLabelFor(status: RunStatus): string {
  return STATUS_LABELS[status];
}

export interface StatusReport {
  runId: string;
  status: RunStatus;
  detail: string;
  /** Present once evidence has been replayed. */
  validation?: ValidationOutcome;
  /** Set when the agent reported the issue text trying to give it instructions. */
  injectionSuspected?: boolean;
  costUsd?: number;
}

/** Headline for each verdict, phrased as an observation rather than a claim. */
const VERDICT_HEADLINE: Record<Verdict, string> = {
  reproduced: '✅ Reproduced — the reported failure was observed on a pinned checkout.',
  'cannot-reproduce':
    '❌ Could not reproduce — the evidence provided did not demonstrate the reported failure.',
  'needs-info': '⚠️ Needs more information before this can be reproduced.',
};

const STATUS_HEADLINE: Partial<Record<RunStatus, string>> = {
  blocked: '⛔ Blocked — the run could not be carried out safely, so nothing was concluded.',
  cancelled: '🚫 Cancelled.',
  interrupted: '⚠️ Interrupted before finishing.',
  running: '⏳ Running.',
  queued: '⏳ Queued.',
};

export function renderStatusComment(report: StatusReport): string {
  const lines: string[] = [COMMENT_MARKER, ''];

  lines.push(`**${headline(report)}**`, '');

  if (report.validation !== undefined) {
    lines.push(report.validation.why, '');
    lines.push(...renderChecks(report.validation));
  } else if (report.detail.length > 0) {
    lines.push(report.detail, '');
  }

  if (report.injectionSuspected === true) {
    // Worth surfacing: it tells a maintainer the issue text tried to steer the agent,
    // which is a fact about the report, not about the code.
    lines.push(
      '> ⚠️ The issue text appears to contain instructions aimed at the agent. ' +
        'They were treated as data and not followed.',
      '',
    );
  }

  lines.push(footer(report));
  return lines.join('\n');
}

function headline(report: StatusReport): string {
  // The validated verdict wins: a harness claim that replay rejected must never be
  // reported as though it had been accepted.
  if (report.validation !== undefined) return VERDICT_HEADLINE[report.validation.verdict];
  return STATUS_HEADLINE[report.status] ?? report.detail;
}

/**
 * The checks that were run, so the verdict can be argued with.
 *
 * A verdict nobody can inspect is just another claim — the point of replaying
 * evidence is lost if the reasoning stays private.
 */
function renderChecks(validation: ValidationOutcome): string[] {
  if (validation.evidence.checks.length === 0) return [];

  const rows = validation.evidence.checks.map((check) => {
    const mark = check.passed ? '✅' : '❌';
    const detail = check.detail.length > 0 ? ` — ${check.detail}` : '';
    return `| ${mark} | \`${check.step}\`${detail} |`;
  });

  return ['<details><summary>Checks performed</summary>', '', '| | Check |', '| --- | --- |', ...rows, '', '</details>', ''];
}

function footer(report: StatusReport): string {
  const parts = [`run \`${report.runId}\``];
  if (report.costUsd !== undefined) parts.push(`$${report.costUsd.toFixed(2)}`);
  // Everything else — transcripts, patches, paths — stays local by design.
  return `<sub>${parts.join(' · ')} · evidence kept locally</sub>`;
}
