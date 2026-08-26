import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RunId, RunStatus } from '@issueforge/contracts';
import { isTerminal } from '@issueforge/core';
import { reapOrphans, runsRoot } from '@issueforge/adapters';
import { displayWidth, padTo } from '../ui/terminal-text.js';
import { createTheme, styleStatus, type Theme } from '../ui/theme.js';
import type { AppContext } from '../context.js';

/**
 * Removes old runs, their transcripts and their workspaces.
 *
 * Dry-run by default. This deletes evidence — the workspace IS the evidence — so
 * showing what would go before anything goes is the only responsible default for a
 * command someone will run when they are already frustrated.
 */

export interface CleanTarget {
  runId: RunId;
  status: RunStatus;
  ageDays: number;
  paths: string[];
}

export interface CleanOptions {
  olderThanDays: number;
  dryRun: boolean;
  now?: number;
}

export function planClean(context: AppContext, options: CleanOptions): CleanTarget[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanDays * 24 * 60 * 60 * 1000;

  return context.store
    .listRuns({ limit: 1000 })
    .filter((run) => run.updatedAt < cutoff)
    // A run still in flight owns its workspace; deleting it would pull the ground out
    // from under a live process.
    .filter((run) => isTerminal(run.status))
    .map((run) => ({
      runId: run.id,
      status: run.status,
      ageDays: Math.floor((now - run.updatedAt) / (24 * 60 * 60 * 1000)),
      paths: [join(runsRoot(context.root), run.id), ...(run.workdir !== undefined ? [run.workdir] : [])]
        .filter((path) => existsSync(path)),
    }));
}

export function executeClean(context: AppContext, targets: readonly CleanTarget[]): void {
  // Before deleting anything: a workspace whose process group is still alive would
  // otherwise be removed out from under it.
  reapOrphans(context.store);

  for (const target of targets) {
    for (const path of target.paths) {
      rmSync(path, { recursive: true, force: true });
    }
    context.store.updateRun(target.runId, {
      detail: `artifacts removed by clean (was: ${target.status})`,
    });
  }
}

export function renderCleanPlan(
  targets: readonly CleanTarget[],
  dryRun: boolean,
  options: { theme?: Theme } = {},
): string {
  const theme = options.theme ?? createTheme();
  if (targets.length === 0) return theme.dim('Nothing to clean.');

  const idWidth = targets.reduce((max, t) => Math.max(max, displayWidth(t.runId)), 0);

  const lines = targets.map(
    (target) =>
      `${padTo(theme.dim(target.runId), idWidth)}  ${styleStatus(theme, target.status)}  ${theme.dim(`${target.ageDays}d`)}\n` +
      target.paths.map((path) => `    ${path} ${theme.dim(`(${sizeOf(path)})`)}`).join('\n'),
  );

  const count = `${targets.length} run${targets.length === 1 ? '' : 's'}`;
  lines.push(
    '',
    dryRun
      ? // This deletes evidence, so the confirmation is the loud part.
        `${theme.warning(`${count} would be removed.`)} Re-run with ${theme.code('--yes')} to delete.`
      : theme.success(`${count} removed.`),
  );

  return lines.join('\n');
}

/** Approximate size, so the plan says how much is at stake. */
function sizeOf(path: string): string {
  try {
    const bytes = directorySize(path);
    return bytes > 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)}MB` : `${Math.round(bytes / 1024)}KB`;
  } catch {
    return 'unknown size';
  }
}

function directorySize(path: string, depth = 0): number {
  // Bounded: a deep tree costs more to measure than the number is worth.
  if (depth > 4) return 0;

  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;

  return readdirSync(path).reduce((total, entry) => {
    try {
      return total + directorySize(join(path, entry), depth + 1);
    } catch {
      return total;
    }
  }, 0);
}
