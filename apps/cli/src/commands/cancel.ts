import { isGroupAlive, killGroup } from '@issueforge/adapters';
import type { RunId } from '@issueforge/contracts';
import { createTheme, type Theme } from '../ui/theme.js';
import type { AppContext } from '../context.js';

/**
 * Stops runs that are still in flight.
 *
 * Removing a label stops the NEXT run; it does nothing to the one already executing.
 * Every agentic tool surveyed was eventually forced to ship an off switch, and the ones
 * that shipped it late took reputational damage — so this exists before anyone asks.
 *
 * `cancel` is a verb acting on an existing run, not a task, which is why it is a command
 * of its own rather than a `TaskDefinition`. It also runs in a DIFFERENT process from
 * the run it stops, so it works through the ledger and the OS rather than through an
 * in-memory handle.
 */

export interface CancelOptions {
  /** Restrict to one issue. Omit to cancel every live run on this machine. */
  issueNumber?: number;
}

export interface CancelledRun {
  runId: RunId;
  issueNumber: number;
  pgid: number;
  /** False when the group had already exited and only the row needed clearing. */
  wasAlive: boolean;
}

export function cancelRuns(context: AppContext, options: CancelOptions = {}): CancelledRun[] {
  const cancelled: CancelledRun[] = [];

  for (const { run, ownership } of context.store.listReapCandidates()) {
    if (options.issueNumber !== undefined && run.issueNumber !== options.issueNumber) continue;

    // A group that has already exited needs no signal, but its row still claims
    // ownership — and a stale pgid is one the reaper would reconsider after the OS
    // recycles it.
    const wasAlive = isGroupAlive(ownership.pgid);
    if (wasAlive) killGroup(ownership.pgid);

    // Status before ownership: a crash between the two leaves a row that still names
    // its group, which the reaper can finish. The reverse leaves an orphan nobody owns.
    context.store.updateRun(run.id, {
      status: 'cancelled',
      detail: wasAlive
        ? `cancelled by request; process group ${ownership.pgid} terminated`
        : `cancelled by request; process group ${ownership.pgid} had already exited`,
    });
    context.store.updateRun(run.id, { ownership: null });

    cancelled.push({ runId: run.id, issueNumber: run.issueNumber, pgid: ownership.pgid, wasAlive });
  }

  return cancelled;
}

export function renderCancelled(
  cancelled: readonly CancelledRun[],
  options: { theme?: Theme } = {},
): string {
  const theme = options.theme ?? createTheme();
  if (cancelled.length === 0) return theme.dim('Nothing to cancel — no run is in flight.');

  return cancelled
    .map(
      (c) =>
        `${theme.warning('■')} cancelled ${theme.dim(c.runId)} ` +
        `${theme.bold(`#${c.issueNumber}`)} ${theme.dim(`(pgid ${c.pgid})`)}` +
        // Worth saying: the difference between "we killed it" and "it was already
        // gone and we only cleared the row" is what tells a user whether the thing
        // they were worried about is still running.
        (c.wasAlive ? '' : theme.dim(' — already exited')),
    )
    .join('\n');
}
