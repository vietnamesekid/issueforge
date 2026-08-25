import type {
  ArtifactRecord,
  IssueLock,
  ProcessOwnership,
  RunState,
  TaskAttempt,
} from '@issueforge/contracts';
import { RunState as RunStateSchema } from '@issueforge/contracts';

/**
 * The boundary between SQL rows and domain types.
 *
 * Everything snake_case lives here and nowhere else, so the store reads in domain
 * language and a schema change lands in one file.
 *
 * Rows are validated on the way out. This database IS the recovery path — a row that
 * cannot produce a valid domain object is a real problem, and failing loudly beats
 * quietly coercing a half-written run back into circulation.
 */

export interface RunRow {
  id: string;
  repo: string;
  issue_number: number;
  task: string;
  status: string;
  base_sha: string;
  harness: string | null;
  workdir: string | null;
  pgid: number | null;
  owner_pid: number | null;
  owner_start: string | null;
  started_at: number | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

export interface LockRow {
  repo: string;
  issue_number: number;
  run_id: string;
  acquired_at: number;
}

export interface TaskRow {
  run_id: string;
  attempt: number;
  harness: string | null;
  pgid: number | null;
  exit_code: number | null;
  outcome: string | null;
  cost_usd: number | null;
  started_at: number;
  ended_at: number | null;
}

export interface ArtifactRow {
  run_id: string;
  path: string;
  kind: string;
  checksum: string | null;
  bytes: number | null;
  created_at: number;
}

/**
 * Include a key only when the column held a value.
 *
 * SQL has one absence (`NULL`); the domain types distinguish "absent" from "present
 * and null" via optional properties, and `exactOptionalPropertyTypes` enforces that.
 * This is the one translation between the two.
 */
function optional<K extends string, V>(key: K, value: V | null): Record<K, V> | Record<string, never> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Ownership is stored as four columns but is meaningful only as a whole: a pgid
 * without its owner cannot be acted on, because deciding whether a process group is
 * an orphan requires knowing whether the supervisor that owned it is still alive.
 */
function toOwnership(row: RunRow): ProcessOwnership | undefined {
  if (row.pgid === null || row.owner_pid === null || row.owner_start === null) return undefined;
  return {
    pgid: row.pgid,
    ownerPid: row.owner_pid,
    ownerStart: row.owner_start,
    startedAt: row.started_at ?? 0,
  };
}

export function toRunState(row: RunRow): RunState {
  const ownership = toOwnership(row);
  return RunStateSchema.parse({
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    task: row.task,
    status: row.status,
    baseSha: row.base_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...optional('harness', row.harness),
    ...optional('workdir', row.workdir),
    ...optional('detail', row.detail),
    ...(ownership ? { ownership } : {}),
  });
}

export function toIssueLock(row: LockRow): IssueLock {
  return {
    repo: row.repo,
    issueNumber: row.issue_number,
    runId: row.run_id,
    acquiredAt: row.acquired_at,
  };
}

export function toTaskAttempt(row: TaskRow): TaskAttempt {
  return {
    runId: row.run_id,
    attempt: row.attempt,
    startedAt: row.started_at,
    ...optional('harness', row.harness as TaskAttempt['harness'] | null),
    ...optional('pgid', row.pgid),
    ...optional('exitCode', row.exit_code),
    ...optional('outcome', row.outcome as TaskAttempt['outcome'] | null),
    ...optional('costUsd', row.cost_usd),
    ...optional('endedAt', row.ended_at),
  };
}

export function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    runId: row.run_id,
    path: row.path,
    kind: row.kind as ArtifactRecord['kind'],
    createdAt: row.created_at,
    ...optional('checksum', row.checksum),
    ...optional('bytes', row.bytes),
  };
}
