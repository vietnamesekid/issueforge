import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import { dirname } from 'node:path';
import type {
  IssueLock,
  ProcessOwnership,
  RunId,
  RunState,
  RunStatus,
} from '@issueforge/contracts';
import { RunState as RunStateSchema } from '@issueforge/contracts';
import type { ArtifactRecord, RunFilter, RunPatch, RunStore } from '@issueforge/core';
import { MIGRATIONS } from './migrations.js';
import { suppressSqliteExperimentalWarning } from '../logger/index.js';

/**
 * `node:sqlite` is loaded lazily, on first construction, rather than at module scope.
 *
 * The release-candidate notice fires when the module is LOADED, so it must be
 * silenced first — and a static import cannot be sequenced after anything, because
 * ESM hoists imports and a bundler flattens the file order away. Requiring it from
 * inside the constructor is the only placement where the suppression is guaranteed
 * to already be installed.
 */
type SqliteModule = typeof NodeSqlite;
let sqlite: SqliteModule | undefined;

function loadSqlite(): SqliteModule {
  if (sqlite === undefined) {
    suppressSqliteExperimentalWarning();
    sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  }
  return sqlite;
}

/** Shape of a `runs` row. Kept private: nothing outside this file sees SQL columns. */
interface RunRow {
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

/**
 * `node:sqlite` implementation of the RunStore port.
 *
 * This is a local recovery ledger, not a platform database. It exists so that a run
 * killed at any instant — including by the process-tree kill that follows a workflow
 * cancellation — leaves a row that can be read back and reconciled.
 *
 * Synchronous throughout, matching the port: the interrupt handler cannot await.
 */
export class SqliteRunStore implements RunStore {
  readonly #db: InstanceType<SqliteModule['DatabaseSync']>;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new (loadSqlite().DatabaseSync)(path);

    // busy_timeout MUST come first. Converting a fresh database to WAL takes an
    // exclusive lock, and with no timeout configured yet a second process racing the
    // same cold start fails immediately with SQLITE_BUSY ("database is locked").
    // Observed in 6 of 8 concurrent cold starts before this ordering.
    this.#db.exec('PRAGMA busy_timeout = 5000');

    // WAL lets readers proceed during a write instead of blocking; the CLI and the
    // listener service both open this file.
    this.#enableWal();

    this.#db.exec('PRAGMA foreign_keys = ON');
    // NORMAL is the documented pairing with WAL: durable against process death,
    // which is the failure mode we actually face, without an fsync per commit.
    this.#db.exec('PRAGMA synchronous = NORMAL');
  }

  /**
   * Convert to WAL, tolerating a concurrent converter.
   *
   * busy_timeout alone is not sufficient here: SQLite does not always apply it to the
   * exclusive lock taken during a journal-mode change, so two processes starting
   * against the same fresh database can still collide. Whoever loses simply retries —
   * by then the winner has finished and the mode is already WAL, so the retry is a
   * no-op read.
   */
  #enableWal(): void {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        this.#db.exec('PRAGMA journal_mode = WAL');
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        // Busy-wait briefly; this races only on a cold start and resolves in ms.
        const until = Date.now() + 20;
        while (Date.now() < until) { /* spin */ }
      }
    }
  }

  migrate(): void {
    const current = this.#userVersion();

    for (let version = current; version < MIGRATIONS.length; version++) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) continue;

      // One transaction per migration, including the version bump, so a crash
      // mid-migration rolls back to the previous version rather than landing halfway.
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.exec(sql);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  createRun(run: RunState): void {
    this.#db
      .prepare(
        `INSERT INTO runs (id, repo, issue_number, task, status, base_sha, harness, workdir,
                           pgid, owner_pid, owner_start, started_at, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.ownership?.pgid ?? null,
        run.ownership?.ownerPid ?? null,
        run.ownership?.ownerStart ?? null,
        run.ownership?.startedAt ?? null,
        run.detail ?? null,
        run.createdAt,
        run.updatedAt,
      );
  }

  getRun(id: RunId): RunState | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
    return row ? toRunState(row) : null;
  }

  updateRun(id: RunId, patch: RunPatch): void {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number | null> = [Date.now()];

    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.harness !== undefined) {
      sets.push('harness = ?');
      values.push(patch.harness);
    }
    if (patch.workdir !== undefined) {
      sets.push('workdir = ?');
      values.push(patch.workdir);
    }
    if (patch.detail !== undefined) {
      sets.push('detail = ?');
      values.push(patch.detail);
    }
    // `null` clears ownership (the process group is gone); `undefined` leaves it alone.
    if (patch.ownership !== undefined) {
      sets.push('pgid = ?', 'owner_pid = ?', 'owner_start = ?', 'started_at = ?');
      values.push(
        patch.ownership?.pgid ?? null,
        patch.ownership?.ownerPid ?? null,
        patch.ownership?.ownerStart ?? null,
        patch.ownership?.startedAt ?? null,
      );
    }

    values.push(id);
    this.#db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  listRuns(filter: RunFilter = {}): RunState[] {
    const where: string[] = [];
    const values: Array<string | number> = [];

    if (filter.repo !== undefined) {
      where.push('repo = ?');
      values.push(filter.repo);
    }
    if (filter.issueNumber !== undefined) {
      where.push('issue_number = ?');
      values.push(filter.issueNumber);
    }
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }

    const sql =
      `SELECT * FROM runs` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at DESC` +
      (filter.limit !== undefined ? ` LIMIT ${Number(filter.limit)}` : '');

    return (this.#db.prepare(sql).all(...values) as unknown as RunRow[]).map(toRunState);
  }

  tryAcquireLock(lock: IssueLock): boolean {
    try {
      this.#db
        .prepare(
          `INSERT INTO locks (repo, issue_number, run_id, acquired_at) VALUES (?, ?, ?, ?)`,
        )
        .run(lock.repo, lock.issueNumber, lock.runId, lock.acquiredAt);
      return true;
    } catch {
      // The PRIMARY KEY is the mutual exclusion: a conflicting insert fails rather
      // than racing a read-then-write. Any other error would also mean "not acquired".
      return false;
    }
  }

  releaseLock(repo: string, issueNumber: number): void {
    this.#db
      .prepare('DELETE FROM locks WHERE repo = ? AND issue_number = ?')
      .run(repo, issueNumber);
  }

  getLock(repo: string, issueNumber: number): IssueLock | null {
    const row = this.#db
      .prepare('SELECT * FROM locks WHERE repo = ? AND issue_number = ?')
      .get(repo, issueNumber) as unknown as
      | { repo: string; issue_number: number; run_id: string; acquired_at: number }
      | undefined;

    return row
      ? {
          repo: row.repo,
          issueNumber: row.issue_number,
          runId: row.run_id,
          acquiredAt: row.acquired_at,
        }
      : null;
  }

  listReapCandidates(): Array<{ run: RunState; ownership: ProcessOwnership }> {
    // Every run that recorded a process group and has not been cleared. Liveness of
    // the group and of its owner is decided by the caller against the OS — the row
    // cannot know, because a killed supervisor never updated it.
    const rows = this.#db
      .prepare('SELECT * FROM runs WHERE pgid IS NOT NULL AND owner_pid IS NOT NULL')
      .all() as unknown as RunRow[];

    return rows.flatMap((row) => {
      const run = toRunState(row);
      return run.ownership ? [{ run, ownership: run.ownership }] : [];
    });
  }

  recordArtifact(artifact: ArtifactRecord): void {
    this.#db
      .prepare(
        `INSERT INTO artifacts (run_id, path, kind, checksum, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
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
    const rows = this.#db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as unknown as Array<{
      run_id: string;
      path: string;
      kind: string;
      checksum: string | null;
      bytes: number | null;
      created_at: number;
    }>;

    return rows.map((row) => ({
      runId: row.run_id,
      path: row.path,
      kind: row.kind as ArtifactRecord['kind'],
      ...(row.checksum !== null ? { checksum: row.checksum } : {}),
      ...(row.bytes !== null ? { bytes: row.bytes } : {}),
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.#db.close();
  }

  #userVersion(): number {
    const row = this.#db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    return row.user_version;
  }
}

/**
 * Map a row to the domain type, validating on the way out.
 *
 * The database is the recovery path, so a row that cannot produce a valid RunState is
 * a real problem worth surfacing loudly rather than a shape to coerce quietly.
 */
function toRunState(row: RunRow): RunState {
  const ownership: ProcessOwnership | undefined =
    row.pgid !== null && row.owner_pid !== null && row.owner_start !== null
      ? {
          pgid: row.pgid,
          ownerPid: row.owner_pid,
          ownerStart: row.owner_start,
          startedAt: row.started_at ?? 0,
        }
      : undefined;

  return RunStateSchema.parse({
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    task: row.task,
    status: row.status as RunStatus,
    baseSha: row.base_sha,
    ...(row.harness !== null ? { harness: row.harness } : {}),
    ...(row.workdir !== null ? { workdir: row.workdir } : {}),
    ...(ownership ? { ownership } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
