import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { optionalDefined } from '@issueforge/contracts';

const execFileAsync = promisify(execFile);

/**
 * A thin wrapper over the git CLI.
 *
 * argv arrays only, never a shell string: repository slugs, refs and branch names all
 * originate in webhook payloads, so shell metacharacters in them must be inert rather
 * than merely unlikely.
 *
 * Deliberately thin. Git is the abstraction; wrapping it in a second one would only
 * add a layer to debug through when a command behaves unexpectedly.
 */

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
}

export class GitError extends Error {
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim().split('\n')[0] ?? 'unknown error'}`);
    this.name = 'GitError';
    this.stderr = stderr;
  }
}

export async function git(
  args: readonly string[],
  options: GitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', [...args], {
      ...optionalDefined('cwd', options.cwd),
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new GitError(args, failure.stderr ?? failure.message ?? '');
  }
}

/** Run git and report only whether it succeeded — for existence probes. */
export async function gitSucceeds(
  args: readonly string[],
  options: GitOptions = {},
): Promise<boolean> {
  try {
    await git(args, options);
    return true;
  } catch {
    return false;
  }
}
