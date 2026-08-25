import { existsSync, rmSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from '@issueforge/core';
import { reapOrphans, runsRoot, type SqliteRunStore } from '@issueforge/adapters';
import type { AppContext } from '../context.js';

/**
 * Removes old runs, their transcripts and their workspaces.
 *
 * Dry-run by default. This deletes evidence — the workspace IS the evidence — so
 * showing what would go before anything goes is the only responsible default for a
 * command someone will run when they are already frustrated.
 */

export interface CleanTarget {
  runId: string;
  status: string;
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
    (context.store as SqliteRunStore).updateRun(target.runId, {
      detail: `artifacts removed by clean (was: ${target.status})`,
    });
  }
}

export function renderCleanPlan(targets: readonly CleanTarget[], dryRun: boolean): string {
  if (targets.length === 0) return 'Nothing to clean.';

  const lines = targets.map(
    (target) =>
      `${target.runId}  ${target.status.padEnd(17)} ${target.ageDays}d\n` +
      target.paths.map((path) => `    ${path} (${sizeOf(path)})`).join('\n'),
  );

  lines.push(
    '',
    dryRun
      ? `${targets.length} run(s) would be removed. Re-run with --yes to delete.`
      : `${targets.length} run(s) removed.`,
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
