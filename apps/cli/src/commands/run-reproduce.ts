import { execFileSync } from 'node:child_process';
import type { Sha } from '@issueforge/contracts';
import {
  GhWriter,
  ProcessReplayer,
  ReproduceRunner,
  IssueBusyError,
} from '@issueforge/adapters';
import {
  renderStatusComment,
  statusLabelFor,
  validateReproduction,
  ALL_STATUS_LABELS,
  type ValidationRequest,
} from '@issueforge/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';

/**
 * Runs a reproduce attempt and, when asked to, reports the verdict to GitHub.
 *
 * The order is deliberate: the harness runs, then IssueForge replays the evidence
 * itself, and only the *validated* verdict is published. A harness claim never
 * reaches GitHub unchecked — that gate is the product.
 */

export interface RunReproduceOptions {
  repo: string;
  issueNumber: number;
  issue: { number: number; title: string; body: string };
  remote: string;
  baseSha: Sha;
  /** When false the run stays entirely local, which is how it is tested. */
  publish: boolean;
  token?: string;
}

export interface RunReproduceOutput {
  runId: string;
  status: string;
  verdict?: string;
  why: string;
}

export async function runReproduce(
  context: AppContext,
  options: RunReproduceOptions,
): Promise<RunReproduceOutput> {
  const runner = new ReproduceRunner({
    store: context.store,
    workspaces: context.workspaces,
    harness: context.harness,
    config: context.config,
    logger: context.logger,
    root: context.root,
  });

  let result;
  try {
    result = await runner.run({
      repo: options.repo,
      issueNumber: options.issueNumber,
      issue: options.issue,
      remote: options.remote,
      baseSha: options.baseSha,
    });
  } catch (error) {
    if (error instanceof IssueBusyError) {
      // Not a failure: another run holds the issue, and refusing is the correct
      // behaviour rather than racing it.
      context.logger.warn({ issue: options.issueNumber }, error.message);
      return { runId: '', status: 'blocked', why: error.message };
    }
    throw error;
  }

  const run = context.store.getRun(result.runId);
  const claim = result.outcome?.result;

  // Only a run that produced a claim has anything to validate. Everything else —
  // a blocked sandbox, a crash, a harness that gave up — already carries its own
  // status, and inventing a verdict for it would be dishonest.
  if (claim === undefined || run?.workdir === undefined) {
    await publish(context, options, {
      runId: result.runId,
      status: result.status,
      detail: result.detail,
      ...(result.outcome?.injectionSuspected === true ? { injectionSuspected: true } : {}),
      ...(result.outcome?.costUsd !== undefined ? { costUsd: result.outcome.costUsd } : {}),
    });
    return { runId: result.runId, status: result.status, why: result.detail };
  }

  const validation = await validateReproduction(
    buildValidationRequest(run.workdir, options.baseSha, claim),
  );

  const status = validation.verdict;
  context.store.updateRun(result.runId, { status, detail: validation.why });

  await publish(context, options, {
    runId: result.runId,
    status,
    detail: validation.why,
    validation,
    ...(result.outcome?.injectionSuspected === true ? { injectionSuspected: true } : {}),
    ...(result.outcome?.costUsd !== undefined ? { costUsd: result.outcome.costUsd } : {}),
  });

  return { runId: result.runId, status, verdict: validation.verdict, why: validation.why };
}

function buildValidationRequest(
  workdir: string,
  baseSha: Sha,
  claim: NonNullable<Awaited<ReturnType<ReproduceRunner['run']>>['outcome']>['result'],
): ValidationRequest {
  return {
    claim: claim as NonNullable<typeof claim>,
    cwd: workdir,
    baseSha,
    headSha: headOf(workdir),
    changedFiles: changedFilesIn(workdir),
    readArtifact: (path) => {
      try {
        return readFileSync(join(workdir, path), 'utf8');
      } catch {
        return null;
      }
    },
    replayer: new ProcessReplayer(),
  };
}

async function publish(
  context: AppContext,
  options: RunReproduceOptions,
  report: Parameters<typeof renderStatusComment>[0],
): Promise<void> {
  if (!options.publish) return;

  const writer = new GhWriter(options.repo, options.token !== undefined ? { token: options.token } : {});
  const issue = { repo: options.repo, issueNumber: options.issueNumber };

  await writer.ensureLabels(issue, ALL_STATUS_LABELS);
  await writer.setStatusLabel(issue, statusLabelFor(report.status));
  await writer.upsertComment(issue, renderStatusComment(report));
}

function headOf(cwd: string): Sha {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() as Sha;
}

/**
 * Files the harness touched.
 *
 * `--porcelain` rather than `git diff`, because a reproduce task's output is a NEW
 * test file and `diff` does not report untracked files at all.
 */
function changedFilesIn(cwd: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
}
