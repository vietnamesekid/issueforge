import { z } from 'zod';
import { HarnessName, RepoSlug, RunId, RunStatus, Sha, TaskKind } from './common.js';

/**
 * Durable run state. The database is the source of truth, not the running process:
 * the supervisor may be killed with ~7.5s notice and no chance to finish, so every
 * transition is written BEFORE its side effect and must be recoverable afterwards.
 */

/**
 * Ownership record for a spawned process group.
 *
 * An orphan cannot be detected from `status`: a SIGKILLed supervisor never updates
 * its own row, so the run stays `running` forever. It is detected structurally
 * instead — a live process group whose owning supervisor is gone. `ownerStart`
 * (the owner's process start time) is required so a recycled PID is not mistaken
 * for a live owner.
 */
export const ProcessOwnership = z.object({
  pgid: z.number().int().positive(),
  ownerPid: z.number().int().positive(),
  ownerStart: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
});

export const RunState = z.object({
  id: RunId,
  repo: RepoSlug,
  issueNumber: z.number().int().positive(),
  task: TaskKind,
  status: RunStatus,
  baseSha: Sha,
  harness: HarnessName.optional(),
  workdir: z.string().min(1).optional(),
  ownership: ProcessOwnership.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Why the run ended in its current state, for the status comment. */
  detail: z.string().optional(),
});

/** Why a single harness invocation ended. */
export const TaskOutcome = z.enum(['completed', 'timeout', 'cancelled', 'error']);

/**
 * One harness invocation.
 *
 * A run can attempt more than once — `issueforge:retry` is an intent label — and each
 * attempt has its own process, exit state, duration and cost. `RunState` holds only
 * the *current* state, so without this a retry would erase the record of why the
 * previous attempt failed.
 */
export const TaskAttempt = z.object({
  runId: RunId,
  /** 1-based, unique per run. */
  attempt: z.number().int().positive(),
  harness: HarnessName.optional(),
  /** Process group of this attempt, kept for post-hoc diagnosis. */
  pgid: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  outcome: TaskOutcome.optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
});

/** A file a run produced, tracked so retention can find and remove it later. */
export const ArtifactRecord = z.object({
  runId: RunId,
  path: z.string().min(1),
  kind: z.enum(['patch', 'result', 'events', 'log', 'other']),
  checksum: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
});

/** Prevents two runs holding the same issue on one machine. */
export const IssueLock = z.object({
  repo: RepoSlug,
  issueNumber: z.number().int().positive(),
  runId: RunId,
  acquiredAt: z.number().int().nonnegative(),
});

export type ProcessOwnership = z.infer<typeof ProcessOwnership>;
export type RunState = z.infer<typeof RunState>;
export type IssueLock = z.infer<typeof IssueLock>;
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;
export type TaskAttempt = z.infer<typeof TaskAttempt>;
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/**
 * The observable stages of a run, in the order they occur.
 *
 * These are the transitions `TaskRunner` ALREADY makes; naming them is what lets the
 * CLI show progress during the minutes a run takes, instead of printing nothing until
 * it finishes. Deliberately coarse: this is IssueForge reporting on its own supervision
 * — setting a workspace up, spawning, auditing — and never the agent's reasoning. The
 * harness reports its findings to the issue, which is the design.
 *
 * A phase is not a status. `RunStatus` is what the ledger records and what a retry
 * would resume from; a phase is transient and nothing branches on it.
 */
export const RunPhase = z.enum([
  'reaping',
  'locking',
  'cloning',
  'preparing',
  'spawning',
  'working',
  'auditing',
  'finishing',
]);

/** A phase starting, with a human-readable line for the terminal. */
export const RunPhaseEvent = z.object({
  phase: RunPhase,
  detail: z.string().optional(),
  at: z.number().int().nonnegative(),
});

export type RunPhase = z.infer<typeof RunPhase>;
export type RunPhaseEvent = z.infer<typeof RunPhaseEvent>;
