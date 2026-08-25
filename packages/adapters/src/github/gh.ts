import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A thin wrapper over the GitHub CLI.
 *
 * argv arrays only, never a shell string. Repository slugs, labels and comment bodies
 * all originate in webhook payloads, so shell metacharacters in them must be inert
 * rather than merely unlikely.
 *
 * `gh` is used rather than a GitHub App because it reuses the credential the developer
 * already has. Everything v0.1 needs — labels, comments, draft PRs — it covers.
 */

export class GhError extends Error {
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    // Only the first line: gh's errors are usually one useful line followed by usage.
    super(`gh ${args.join(' ')} failed: ${stderr.trim().split('\n')[0] ?? 'unknown error'}`);
    this.name = 'GhError';
    this.stderr = stderr;
  }
}

export interface GhOptions {
  timeoutMs?: number;
  /** Token for this call only. Never taken from the ambient environment. */
  token?: string;
}

export async function gh(args: readonly string[], options: GhOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', [...args], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      // The token is passed deliberately rather than inherited, so a run cannot
      // acquire credentials merely by being spawned somewhere they happened to exist.
      ...(options.token !== undefined
        ? { env: { ...process.env, GH_TOKEN: options.token } }
        : {}),
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new GhError(args, failure.stderr ?? failure.message ?? '');
  }
}

/** Run gh and report only whether it succeeded — for probes where failure is expected. */
export async function ghSucceeds(
  args: readonly string[],
  options: GhOptions = {},
): Promise<boolean> {
  try {
    await gh(args, options);
    return true;
  } catch {
    return false;
  }
}
