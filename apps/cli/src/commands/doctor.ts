import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { defaultRoot } from '@issueforge/adapters';
import { displayWidth, oneLine, padTo } from '../ui/terminal-text.js';
import { createTheme, type Theme } from '../ui/theme.js';

/**
 * Reports why IssueForge will not work here, before anyone tries a run.
 *
 * Two rules: a check that fails names the exact fix rather than just the fault, and
 * anything that would make a run fail later is BLOCKING rather than a warning. The
 * point is to move a discovery from "my run hung" to "my setup is incomplete".
 */

export type CheckLevel = 'ok' | 'warn' | 'blocked';

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
  /** What to do about it. Absent when there is nothing to do. */
  fix?: string;
}

export function runDoctor(): CheckResult[] {
  return [
    checkNode(),
    checkCommand('git', ['--version'], 'git', 'Install git: https://git-scm.com/downloads'),
    checkCommand(
      'gh',
      ['--version'],
      'GitHub CLI',
      'Install the GitHub CLI: https://cli.github.com',
    ),
    checkGhAuth(),
    checkCommand(
      'claude',
      ['--version'],
      'Claude Code',
      'Install Claude Code: https://code.claude.com/docs',
    ),
    checkHarnessAuth(),
    checkHome(),
  ];
}

/** Symbol and colour role per level, both total so a new level fails to compile. */
const SYMBOL: Record<CheckLevel, string> = { ok: '✓', warn: '!', blocked: '✗' };
const ROLE: Record<CheckLevel, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  warn: 'warning',
  blocked: 'danger',
};

export function renderDoctor(
  results: readonly CheckResult[],
  options: { theme?: Theme } = {},
): string {
  const theme = options.theme ?? createTheme();

  // Sized from the longest name present rather than a constant, so adding a check with
  // a longer name does not silently unalign the column.
  const nameWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.name)), 0);

  const lines = results.map((result) => {
    const mark = theme[ROLE[result.level]](SYMBOL[result.level]);
    // `detail` carries output from an external tool — a version string, a path — so it
    // is flattened to one line as well as sanitised. Each result is one row.
    const head = `${mark} ${padTo(theme.bold(result.name), nameWidth)}  ${oneLine(result.detail)}`;
    return result.fix === undefined
      ? head
      : `${head}\n  ${theme.dim('→')} ${theme.code(result.fix)}`;
  });

  const blocked = results.filter((r) => r.level === 'blocked').length;
  lines.push(
    '',
    blocked === 0
      ? `${theme.success('Ready.')} Try: ${theme.code('issueforge run reproduce --repo owner/repo --issue 1')}`
      : theme.danger(
          `${blocked} blocking problem${blocked === 1 ? '' : 's'} — IssueForge will not run until they are fixed.`,
        ),
  );

  return lines.join('\n');
}

export function hasBlockingProblem(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.level === 'blocked');
}

function checkNode(): CheckResult {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);

  return supported
    ? { name: 'node', level: 'ok', detail: `v${process.versions.node}` }
    : {
        name: 'node',
        level: 'blocked',
        detail: `v${process.versions.node} is too old`,
        fix: 'Install Node 22.13 or newer (24 LTS recommended): https://nodejs.org',
      };
}

function checkCommand(
  command: string,
  args: readonly string[],
  label: string,
  fix: string,
): CheckResult {
  const version = tryRun(command, args);
  return version === null
    ? { name: command, level: 'blocked', detail: `${label} is not installed`, fix }
    : { name: command, level: 'ok', detail: firstLine(version) };
}

function checkGhAuth(): CheckResult {
  if (tryRun('gh', ['--version']) === null) {
    // Already reported by the gh check; saying it twice adds noise, not information.
    return { name: 'gh auth', level: 'warn', detail: 'skipped — gh is not installed' };
  }

  return tryRun('gh', ['auth', 'status']) === null
    ? {
        name: 'gh auth',
        level: 'blocked',
        detail: 'not authenticated',
        fix: 'Run: gh auth login',
      }
    : { name: 'gh auth', level: 'ok', detail: 'authenticated' };
}

/**
 * Whether the harness can authenticate at all.
 *
 * An interactive login is enough — reusing the Claude Code installation and
 * authentication a developer already has is the point of the product, not a fallback.
 * ANTHROPIC_API_KEY is reported when present because it is what a CI or headless
 * setup will use, but its absence is not a problem for someone already logged in.
 */
function checkHarnessAuth(): CheckResult {
  if (process.env['ANTHROPIC_API_KEY'] !== undefined) {
    // Only whether one is present; never its value.
    return { name: 'harness auth', level: 'ok', detail: 'ANTHROPIC_API_KEY is set' };
  }

  const status = tryRun('claude', ['auth', 'status']);
  if (status !== null) {
    return { name: 'harness auth', level: 'ok', detail: 'signed in to Claude Code' };
  }

  return {
    name: 'harness auth',
    level: 'blocked',
    detail: 'Claude Code is not authenticated',
    fix: 'Run `claude` once and sign in, or export ANTHROPIC_API_KEY for a headless setup.',
  };
}

function checkHome(): CheckResult {
  const root = defaultRoot();
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
    return { name: 'home', level: 'ok', detail: root };
  } catch {
    return {
      name: 'home',
      level: 'blocked',
      detail: `${root} is not writable`,
      fix: `Fix permissions on ${root}, or set ISSUEFORGE_HOME to a writable directory.`,
    };
  }
}

function tryRun(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
