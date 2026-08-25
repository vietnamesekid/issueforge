import type { AppContext } from '../context.js';

/** A run, as `issueforge status` reports it. */
export interface StatusRow {
  runId: string;
  repo: string;
  issue: number;
  task: string;
  status: string;
  detail: string;
  updatedAt: string;
}

/**
 * Recent runs, newest first.
 *
 * Reads only the ledger. A run whose supervisor was killed still appears here with
 * whatever state it reached, which is the point of writing transitions before their
 * side effects.
 */
export function collectStatus(context: AppContext, limit = 20): StatusRow[] {
  return context.store.listRuns({ limit }).map((run) => ({
    runId: run.id,
    repo: run.repo,
    issue: run.issueNumber,
    task: run.task,
    status: run.status,
    detail: run.detail ?? '',
    updatedAt: new Date(run.updatedAt).toISOString(),
  }));
}

export function renderStatusTable(rows: readonly StatusRow[]): string {
  if (rows.length === 0) return 'No runs yet.';

  return rows
    .map((row) => `${row.status.padEnd(17)} #${String(row.issue).padEnd(6)} ${row.runId}  ${row.detail}`)
    .join('\n');
}
