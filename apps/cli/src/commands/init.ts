import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  dispatch:
    if: startsWith(github.event.label.name, 'issueforge:')
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
  ];
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
    '  3. Add ANTHROPIC_API_KEY as a repository secret',
    '  4. Label an issue "issueforge:reproduce"',
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
