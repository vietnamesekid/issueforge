import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ALL_LABELS, INTENT_LABELS } from '@issueforge/contracts';

/**
 * Generates the two files a repository needs to use IssueForge.
 *
 * Deliberately writes real content rather than a commented-out skeleton: a template
 * someone has to finish is a template they get wrong, and the parts most easily got
 * wrong here are the ones that silently lose work.
 */

export interface InitResult {
  path: string;
  written: boolean;
  reason?: string;
}

/**
 * The workflow template.
 *
 * Three details are load-bearing and each is annotated in the file itself, because
 * whoever edits this later will not have read the design notes:
 *
 *  - `queue: max` — the default (`single`) keeps only ONE pending run, so labelling a
 *    third issue silently cancels the second. Reproduced: a run was cancelled six
 *    seconds after creation and left no trace anywhere.
 *  - an explicit `timeout-minutes` — the default is undocumented, and a self-hosted
 *    job may otherwise run for days.
 *  - no `actions/checkout` — the command clones the pinned commit itself, so the
 *    runner's workspace never becomes an agent's workspace.
 */
const WORKFLOW = `name: IssueForge

on:
  issues:
    types: [labeled]

permissions:
  # Write because the fix task pushes a branch. The agent still cannot touch
  # .github/** — that is blocked by the task card's write boundary, which the
  # post-run audit enforces, not by the scope of this token.
  contents: write
  issues: write
  pull-requests: write

jobs:
  # Cancelling is a separate job with NO per-issue concurrency group: sharing the
  # dispatch group would queue the cancel behind the very run it is meant to stop.
  #
  # IMPORTANT: this only works if the runner can execute two jobs at once. A single
  # runner has one slot, so the cancel job waits for the run it is trying to kill and
  # achieves nothing. On a single-runner setup, cancel from the machine instead:
  #
  #     issueforge cancel --issue <n>
  #
  # Register a second runner with the same "issueforge" label to make the label work.
  cancel:
    if: github.event.label.name == 'issueforge:cancel'
    runs-on: [self-hosted, issueforge]
    timeout-minutes: 5
    steps:
      - name: Stop the run
        run: |
          export PATH="\${ISSUEFORGE_BIN:-\$HOME/.local/bin}:\$PATH"
          issueforge handle github-event --event-path "\$GITHUB_EVENT_PATH"

  dispatch:
    if: >-
      startsWith(github.event.label.name, 'issueforge:')
      && github.event.label.name != 'issueforge:cancel'
    runs-on: [self-hosted, issueforge]

    # Set explicitly: the default is undocumented, and a self-hosted job can
    # otherwise run for days.
    timeout-minutes: 120

    concurrency:
      group: issueforge-\${{ github.repository_id }}-\${{ github.event.issue.number }}
      cancel-in-progress: false
      # REQUIRED. The default (\`single\`) allows only ONE pending run, so labelling a
      # third issue silently cancels the second — no error, no trace. Verified.
      queue: max

    steps:
      # No actions/checkout on purpose: IssueForge clones the pinned commit itself,
      # so the runner's workspace never becomes the agent's workspace.
      - name: Run IssueForge locally
        env:
          ISSUEFORGE_GITHUB_TOKEN: \${{ github.token }}
          # Optional: an existing Claude Code login is enough. Set this as a
          # repository secret only for a headless machine with no interactive login.
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # A self-hosted runner does not inherit an interactive shell's PATH, so a
          # version-managed node (nvm, fnm, asdf, volta) is invisible to it and both
          # issueforge and the claude it spawns would be "command not found".
          # ISSUEFORGE_BIN lets the runner be told where they live.
          export PATH="\${ISSUEFORGE_BIN:-\$HOME/.local/bin}:\$PATH"
          issueforge handle github-event --event-path "\$GITHUB_EVENT_PATH"
`;

/**
 * Repository configuration.
 *
 * Every value here is already the default; the file exists so the defaults are
 * visible and can be changed, not because anything is missing without it.
 */
const CONFIG = `{
  "harness": {
    "preferred": "claude-code",
    "maxTurns": 30,
    "timeoutMs": 1800000
  },
  "policy": {
    "forbiddenPaths": [".github/**", ".git/**", "**/.env", "**/*.pem", "**/id_rsa*"]
  },
  "retention": { "days": 14 }
}
`;

export function runInit(cwd: string, force = false): InitResult[] {
  return [
    write(join(cwd, '.github', 'workflows', 'issueforge.yml'), WORKFLOW, force),
    write(join(cwd, '.issueforge', 'config.json'), CONFIG, force),
    write(join(cwd, '.issueforge', 'labels.sh'), labelScript(), force),
  ];
}

/**
 * A script that creates every label IssueForge uses.
 *
 * Emitted rather than executed: `init` writes files and never touches the network, and
 * a maintainer should see what will be created on their repository before it is.
 *
 * It exists because the first live fix run failed with "failed to update 1 issue" —
 * `issueforge:fix` did not exist yet, and nothing said it had to. Every first-time user
 * would hit that.
 */
function labelScript(): string {
  const lines = ALL_LABELS.map(
    (label) =>
      `gh label create ${JSON.stringify(label)} --color ${colourFor(label)} ` +
      `--description ${JSON.stringify(describe(label))} --force`,
  );

  return [
    '#!/bin/sh',
    '# Creates the labels IssueForge uses. Safe to re-run: --force updates in place.',
    '#',
    '# Intent labels are what YOU apply to ask for a run.',
    '# Outcome labels are what the agent applies when it finishes, so the issue list',
    '# shows what happened without opening the Actions tab.',
    'set -e',
    '',
    ...lines,
    '',
  ].join('\n');
}

/** Intent labels blue, conclusions green, non-conclusions grey. */
function colourFor(label: string): string {
  if (label in INTENT_LABELS) return '1D76DB';
  return label === 'issueforge:reproduced' || label === 'issueforge:fixed' ? '0E8A16' : 'BFD4F2';
}

function describe(label: string): string {
  const intent = (INTENT_LABELS as Record<string, string | undefined>)[label];
  return intent === undefined
    ? `IssueForge outcome: ${label.replace('issueforge:', '')}`
    : `IssueForge: run the ${intent} task`;
}

export function renderInit(results: readonly InitResult[]): string {
  const lines = results.map((result) =>
    result.written
      ? `created ${result.path}`
      : `skipped ${result.path} — ${result.reason ?? 'already exists'}`,
  );

  lines.push(
    '',
    'Next:',
    '  1. issueforge doctor',
    '  2. Register a self-hosted runner labelled "issueforge" on this repository',
    '  3. Create the labels:',
    '       sh .issueforge/labels.sh',
    '  4. Allow the fix task to open pull requests:',
    '       gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \\',
    '         -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true',
    '     GitHub disables this by default, and without it a fix run pushes its branch',
    '     and then cannot open the PR. In an organisation it must be enabled there first.',
    '  5. Label an issue "issueforge:reproduce"',
    '',
    'To stop a run already in flight: issueforge cancel --issue <n>',
    'The "issueforge:cancel" label does the same, but needs a SECOND runner — one',
    'runner has one slot, so the cancel job would queue behind the run it must stop.',
    '',
    'Use a private repository. A self-hosted runner executes on your machine, and',
    'anyone can write the issue text an agent will read.',
  );

  return lines.join('\n');
}

function write(path: string, contents: string, force: boolean): InitResult {
  if (existsSync(path) && !force) {
    // Never overwrite silently: this file may have been edited deliberately.
    return { path, written: false, reason: 'already exists (use --force to replace)' };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return { path, written: true };
}
