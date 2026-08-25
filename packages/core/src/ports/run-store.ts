import type {
  ArtifactRecord,
  IssueKey,
  IssueLock,
  ProcessOwnership,
  RepoSlug,
  RunId,
  RunState,
  RunStatus,
  TaskAttempt,
  TaskOutcome,
} from '@issueforge/contracts';

/**
 * The persistence port. `core` declares it; an adapter implements it.
 *
 * Deliberately narrow: this is a recovery ledger, not a platform database. Every
 * method exists because some recovery or safety property depends on it, and the
 * interface is small enough that swapping SQLite for anything else is an afternoon.
 *
 * Implementations MUST be synchronous. The interrupt handler has a ~7.5s budget and
 * runs while a process-tree kill is inbound; awaiting a promise there is how state
 * gets lost. `node:sqlite` is synchronous by design, which is one reason it was chosen.
 */
export interface RunStore {
  /** Idempotent. Safe to call on every process start. */
  migrate(): void;

  createRun(run: RunState): void;

  getRun(id: RunId): RunState | null;

  /**
   * Persist a state transition.
   *
   * Callers MUST write the transition BEFORE performing its side effect, so that a
   * kill at any instant leaves a row that is recoverable rather than a side effect
   * nobody recorded.
   */
  updateRun(id: RunId, patch: RunPatch): void;

  listRuns(filter?: RunFilter): RunState[];

  /**
   * Acquire the per-issue lock. Returns false if another live run holds it.
   * One run per issue per machine; concurrency across issues is fine.
   */
  tryAcquireLock(lock: IssueLock): boolean;

  releaseLock(issue: IssueKey): void;

  getLock(issue: IssueKey): IssueLock | null;

  /**
   * Runs whose process group may still be alive. Used by the reaper on every
   * invocation, because an orphan cannot be detected from `status` alone: a
   * SIGKILLed supervisor never gets to update its own row.
   */
  listReapCandidates(): Array<{ run: RunState; ownership: ProcessOwnership }>;

  /**
   * Record a harness invocation. One row per attempt, so a retry adds history rather
   * than overwriting why the previous attempt failed.
   */
  startAttempt(attempt: TaskAttempt): void;

  /** Close out the most recent attempt for a run with how it ended. */
  finishAttempt(runId: RunId, outcome: TaskAttemptOutcome): void;

  listAttempts(runId: RunId): TaskAttempt[];

  recordArtifact(artifact: ArtifactRecord): void;

  listArtifacts(runId: RunId): ArtifactRecord[];

  close(): void;
}

/** How an attempt ended. Everything here is known only once the process is gone. */
export interface TaskAttemptOutcome {
  outcome: TaskOutcome;
  exitCode?: number;
  costUsd?: number;
  endedAt: number;
}

export interface RunPatch {
  status?: RunStatus;
  harness?: RunState['harness'];
  workdir?: string;
  ownership?: ProcessOwnership | null;
  detail?: string;
}

export interface RunFilter {
  repo?: RepoSlug;
  issueNumber?: number;
  status?: RunStatus | RunStatus[];
  limit?: number;
}

