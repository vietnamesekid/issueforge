import type { Argv, ReplayObservation } from '@issueforge/contracts';
import type { ReplayOptions, Replayer } from '@issueforge/core';
import { spawnSupervised } from '../process/index.js';

/** How long a replay may run before it is treated as inconclusive. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Enough output to diagnose a failure without storing an entire build log. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Replays a command through the process supervisor.
 *
 * This runs code written by an agent in response to an attacker-authored issue, so it
 * gets exactly the same containment as a harness run: an environment allowlist, argv
 * arrays with no shell, its own process group, and a wall-clock timeout the command
 * cannot opt out of.
 *
 * It reports what happened and interprets nothing. Whether a non-zero exit means the
 * bug reproduced is the validator's decision, and keeping that judgement out of here
 * is what lets the ladder be tested without spawning anything.
 */
export class ProcessReplayer implements Replayer {
  async run(command: Argv, options: ReplayOptions): Promise<ReplayObservation> {
    const [executable, ...args] = command;
    if (executable === undefined) {
      throw new Error('cannot replay an empty command');
    }

    const startedAt = Date.now();
    const child = spawnSupervised(executable, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    let output = '';
    let truncated = false;
    try {
      for await (const line of child.lines()) {
        if (output.length < MAX_OUTPUT_BYTES) {
          output += `${line}\n`;
        } else if (!truncated) {
          truncated = true;
        }
      }
    } catch {
      // The iterable rejects when the process exits non-zero or is signalled. For a
      // replay that is the ORDINARY case — a reproduction is supposed to fail — so
      // the output gathered so far is kept and the exit state is read from wait()
      // below. Letting it throw would turn "the bug reproduced" into a crash.
    }
    if (truncated) output += '… [output truncated]\n';

    const result = await child.wait();

    return {
      command: [...command],
      // A timed-out or signalled process has no exit code of its own; -1 marks
      // "did not exit normally", which the ladder treats as a failure rather than
      // as the zero that an `?? 0` would have quietly invented.
      exitCode: result.exitCode ?? -1,
      output,
      durationMs: Date.now() - startedAt,
      timedOut: result.reason === 'timeout',
    };
  }
}
