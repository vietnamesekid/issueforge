import { optionalDefined, type Sha } from '@issueforge/contracts';
import { ReproduceRunner, IssueBusyError } from '@issueforge/adapters';
import type { AppContext } from '../context.js';

/**
 * Runs a task and records what happened.
 *
 * Deliberately thin. IssueForge sets the run up — a pinned workspace, an issue lock,
 * a supervised process — and the harness does the work and reports its findings to the
 * issue itself, where a maintainer reads them.
 *
 * An earlier version replayed the evidence here and published its own verdict. Three
 * live runs showed it rejecting a correct reproduction three different ways, each
 * because a free agent had chosen a form the check did not anticipate. The reviewer
 * reviews; withholding a correct finding from them was the opposite of the point.
 */

export interface RunTaskOptions {
  repo: string;
  issueNumber: number;
  issue: { number: number; title: string; body: string };
  remote: string;
  baseSha: Sha;
  /** Lets the harness report back. Absent for a local run with no GitHub side. */
  githubToken?: string;
}

export interface RunTaskOutput {
  runId: string;
  status: string;
  detail: string;
}

export async function runReproduceTask(
  context: AppContext,
  options: RunTaskOptions,
): Promise<RunTaskOutput> {
  const runner = new ReproduceRunner({
    store: context.store,
    workspaces: context.workspaces,
    harness: context.harness,
    config: context.config,
    logger: context.logger,
    root: context.root,
  });

  try {
    const result = await runner.run({
      repo: options.repo,
      issueNumber: options.issueNumber,
      issue: options.issue,
      remote: options.remote,
      baseSha: options.baseSha,
      ...optionalDefined('githubToken', options.githubToken),
    });

    return { runId: result.runId, status: result.status, detail: result.detail };
  } catch (error) {
    if (error instanceof IssueBusyError) {
      // Not a failure: another run holds this issue, and declining is correct rather
      // than racing it.
      context.logger.warn({ issue: options.issueNumber }, error.message);
      return { runId: '', status: 'blocked', detail: error.message };
    }
    throw error;
  }
}
