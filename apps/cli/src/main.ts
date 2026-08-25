import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import type { Sha } from '@issueforge/contracts';
import { reapOrphans } from '@issueforge/adapters';
import { createContext } from './context.js';
import { NotOurLabelError, parseEventFile } from './commands/handle-github-event.js';
import { runReproduce } from './commands/run-reproduce.js';
import { collectStatus, renderStatusTable } from './commands/status.js';

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
 * A rejected claim is NOT an error: "the bug did not reproduce" is a successful run
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
      const result = await runReproduce(context, {
        repo: event.repo,
        issueNumber: event.issueNumber,
        issue: event.issue,
        remote: `https://github.com/${event.repo}.git`,
        // The `issues` event carries no issue-specific SHA, so the pinned commit is
        // resolved from the default branch and recorded on the run.
        baseSha: resolveBaseSha(event.repo, event.defaultBranch),
        publish: true,
        ...(process.env['ISSUEFORGE_GITHUB_TOKEN'] !== undefined
          ? { token: process.env['ISSUEFORGE_GITHUB_TOKEN'] }
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

        const result = await runReproduce(context, {
          repo: options.repo,
          issueNumber: options.issue,
          issue: { number: options.issue, title: options.title, body: options.body },
          remote,
          baseSha: (options.baseSha ?? resolveBaseSha(options.repo, 'HEAD')) as Sha,
          publish: options.publish,
        });

        report(result, options.json === true);
      },
    );

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

function report(result: { runId: string; status: string; why: string }, json: boolean): void {
  if (json) emit(result);
  else process.stdout.write(`${result.status}: ${result.why}\n`);

  process.exitCode =
    result.status === 'blocked'
      ? EXIT.blocked
      : result.status === 'reproduced' || result.status === 'cannot-reproduce'
        ? EXIT.ok
        : EXIT.failed;
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

buildProgram().parseAsync();
