import { execa, type ResultPromise } from 'execa';
import type { ProcessOwnership } from '@issueforge/contracts';
import { currentProcessIdentity } from './identity.js';
import { killGroup } from './reaper.js';
import { buildChildEnvironment, type EnvironmentOptions } from './environment.js';

/**
 * Supervises one child process: spawn, stream its output line by line, enforce a
 * timeout, and terminate the whole tree on cancellation.
 *
 * Two constraints shape this, both established by experiment rather than assumed:
 *
 *  - A harness that backgrounds work (`npm test &`, a dev server) leaves children
 *    that killing the leader alone does not reach. The child is therefore spawned
 *    `detached`, making it a process-group leader, and termination signals the whole
 *    group.
 *  - Group kill still is not sufficient. If this supervisor is itself killed, nothing
 *    remains to send the signal — so ownership is handed to the caller to persist
 *    before the process starts, and the reaper cleans up on a later invocation.
 */

export interface SpawnOptions {
  cwd: string;
  /** Wall-clock budget. The harness is not trusted to honour its own limits. */
  timeoutMs?: number;
  env?: EnvironmentOptions;
  /** Aborting terminates the process group. */
  signal?: AbortSignal;
}

/**
 * How a supervised process ended.
 *
 * `terminated` is distinct from `error`: being signalled is an ordinary outcome here,
 * since the reaper and the cancel path both kill by signal. Collapsing it into
 * `error` would report routine cleanup as a fault.
 */
export type ExitReason = 'completed' | 'timeout' | 'cancelled' | 'terminated' | 'error';

export interface SupervisedResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: ExitReason;
}

export interface SupervisedProcess {
  /** Process group id — equal to the child's pid, since it is spawned detached. */
  readonly pgid: number;
  /** Persist this BEFORE awaiting, so a crash mid-run is still recoverable. */
  readonly ownership: ProcessOwnership;
  /** Interleaved stdout and stderr, one line at a time, as they arrive. */
  lines(): AsyncIterable<string>;
  /** Resolves once the process has exited. Never rejects on a non-zero exit. */
  wait(): Promise<SupervisedResult>;
  /** Terminate the whole group: SIGTERM, grace period, SIGKILL. */
  terminate(): void;
}

/**
 * Spawn a supervised child.
 *
 * `command` and `args` are separate and `shell` is never enabled: issue text reaches
 * commands as data, and argv with no shell makes `$(...)`, backticks and `;` inert
 * rather than merely discouraged.
 */
export function spawnSupervised(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): SupervisedProcess {
  const owner = currentProcessIdentity();

  const child: ResultPromise = execa(command, args, {
    cwd: options.cwd,
    env: buildChildEnvironment(options.env),
    extendEnv: false,
    // Own process group, so termination can reach descendants the leader spawned.
    detached: true,
    // execa's own tree termination, on top of the group kill. Belt and braces: it
    // handles Windows (taskkill), where process groups do not exist.
    killDescendants: true,
    forceKillAfterDelay: 5_000,
    // Codex hangs indefinitely on a non-TTY stdin with no writer; nothing here needs
    // to write to a child anyway.
    stdin: 'ignore',
    // Do not accumulate the transcript in memory. Runs are long and output is large;
    // it is streamed to JSONL instead.
    buffer: false,
    // Required before `iterable({from: 'all'})` will interleave the two streams.
    all: true,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
  });

  const pgid = child.pid;
  if (pgid === undefined) {
    throw new Error(`failed to spawn ${command}: no pid was assigned`);
  }

  // Settle the promise here rather than leaving it to the caller.
  //
  // A supervised process can be terminated by something that never awaited it — the
  // reaper kills orphaned groups by pgid, and a timeout fires on its own. execa
  // rejects on any non-zero or signalled exit, so without this the ordinary path of
  // "process was killed" surfaces as an unhandled rejection and, under a test runner,
  // fails an unrelated run. `wait()` reads the settled outcome instead.
  const settled: Promise<SupervisedResult> = child.then(
    (result) => ({ exitCode: result.exitCode ?? 0, signal: null, reason: 'completed' as const }),
    (error: unknown) => classifyFailure(error),
  );

  return {
    pgid,
    ownership: {
      pgid,
      ownerPid: owner.pid,
      ownerStart: owner.startedAt,
      startedAt: Date.now(),
    },

    lines(): AsyncIterable<string> {
      // 'all' interleaves stdout and stderr in arrival order, which is what a
      // transcript needs: a tool's error belongs next to the call that caused it.
      //
      // execa types the iterable as string | Uint8Array because `binary` is a runtime
      // option; with it left off, every chunk is a decoded line. Narrowing here keeps
      // that assumption in one place instead of at every consumer.
      return child.iterable({ from: 'all', preserveNewlines: false }) as AsyncIterable<string>;
    },

    wait(): Promise<SupervisedResult> {
      return settled;
    },

    terminate(): void {
      killGroup(pgid);
    },
  };
}

/**
 * Turn an execa rejection into a reason.
 *
 * A non-zero exit is an ordinary outcome here, not an exception: harnesses fail, and
 * distinguishing "the tool ran and said no" from "the tool never ran" is the caller's
 * decision to make.
 */
function classifyFailure(error: unknown): SupervisedResult {
  const failure = error as {
    exitCode?: number;
    signal?: NodeJS.Signals;
    timedOut?: boolean;
    isCanceled?: boolean;
  };

  // Order matters: a timed-out or cancelled process is also signalled, so those more
  // specific causes are tested first.
  const reason: ExitReason = failure.timedOut
    ? 'timeout'
    : failure.isCanceled
      ? 'cancelled'
      : failure.signal !== undefined
        ? 'terminated'
        : failure.exitCode !== undefined
          ? 'completed'
          : 'error';

  return {
    exitCode: failure.exitCode ?? null,
    signal: failure.signal ?? null,
    reason,
  };
}
