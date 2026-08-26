import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ArtifactRecord,
  IssueKey,
  IssueLock,
  ProcessOwnership,
  RunId,
  RunState,
  TaskAttempt,
} from '@issueforge/contracts';
import type { RunFilter, RunPatch, RunStore, TaskAttemptOutcome } from '@issueforge/core';
import { MIGRATIONS } from './migrations.js';
import { loadSqlite, type Database } from './sqlite-loader.js';
import {
  toArtifactRecord,
  toIssueLock,
  toRunState,
  toTaskAttempt,
  type ArtifactRow,
  type LockRow,
  type RunRow,
  type TaskRow,
} from './rows.js';
import { ClauseList, placeholders, toArray } from './sql.js';

/** How long to wait for another process holding a write lock before giving up. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * `node:sqlite` implementation of the RunStore port.
 *
 * A local recovery ledger, not a platform database. It exists so a run killed at any
 * instant — including by the process-tree kill that follows a workflow cancellation —
 * leaves a row that can be read back and reconciled.
 *
 * Synchronous throughout, matching the port: the interrupt handler cannot await.
 */
export class SqliteRunStore implements RunStore {
  readonly #db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new (loadSqlite().DatabaseSync)(path);

    // Order matters. Converting a fresh database to WAL takes an exclusive lock, and
    // with no timeout configured yet a second process racing the same cold start
    // fails immediately with "database is locked" — observed in 6 of 8 attempts.
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#enableWal();
    this.#db.exec('PRAGMA foreign_keys = ON');
    // NORMAL is the documented pairing with WAL: durable against process death, which
    // is the failure mode we actually face, without an fsync per commit.
    this.#db.exec('PRAGMA synchronous = NORMAL');
  }

  /**
   * Bring the schema up to date. Idempotent, and safe to run concurrently.
   *
   * The version is re-read INSIDE the write transaction. Reading it outside would be
   * a time-of-check/time-of-use race: two processes starting together both see
   * version 0, both decide to run migration 1, and the loser fails with
   * "table runs already exists". `BEGIN IMMEDIATE` serialises the writers, so by the
   * time the loser holds the lock the winner has already bumped the version — and
   * re-reading it there turns the second attempt into a no-op.
   */
  migrate(): void {
    for (;;) {
      const applied = this.#transaction(() => {
        const version = this.#userVersion;
        const sql = version < MIGRATIONS.length ? MIGRATIONS[version] : undefined;
        if (sql === undefined) return false;

        // The version bump shares this transaction, so a crash part-way rolls back
        // to the previous version rather than landing in between.
        this.#db.exec(sql);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
        return true;
      });
      if (!applied) return;
    }
  }

  createRun(run: RunState): void {
    this.#db
      .prepare(
        `INSERT INTO runs (id, repo, issue_number, task, status, base_sha, harness, workdir,
                           pgid, owner_pid, owner_start, started_at, detail, created_at, updated_at)
         VALUES (${placeholders(15)})`,
      )
      .run(
        run.id,
        run.repo,
        run.issueNumber,
        run.task,
        run.status,
        run.baseSha,
        run.harness ?? null,
        run.workdir ?? null,
        ...ownershipColumns(run.ownership),
        run.detail ?? null,
        run.createdAt,
        run.updatedAt,
      );
  }

  getRun(id: RunId): RunState | null {
    const row = this.#queryOne<RunRow>('SELECT * FROM runs WHERE id = ?', id);
    return row ? toRunState(row) : null;
  }

  updateRun(id: RunId, patch: RunPatch): void {
    const assignments = new ClauseList()
      .add('updated_at = ?', Date.now())
      .addIfDefined('status = ?', patch.status)
      .addIfDefined('harness = ?', patch.harness)
      .addIfDefined('workdir = ?', patch.workdir)
      .addIfDefined('detail = ?', patch.detail);

    // `null` clears ownership (the process group is gone); `undefined` leaves it alone.
    if (patch.ownership !== undefined) {
      assignments.add(
        'pgid = ?, owner_pid = ?, owner_start = ?, started_at = ?',
        ...ownershipColumns(patch.ownership),
      );
    }

    this.#db
      .prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...assignments.values, id);
  }

  listRuns(filter: RunFilter = {}): RunState[] {
    const where = new ClauseList()
      .addIfDefined('repo = ?', filter.repo)
      .addIfDefined('issue_number = ?', filter.issueNumber);

    if (filter.status !== undefined) {
      const statuses = toArray(filter.status);
      where.add(`status IN (${placeholders(statuses.length)})`, ...statuses);
    }

    const sql = [
      'SELECT * FROM runs',
      where.isEmpty ? '' : `WHERE ${where.join(' AND ')}`,
      'ORDER BY created_at DESC',
      filter.limit === undefined ? '' : 'LIMIT ?',
    ]
      .filter(Boolean)
      .join(' ');

    const values = filter.limit === undefined ? where.values : [...where.values, filter.limit];
    return this.#queryAll<RunRow>(sql, ...values).map(toRunState);
  }

  tryAcquireLock(lock: IssueLock): boolean {
    try {
      this.#db
        .prepare(`INSERT INTO locks (repo, issue_number, run_id, acquired_at) VALUES (${placeholders(4)})`)
        .run(lock.repo, lock.issueNumber, lock.runId, lock.acquiredAt);
      return true;
    } catch {
      // The PRIMARY KEY is the mutual exclusion: a conflicting insert fails rather
      // than racing a read-then-write. Any other failure also means "not acquired".
      return false;
    }
  }

  releaseLock({ repo, issueNumber }: IssueKey): void {
    this.#db.prepare('DELETE FROM locks WHERE repo = ? AND issue_number = ?').run(repo, issueNumber);
  }

  getLock({ repo, issueNumber }: IssueKey): IssueLock | null {
    const row = this.#queryOne<LockRow>(
      'SELECT * FROM locks WHERE repo = ? AND issue_number = ?',
      repo,
      issueNumber,
    );
    return row ? toIssueLock(row) : null;
  }

  listReapCandidates(): { run: RunState; ownership: ProcessOwnership }[] {
    // Every run that recorded a process group and has not cleared it. Whether the
    // group is still alive, and whether its owner is, can only be answered against
    // the OS — a killed supervisor never got to update its own row.
    return this.#queryAll<RunRow>('SELECT * FROM runs WHERE pgid IS NOT NULL AND owner_pid IS NOT NULL')
      .map(toRunState)
      .flatMap((run) => (run.ownership ? [{ run, ownership: run.ownership }] : []));
  }

  startAttempt(attempt: TaskAttempt): void {
    this.#db
      .prepare(
        `INSERT INTO tasks (run_id, attempt, harness, pgid, exit_code, outcome,
                            started_at, ended_at)
         VALUES (${placeholders(8)})`,
      )
      .run(
        attempt.runId,
        attempt.attempt,
        attempt.harness ?? null,
        attempt.pgid ?? null,
        attempt.exitCode ?? null,
        attempt.outcome ?? null,
        attempt.startedAt,
        attempt.endedAt ?? null,
      );
  }

  finishAttempt(runId: RunId, outcome: TaskAttemptOutcome): void {
    // Targets the highest attempt number rather than taking one as a parameter: the
    // caller is the supervisor that just started it, and threading the number back
    // through would be one more thing to get out of step.
    this.#db
      .prepare(
        `UPDATE tasks SET outcome = ?, exit_code = ?, ended_at = ?
         WHERE run_id = ? AND attempt = (SELECT MAX(attempt) FROM tasks WHERE run_id = ?)`,
      )
      .run(
        outcome.outcome,
        outcome.exitCode ?? null,
        outcome.endedAt,
        runId,
        runId,
      );
  }

  listAttempts(runId: RunId): TaskAttempt[] {
    return this.#queryAll<TaskRow>(
      'SELECT * FROM tasks WHERE run_id = ? ORDER BY attempt ASC',
      runId,
    ).map(toTaskAttempt);
  }

  recordArtifact(artifact: ArtifactRecord): void {
    this.#db
      .prepare(
        `INSERT INTO artifacts (run_id, path, kind, checksum, bytes, created_at)
         VALUES (${placeholders(6)})`,
      )
      .run(
        artifact.runId,
        artifact.path,
        artifact.kind,
        artifact.checksum ?? null,
        artifact.bytes ?? null,
        artifact.createdAt,
      );
  }

  listArtifacts(runId: RunId): ArtifactRecord[] {
    return this.#queryAll<ArtifactRow>(
      'SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC',
      runId,
    ).map(toArtifactRecord);
  }

  close(): void {
    this.#db.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * `node:sqlite` types rows as `Record<string, SQLOutputValue>`. Casting is confined
   * to these two helpers so the rest of the class reads in row types.
   *
   * The type parameter appears once by design: it is how a caller names the row shape
   * it expects (`#queryOne<RunRow>(...)`), which is the whole point of the seam.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
  #queryOne<T>(sql: string, ...values: readonly (string | number)[]): T | undefined {
    return this.#db.prepare(sql).get(...values) as unknown as T | undefined;
  }

  #queryAll<T>(sql: string, ...values: readonly (string | number | null)[]): T[] {
    return this.#db.prepare(sql).all(...values) as unknown as T[];
  }

  /** Run `work` in an immediate (write-reserving) transaction and return its result. */
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Convert to WAL, tolerating a concurrent converter.
   *
   * `busy_timeout` is not reliably applied to the exclusive lock taken during a
   * journal-mode change, so two processes cold-starting the same database can still
   * collide. Whoever loses retries; by then the winner has finished and the mode is
   * already WAL, making the retry a no-op read.
   */
  #enableWal(): void {
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (;;) {
      try {
        this.#db.exec('PRAGMA journal_mode = WAL');
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        const until = Date.now() + 20;
        while (Date.now() < until) {
          /* brief spin; this races only on a cold start and resolves in milliseconds */
        }
      }
    }
  }

  get #userVersion(): number {
    const row = this.#queryOne<{ user_version: number }>('PRAGMA user_version');
    return row?.user_version ?? 0;
  }
}

/** Ownership's four columns, in schema order. Kept together so callers cannot misorder them. */
function ownershipColumns(
  ownership: ProcessOwnership | null | undefined,
): [number | null, number | null, string | null, number | null] {
  return [
    ownership?.pgid ?? null,
    ownership?.ownerPid ?? null,
    ownership?.ownerStart ?? null,
    ownership?.startedAt ?? null,
  ];
}
