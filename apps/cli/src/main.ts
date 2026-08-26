import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import type { RunId, RunStatus, Sha } from '@issueforge/contracts';
import { optionalDefined, RepoSlug, Sha as ShaSchema, Verdict } from '@issueforge/contracts';
import { reapOrphans, FIX, REPRODUCE, type TaskDefinition } from '@issueforge/adapters';
import { LiveRegion } from './ui/live-region.js';
import { RunProgress } from './ui/run-progress.js';
import { sanitise } from './ui/terminal-text.js';
import { createTheme, styleStatus, type Theme } from './ui/theme.js';
import { createContext } from './context.js';
import {
  NotOurLabelError,
  parseEventFile,
  type ParsedEvent,
} from './commands/handle-github-event.js';
import { runTask } from './commands/run-task.js';
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
import { cancelRuns, renderCancelled } from './commands/cancel.js';
import { declinedReason, taskIsPermitted } from './commands/policy.js';

/**
 * Composition root and argv parsing.
 *
 * Nothing imports this package; it wires concrete adapters into `core`'s ports and
 * exposes them. Keeping that knowledge in one place is what lets every other package
 * depend on interfaces.
 */

/**
 * Replaced at build time with the version from apps/cli/package.json.
 *
 * It was a hand-written constant, which meant a release had to remember to edit two
 * files; `changeset version` only touches the manifest, so the binary would have
 * reported a stale number and the version a user pastes into a bug report would be
 * wrong. tsup substitutes this via `define`, so the built bundle still holds a plain
 * literal and nothing is read from disk at runtime — `files` ships dist/ only, so
 * reading package.json from the installed CLI is not an option.
 *
 * The fallback is for `node src/main.ts`, which runs unbundled with no substitution.
 */
declare const __ISSUEFORGE_VERSION__: string | undefined;
const VERSION = typeof __ISSUEFORGE_VERSION__ === 'string' ? __ISSUEFORGE_VERSION__ : '0.0.0-dev';

/**
 * Exit codes, so a workflow step can branch on the outcome.
 *
 * A negative finding is NOT an error: "the bug did not reproduce" is a successful run
 * that reached a negative conclusion, and conflating it with a crash would make the
 * two indistinguishable to anything scripting this.
 */
const EXIT = { ok: 0, failed: 1, blocked: 2 } as const;

/**
 * Intent label → the task it runs.
 *
 * `retry` and `cancel` are absent on purpose: they act on a run that already exists
 * rather than starting a new one, so they need a different command shape.
 */
const TASKS: Partial<Record<string, TaskDefinition>> = {
  reproduce: REPRODUCE,
  fix: FIX,
};

/**
 * The theme for this invocation.
 *
 * Resolved once from the root command's flags so every renderer is handed the same
 * one, and so `--no-color` is a single global rather than a flag each command has to
 * remember to declare.
 */
function themeFor(program: Command): Theme {
  const { color } = program.opts<{ color: boolean }>();

  // ONLY the negative is an instruction. Commander gives a `--no-x` flag a default of
  // `true` when it is ABSENT, so forwarding that `true` told createTheme "colour is
  // explicitly on" and detection never ran — observed: escape codes filling a file the
  // user had redirected output to. A `true` here means "the user did not say", which
  // is precisely the case detection exists to handle, so it must pass nothing at all.
  return createTheme(color ? {} : { color: false });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('issueforge')
    .description('Local-first GitHub IssueOps supervisor for coding-agent harnesses')
    .version(VERSION)
    // Colour is on for a terminal and off for a pipe, CI, or NO_COLOR; this is the
    // manual override for the cases detection gets wrong.
    .option('--no-color', 'disable coloured output');

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

      // Annotated rather than inferred from the assignment inside `try`: without it the
      // declaration has no type at the point of use, which reads as `any` to a type-aware
      // linter and gives up every check downstream.
      let event: ParsedEvent;
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

      if (event.intent === 'cancel') {
        // A verb on an existing run rather than a task, so it does not go through the
        // runner at all.
        const cancelled = cancelRuns(createContext(), { issueNumber: event.issueNumber });
        if (options.json === true) emit(cancelled);
        else process.stdout.write(`${renderCancelled(cancelled, { theme: themeFor(program) })}\n`);
        return;
      }

      const task = TASKS[event.intent];
      if (task === undefined) {
        // `retry` and `cancel` are verbs on an existing run rather than task kinds, so
        // they need a different shape than this command has. Declining is honest; exit
        // 0 because a recognised-but-unimplemented label is not a failure.
        if (options.json === true) emit({ skipped: true, intent: event.intent });
        process.stderr.write(`intent "${event.intent}" is not implemented yet\n`);
        return;
      }

      const context = createContext();

      if (!taskIsPermitted(task.kind, context.config)) {
        // A policy stop, not a failure: the maintainer asked for something this
        // repository has switched off, and saying so is more useful than silence.
        const reason = declinedReason(task.kind, context.config);
        if (options.json === true) emit({ skipped: true, task: task.kind, reason });
        else process.stderr.write(`${reason}\n`);
        return;
      }

      const result = await runTask(context, task, {
        repo: RepoSlug.parse(event.repo),
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

      report(result, options.json === true, themeFor(program));
    });

  program
    .command('run')
    .argument('<task>', 'task to run: "reproduce" or "fix"')
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
        const definition = TASKS[task];
        if (definition === undefined) {
          fail(`unknown task: ${task}. Try "reproduce" or "fix".`);
          return;
        }

        const context = createContext();

        if (!taskIsPermitted(definition.kind, context.config)) {
          fail(declinedReason(definition.kind, context.config));
          return;
        }

        const remote = options.remote ?? `https://github.com/${options.repo}.git`;

        /**
         * Progress goes to stderr, never stdout.
         *
         * stdout carries `--json`, and interleaving a repaint into it would corrupt
         * the document anything scripting this parses. Suppressed entirely under
         * `--json` so a machine consumer sees no decoration at all.
         */
        const progress =
          options.json === true
            ? undefined
            : new RunProgress({
                theme: themeFor(program),
                region: new LiveRegion({ stream: process.stderr }),
              });

        try {
          const result = await runTask(context, definition, {
            // Straight from argv, so parsed here rather than trusted. A bad slug now
            // fails at the boundary with a readable message instead of part-way through
            // a run that has already taken the issue lock.
            repo: RepoSlug.parse(options.repo),
            issueNumber: options.issue,
            issue: { number: options.issue, title: options.title, body: options.body },
            remote,
            // `??` would hand through an unvalidated argv string; a supplied SHA has to
            // be parsed, a resolved one is already branded.
            baseSha:
              options.baseSha === undefined
                ? resolveBaseSha(options.repo, 'HEAD')
                : ShaSchema.parse(options.baseSha),
            ...(options.publish && process.env['ISSUEFORGE_GITHUB_TOKEN'] !== undefined
              ? { githubToken: process.env['ISSUEFORGE_GITHUB_TOKEN'] }
              : {}),
            ...optionalDefined('onPhase', progress?.advance.bind(progress)),
          });

          report(result, options.json === true, themeFor(program));
        } finally {
          // Always: an uncleared live region leaves the cursor hidden and the user's
          // shell broken until they type `reset`. Same rule as the issue lock — a
          // crashed run must not leave state behind.
          progress?.stop();
        }
      },
    );

  program
    .command('cancel')
    .option('--issue <number>', 'restrict to one issue', Number)
    .option('--json', 'emit machine-readable output')
    .description('Stop runs that are still in flight')
    .action((options: { issue?: number; json?: boolean }) => {
      const context = createContext();
      const cancelled = cancelRuns(context, optionalDefined('issueNumber', options.issue));

      if (options.json === true) emit(cancelled);
      else process.stdout.write(`${renderCancelled(cancelled, { theme: themeFor(program) })}\n`);
    });

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
      else process.stdout.write(`${renderDoctor(results, { theme: themeFor(program) })}\n`);

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
      else process.stdout.write(`${renderCleanPlan(targets, !options.yes, { theme: themeFor(program) })}\n`);
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
      else process.stdout.write(`${renderStatusTable(rows, { theme: themeFor(program), ...optionalDefined('columns', process.stdout.columns) })}\n`);
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
function report(
  result: { runId: RunId | undefined; status: RunStatus; detail: string },
  json: boolean,
  theme: Theme = createTheme(),
): void {
  if (json) emit(result);
  else {
    // `sanitise`, not `oneLine`: this is the final verdict, not a table cell, and a
    // harness summary spanning several lines is legitimate here. Control characters
    // still go — the detail can quote issue text, which is data, never instructions.
    process.stdout.write(`${styleStatus(theme, result.status)} ${sanitise(result.detail)}\n`);
  }

  process.exitCode = exitCodeFor(result.status);
}

/**
 * Map a run's final status to a process exit code.
 *
 * Derived from `Verdict` rather than a hand-written list: the two had already been
 * copied apart, and because the copy was typed `string[]` a new verdict would have
 * exited non-zero with no compile error and no failing test.
 */
function exitCodeFor(status: RunStatus): number {
  if (status === 'blocked') return EXIT.blocked;
  // A conclusion the harness reached, including `needs-info` and `could-not-fix`.
  // "I could not tell from this issue" and "I could not fix it" are real findings
  // reported for a human to act on; exiting non-zero would mark a working run red in
  // the Actions UI and train maintainers to ignore red. Non-zero is reserved for
  // IssueForge itself failing.
  if ((Verdict.options as readonly string[]).includes(status)) return EXIT.ok;
  return EXIT.failed;
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
export function resolveBaseSha(repo: string, ref: string): Sha {
  const remote = `https://github.com/${repo}.git`;

  let out: string;
  try {
    // stderr is captured rather than inherited: git prints its own two-line
    // "Repository not found" to the terminal, and execFileSync then throws with
    // "Command failed: git ls-remote ..." — so the user saw the same message twice,
    // followed by an internal command line, and no statement of what to do.
    out = execFileSync('git', ['ls-remote', remote, ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `cannot read ${repo}: it does not exist, is private, or your git credentials ` +
        `do not reach it. Check \`gh auth status\`, and that the name is "owner/repo".`,
    );
  }
  // Parsed, not length-checked: `Sha` means 40 hex characters, and a bare length test
  // would accept 40 characters of anything.
  const parsed = ShaSchema.safeParse(out.split(/\s+/)[0]);
  if (parsed.error) {
    throw new Error(`could not resolve ${ref} in ${repo}`);
  }
  return parsed.data;
}

buildProgram()
  .parseAsync()
  .catch((error: unknown) => {
    // A stack trace is the wrong answer to "your config file has a typo". Anything
    // reaching here is a condition the user can act on, so print the sentence and
    // keep the trace for --verbose debugging rather than making it the interface.
    fail(error instanceof Error ? error.message : String(error));
  });
