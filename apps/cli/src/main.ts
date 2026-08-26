import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import type { Sha } from '@issueforge/contracts';
import { reapOrphans } from '@issueforge/adapters';
import { createContext } from './context.js';
import { NotOurLabelError, parseEventFile } from './commands/handle-github-event.js';
import { runReproduceTask } from './commands/run-task.js';
import { collectStatus, renderStatusTable } from './commands/status.js';
import { hasBlockingProblem, renderDoctor, runDoctor } from './commands/doctor.js';
import { renderInit, runInit } from './commands/init.js';
import {
  listenerDeletionTargets,
  listenerStatus,
  renderListenerInstructions,
  uninstallListener,
} from './commands/listener.js';
import { executeClean, planClean, renderCleanPlan } from './commands/clean.js';

/**
 * Composition root and argv parsing.
 *
 * Nothing imports this package; it wires concrete adapters into `core`'s ports and
 * exposes them. Keeping that knowledge in one place is what lets every other package
 * depend on interfaces.
 */

const VERSION = '0.0.0';

/**
 * Exit codes, so a workflow step can branch on the outcome.
 *
 * A negative finding is NOT an error: "the bug did not reproduce" is a successful run
 * that reached a negative conclusion, and conflating it with a crash would make the
 * two indistinguishable to anything scripting this.
 */
const EXIT = { ok: 0, failed: 1, blocked: 2 } as const;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('issueforge')
    .description('Local-first GitHub IssueOps supervisor for coding-agent harnesses')
    .version(VERSION);

  program
    .command('handle')
    .argument('<kind>', 'event kind; only "github-event" is supported')
    .requiredOption('--event-path <path>', 'path to the workflow event payload')
    .option('--json', 'emit machine-readable output')
    .description('Handle a GitHub workflow event')
    .action(async (kind: string, options: { eventPath: string; json?: boolean }) => {
      if (kind !== 'github-event') {
        fail(`unknown event kind: ${kind}`);
        return;
      }

      let event;
      try {
        event = parseEventFile(options.eventPath);
      } catch (error) {
        if (error instanceof NotOurLabelError) {
          // Exit 0: a repository has labels for all sorts of reasons, and being
          // triggered is not the same as being addressed.
          if (options.json === true) emit({ skipped: true, label: error.label });
          return;
        }
        throw error;
      }

      if (event.intent !== 'reproduce') {
        if (options.json === true) emit({ skipped: true, intent: event.intent });
        process.stderr.write(`intent "${event.intent}" is not implemented in v0.1\n`);
        return;
      }

      const context = createContext();
      const result = await runReproduceTask(context, {
        repo: event.repo,
        issueNumber: event.issueNumber,
        issue: event.issue,
        remote: `https://github.com/${event.repo}.git`,
        // The `issues` event carries no issue-specific SHA, so the pinned commit is
        // resolved from the default branch and recorded on the run.
        baseSha: resolveBaseSha(event.repo, event.defaultBranch),
        // Passed through so the harness can report its findings on the issue.
        ...(process.env['ISSUEFORGE_GITHUB_TOKEN'] !== undefined
          ? { githubToken: process.env['ISSUEFORGE_GITHUB_TOKEN'] }
          : {}),
      });

      report(result, options.json === true);
    });

  program
    .command('run')
    .argument('<task>', 'task to run; only "reproduce" is supported')
    .requiredOption('--issue <number>', 'issue number', Number)
    .requiredOption('--repo <slug>', 'owner/repo')
    .option('--title <text>', 'issue title', '')
    .option('--body <text>', 'issue body', '')
    .option('--remote <url>', 'clone source; defaults to the GitHub remote')
    .option('--base-sha <sha>', 'commit to pin the workspace to')
    .option('--publish', 'write the verdict back to GitHub', false)
    .option('--json', 'emit machine-readable output')
    .description('Run a task locally')
    .action(
      async (
        task: string,
        options: {
          issue: number;
          repo: string;
          title: string;
          body: string;
          remote?: string;
          baseSha?: string;
          publish: boolean;
          json?: boolean;
        },
      ) => {
        if (task !== 'reproduce') {
          fail(`unknown task: ${task}`);
          return;
        }

        const context = createContext();
        const remote = options.remote ?? `https://github.com/${options.repo}.git`;

        const result = await runReproduceTask(context, {
          repo: options.repo,
          issueNumber: options.issue,
          issue: { number: options.issue, title: options.title, body: options.body },
          remote,
          baseSha: (options.baseSha ?? resolveBaseSha(options.repo, 'HEAD')) as Sha,
          ...(options.publish && process.env['ISSUEFORGE_GITHUB_TOKEN'] !== undefined
            ? { githubToken: process.env['ISSUEFORGE_GITHUB_TOKEN'] }
            : {}),
        });

        report(result, options.json === true);
      },
    );

  program
    .command('init')
    .option('--force', 'replace files that already exist', false)
    .option('--json', 'emit machine-readable output')
    .description('Generate the workflow and config a repository needs')
    .action((options: { force: boolean; json?: boolean }) => {
      const results = runInit(process.cwd(), options.force);
      if (options.json === true) emit(results);
      else process.stdout.write(`${renderInit(results)}\n`);
    });

  program
    .command('doctor')
    .option('--json', 'emit machine-readable output')
    .description('Check whether this machine can run IssueForge')
    .action((options: { json?: boolean }) => {
      const results = runDoctor();

      if (options.json === true) emit(results);
      else process.stdout.write(`${renderDoctor(results)}\n`);

      // Non-zero so a setup script or CI step can branch on it.
      if (hasBlockingProblem(results)) process.exitCode = EXIT.failed;
    });

  const listener = program.command('listener').description('Manage the GitHub event listener');

  listener
    .command('install')
    .requiredOption('--repo <slug>', 'owner/repo to register against')
    .description('Show how to install and register the self-hosted runner')
    .action((options: { repo: string }) => {
      process.stdout.write(`${renderListenerInstructions(options.repo)}\n`);
    });

  listener
    .command('status')
    .option('--json', 'emit machine-readable output')
    .description('Report whether the listener is installed and running')
    .action((options: { json?: boolean }) => {
      const state = listenerStatus();
      if (options.json === true) {
        emit(state);
        return;
      }
      process.stdout.write(
        [
          `installed  ${state.installed ? 'yes' : 'no'}`,
          `registered ${state.configured ? 'yes' : 'no'}`,
          `running    ${state.running ? 'yes' : 'no'}`,
          `path       ${state.path}`,
        ].join('\n') + '\n',
      );
    });

  listener
    .command('uninstall')
    .option('--repo <slug>', 'unregister from this repository first')
    .option('--yes', 'actually delete', false)
    .description('Remove the listener')
    .action((options: { repo?: string; yes: boolean }) => {
      const targets = listenerDeletionTargets();
      if (targets.length === 0) {
        process.stdout.write('Nothing to remove.\n');
        return;
      }

      // Say exactly what goes before anything goes.
      process.stdout.write(`Would delete:\n${targets.join('\n')}\n`);
      if (!options.yes) {
        process.stdout.write('\nRe-run with --yes to delete.\n');
        return;
      }

      for (const line of uninstallListener(options.repo)) process.stdout.write(`${line}\n`);
    });

  program
    .command('clean')
    .option('--older-than <days>', 'remove runs older than this', Number, 14)
    .option('--yes', 'actually delete', false)
    .option('--json', 'emit machine-readable output')
    .description('Remove old runs, transcripts and workspaces')
    .action((options: { olderThan: number; yes: boolean; json?: boolean }) => {
      const context = createContext();
      const targets = planClean(context, {
        olderThanDays: options.olderThan,
        dryRun: !options.yes,
      });

      if (options.yes) executeClean(context, targets);

      if (options.json === true) emit({ removed: options.yes, targets });
      else process.stdout.write(`${renderCleanPlan(targets, !options.yes)}\n`);
    });

  program
    .command('status')
    .option('--json', 'emit machine-readable output')
    .option('--limit <n>', 'how many runs to show', Number, 20)
    .description('Show local run state')
    .action((options: { json?: boolean; limit: number }) => {
      const context = createContext();

      // Every invocation reaps first: a run killed outright cannot have cleaned up
      // after itself, and `status` is the command a user reaches for when something
      // looks wrong.
      reapOrphans(context.store);

      const rows = collectStatus(context, options.limit);
      if (options.json === true) emit(rows);
      else process.stdout.write(`${renderStatusTable(rows)}\n`);
    });

  return program;
}

/**
 * Statuses that mean the harness ran and reached a conclusion.
 *
 * `needs-info` belongs here: "I could not tell from this issue" is a real finding,
 * reported to the issue for a human to act on. Exiting non-zero for it would mark a
 * working run as a broken one in the Actions UI, training maintainers to ignore red.
 * A non-zero exit is reserved for IssueForge itself failing.
 */
const CONCLUDED: readonly string[] = ['reproduced', 'cannot-reproduce', 'needs-info'];

function report(result: { runId: string; status: string; detail: string }, json: boolean): void {
  if (json) emit(result);
  else process.stdout.write(`${result.status}: ${result.detail}\n`);

  if (result.status === 'blocked') process.exitCode = EXIT.blocked;
  else if (CONCLUDED.includes(result.status)) process.exitCode = EXIT.ok;
  else process.exitCode = EXIT.failed;
}

/** Machine-readable output goes to stdout; logs go to stderr, so the two never mix. */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = EXIT.failed;
}

/**
 * Resolve the commit to pin to.
 *
 * An `issues` event carries no issue-specific SHA, so this asks the remote for the
 * branch tip and records it — a run must never track a moving ref.
 */
function resolveBaseSha(repo: string, ref: string): Sha {
  const remote = `https://github.com/${repo}.git`;
  const out = execFileSync('git', ['ls-remote', remote, ref], { encoding: 'utf8' });
  const sha = out.split(/\s+/)[0];
  if (sha === undefined || sha.length !== 40) {
    throw new Error(`could not resolve ${ref} in ${repo}`);
  }
  return sha as Sha;
}

buildProgram()
  .parseAsync()
  .catch((error: unknown) => {
    // A stack trace is the wrong answer to "your config file has a typo". Anything
    // reaching here is a condition the user can act on, so print the sentence and
    // keep the trace for --verbose debugging rather than making it the interface.
    fail(error instanceof Error ? error.message : String(error));
  });
