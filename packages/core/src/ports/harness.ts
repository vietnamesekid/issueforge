import type {
  HarnessCapabilities,
  HarnessEvent,
  HarnessRunOutcome,
  ProcessOwnership,
  TaskCard,
} from '@issueforge/contracts';

/**
 * The port every coding harness is driven through.
 *
 * IssueForge orchestrates the outer workflow; the harness owns its own planning, tool
 * use and editing loop. This interface is deliberately the whole of that boundary —
 * if it ever grows a method about *how* to reason, IssueForge has started becoming a
 * coding agent, which is the one outcome the design exists to avoid.
 *
 * Adapters translate; they do not decide. Whether a run succeeded is settled by
 * replaying its evidence, not by anything a harness reports here.
 */
export interface HarnessAdapter {
  /** Stable identifier, used in logs and to select an adapter from config. */
  readonly name: 'claude-code' | 'codex';

  /**
   * Whether this harness is usable right now.
   *
   * Must answer without spending tokens and without hanging: a missing credential is
   * the common failure, and `doctor` needs to report it as a blocking error rather
   * than letting a run stall.
   */
  detect(): Promise<HarnessCapabilities>;

  /**
   * Run one task to completion.
   *
   * Yields normalised events as they arrive, so a caller can persist a transcript
   * while the run is still going — a run killed mid-flight must leave evidence of
   * how far it got.
   */
  run(request: HarnessRunRequest): HarnessRun;
}

export interface HarnessRunRequest {
  /** Workspace root. The harness is confined here; nothing outside is in scope. */
  cwd: string;
  /** Written to disk and referenced by path — never interpolated into a prompt. */
  taskCard: TaskCard;
  /** Path the task card was written to, relative to `cwd`. */
  taskCardPath: string;
  /** JSON Schema the harness must satisfy in its structured result. */
  resultSchema: unknown;
  /** Correlates the harness session with the run for later diagnosis. */
  sessionId: string;
  /**
   * Token for reporting back to GitHub.
   *
   * The harness posts its own findings — it knows the repository's conventions and a
   * human reviews everything it writes. Absent for a local run with no GitHub side.
   */
  githubToken?: string;
  signal?: AbortSignal;
}

export interface HarnessRun {
  /** Process group, to persist before awaiting so an orphan stays reapable. */
  readonly pgid: number;
  /**
   * Who owns that group, as the supervisor recorded it.
   *
   * Exposed rather than rebuilt by callers: the owner's start time is what makes a
   * recycled PID safe to act on, and a caller that reconstructed it wrongly would
   * disable that guard without any visible symptom.
   */
  readonly ownership: ProcessOwnership;
  events(): AsyncIterable<HarnessEvent>;
  /** Resolves once the process has exited and the stream is drained. */
  outcome(): Promise<HarnessRunOutcome>;
  cancel(): void;
}

/**
 * The harness produced output that cannot be trusted or used.
 *
 * Distinct from a failed run: this means the *contract* was broken — the sandbox was
 * not what was requested, or the result did not match its schema — so the output must
 * not be interpreted at all.
 */
export class HarnessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessContractError';
  }
}

/**
 * Why a harness run ended without producing a result.
 *
 * `timeout` and `cancelled` are supervisor decisions — the wall clock or an operator
 * ended the run. `crashed` is everything else.
 */
export type RunFailureReason = 'timeout' | 'cancelled' | 'crashed';

/**
 * The run ended early, and the supervisor knows why.
 *
 * Carries the reason as a value because the alternative was inferring it from prose:
 * classification used to regex-match the error message for /timed out/ and /cancel/,
 * which meant a harness error merely MENTIONING cancellation became `cancelled` — a
 * terminal status that stops retry — while a reworded upstream timeout message would
 * have silently become a crash. The supervisor already computes this precisely; this
 * type is how it survives the trip to the ledger.
 */
export class HarnessRunError extends Error {
  readonly reason: RunFailureReason;

  constructor(reason: RunFailureReason, message: string) {
    super(message);
    this.name = 'HarnessRunError';
    this.reason = reason;
  }
}
