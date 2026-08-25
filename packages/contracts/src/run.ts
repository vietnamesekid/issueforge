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
