import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRoot } from '@issueforge/adapters';

/**
 * Manages the GitHub Actions self-hosted runner that delivers events.
 *
 * "Listener" rather than "runner" or "daemon": it describes the GitHub bridge without
 * suggesting IssueForge has an agent loop of its own.
 *
 * The runner is GitHub's own binary, downloaded and configured here rather than
 * reimplemented. It connects outbound over HTTPS, which is what makes this work with
 * no inbound port, no tunnel and no polling.
 */

const RUNNER_LABEL = 'issueforge';

export interface ListenerStatus {
  installed: boolean;
  path: string;
  configured: boolean;
  running: boolean;
}

export function listenerPath(root: string = defaultRoot()): string {
  return join(root, 'listener');
}

export function listenerStatus(root: string = defaultRoot()): ListenerStatus {
  const path = listenerPath(root);

  return {
    installed: existsSync(join(path, 'config.sh')),
    path,
    // `.runner` appears once the runner has registered with a repository.
    configured: existsSync(join(path, '.runner')),
    running: isRunning(),
  };
}

/**
 * Print what installing would do, and what the user must do themselves.
 *
 * Registration is not automated: it needs a short-lived token that only a repository
 * admin can mint, and quietly acquiring one on someone's behalf would be the wrong
 * default for a tool that runs code on their machine.
 */
export function renderListenerInstructions(repo: string, root: string = defaultRoot()): string {
  const path = listenerPath(root);

  return [
    `The listener is GitHub's own self-hosted runner. IssueForge does not replace it.`,
    '',
    `Install it into ${path}:`,
    '',
    `  mkdir -p ${path} && cd ${path}`,
    `  # macOS arm64; see https://github.com/actions/runner/releases for other platforms`,
    `  VERSION=$(gh api repos/actions/runner/releases/latest --jq .tag_name | sed 's/^v//')`,
    `  curl -sfLO "https://github.com/actions/runner/releases/download/v\${VERSION}/actions-runner-osx-arm64-\${VERSION}.tar.gz"`,
    `  tar xzf actions-runner-osx-arm64-*.tar.gz`,
    '',
    'Register it (the token is short-lived and only a repository admin can mint one):',
    '',
    `  TOKEN=$(gh api -X POST repos/${repo}/actions/runners/registration-token --jq .token)`,
    `  ./config.sh --url https://github.com/${repo} --token "$TOKEN" \\`,
    `    --name issueforge --labels ${RUNNER_LABEL} --unattended --replace`,
    '',
    'Run it:',
    '',
    `  ./run.sh                 # foreground; Ctrl-C stops it`,
    `  ./svc.sh install && ./svc.sh start   # or as a background service`,
    '',
    'Do NOT use --ephemeral: it de-registers after one job and exists for autoscaling',
    'fleets, not a developer machine.',
    '',
    `Remove it later with: issueforge listener uninstall`,
  ].join('\n');
}

/**
 * Remove the listener, after saying exactly what will be deleted.
 *
 * Unregistering first matters: deleting the directory alone leaves GitHub believing a
 * runner is still there, and the repository accumulates offline entries nobody can
 * explain later.
 */
export function uninstallListener(repo: string | undefined, root: string = defaultRoot()): string[] {
  const path = listenerPath(root);
  const done: string[] = [];

  if (!existsSync(path)) return ['nothing to remove'];

  if (repo !== undefined && existsSync(join(path, '.runner'))) {
    try {
      const token = execFileSync(
        'gh',
        ['api', '-X', 'POST', `repos/${repo}/actions/runners/remove-token`, '--jq', '.token'],
        { encoding: 'utf8' },
      ).trim();
      execFileSync('./config.sh', ['remove', '--token', token], { cwd: path, stdio: 'ignore' });
      done.push('unregistered from GitHub');
    } catch {
      done.push('could not unregister automatically — remove it in the repository settings');
    }
  }

  rmSync(path, { recursive: true, force: true });
  done.push(`removed ${path}`);
  return done;
}

/** Everything `uninstall` would delete, listed before anything is deleted. */
export function listenerDeletionTargets(root: string = defaultRoot()): string[] {
  const path = listenerPath(root);
  if (!existsSync(path)) return [];

  const entries = readdirSync(path).slice(0, 8);
  return [path, ...entries.map((entry) => `  ${entry}`)];
}

export function ensureListenerDir(root: string = defaultRoot()): string {
  const path = listenerPath(root);
  mkdirSync(path, { recursive: true });
  return path;
}

function isRunning(): boolean {
  try {
    execFileSync('pgrep', ['-f', 'Runner.Listener'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
