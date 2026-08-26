import type { RunStatus } from '@issueforge/contracts';
import { displayWidth, fit, oneLine, padTo } from '../ui/terminal-text.js';
import { createTheme, styleStatus, type Theme } from '../ui/theme.js';
import type { AppContext } from '../context.js';

/** A run, as `issueforge status` reports it. */
export interface StatusRow {
  runId: string;
  repo: string;
  issue: number;
  task: string;
  status: RunStatus;
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

export interface RenderStatusOptions {
  theme?: Theme;
  /**
   * Terminal width, so the detail column can use whatever is left.
   *
   * Passed in rather than read from `process.stdout` here: Node types `columns` as
   * always present when it is genuinely absent for a pipe, and a renderer that reads
   * global state is a renderer a test cannot pin down.
   */
  columns?: number;
}

/**
 * The run table.
 *
 * Columns are sized from the widest value actually present rather than from a constant,
 * so a long run id or an unusually long status does not push everything after it out of
 * alignment.
 *
 * Two things here are correctness rather than looks:
 *
 *  - Widths are MEASURED (`displayWidth`), not `.length`. `padEnd` counts UTF-16 units,
 *    so a CJK repo name or an emoji in a detail string silently ragged every column
 *    after it. Nothing failed; the table just looked broken.
 *  - `detail` is harness- and issue-derived, so it is sanitised. A `\r` in it would
 *    return the cursor to column 0 and let crafted issue text overwrite the row above.
 */
export function renderStatusTable(
  rows: readonly StatusRow[],
  options: RenderStatusOptions = {},
): string {
  const theme = options.theme ?? createTheme();
  if (rows.length === 0) return theme.dim('No runs yet.');

  const columns = options.columns ?? 100;

  const statusWidth = widest(rows.map((row) => styleStatus(theme, row.status)));
  const issueWidth = widest(rows.map((row) => `#${row.issue}`));
  const idWidth = widest(rows.map((row) => row.runId));

  // Whatever is left after the fixed columns and their two-space gutters.
  const detailWidth = Math.max(12, columns - statusWidth - issueWidth - idWidth - 6);

  return rows
    .map((row) => {
      const status = padTo(styleStatus(theme, row.status), statusWidth);
      const issue = padTo(theme.bold(`#${row.issue}`), issueWidth);
      const id = padTo(theme.dim(row.runId), idWidth);
      // `oneLine`, not `sanitise`: sanitise deliberately keeps `\n` because renderers
      // use it, but a detail is ONE cell of ONE row. A newline in it printed a second
      // line indistinguishable from a real run, letting issue text forge a status the
      // ledger never recorded.
      const detail = fit(oneLine(row.detail), detailWidth);
      return `${status}  ${issue}  ${id}  ${detail}`.trimEnd();
    })
    .join('\n');
}

/** Widest measured width in a set of already-styled cells. */
function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, displayWidth(value)), 0);
}
