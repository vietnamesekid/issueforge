/**
 * Schema migrations.
 *
 * Deliberately hand-rolled: an ordered array plus SQLite's `user_version` pragma is
 * about forty lines and has no dependency, no CLI, and no generated artefacts to keep
 * in sync. A migration framework would be a larger commitment than this schema
 * justifies.
 *
 * Rules:
 *  - APPEND ONLY. Never edit a shipped migration; a user's database has already run it.
 *  - Each entry runs inside one transaction together with the `user_version` bump, so a
 *    crash mid-migration leaves the database at the previous version rather than halfway.
 */
export const MIGRATIONS: readonly string[] = [
  // v1 — initial schema
  `
  CREATE TABLE runs (
    id            TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,
    issue_number  INTEGER NOT NULL,
    task          TEXT NOT NULL,
    status        TEXT NOT NULL,
    base_sha      TEXT NOT NULL,
    harness       TEXT,
    workdir       TEXT,
    -- Process ownership. An orphan is a live process group whose owning supervisor
    -- is gone; owner_start (the owner's process start time) is what makes that safe
    -- to act on, because PIDs are recycled.
    pgid          INTEGER,
    owner_pid     INTEGER,
    owner_start   TEXT,
    started_at    INTEGER,
    detail        TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX idx_runs_issue  ON runs (repo, issue_number);
  CREATE INDEX idx_runs_status ON runs (status);

  -- One live run per issue per machine. The PRIMARY KEY is the mutual exclusion:
  -- a second INSERT fails rather than racing a read-then-write.
  CREATE TABLE locks (
    repo          TEXT NOT NULL,
    issue_number  INTEGER NOT NULL,
    run_id        TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    acquired_at   INTEGER NOT NULL,
    PRIMARY KEY (repo, issue_number)
  ) STRICT;

  CREATE TABLE artifacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    checksum    TEXT,
    bytes       INTEGER,
    created_at  INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX idx_artifacts_run ON artifacts (run_id);

  -- One row per harness invocation. A run can attempt more than once (retry), and
  -- each attempt has its own process, exit state, duration and cost — so this is
  -- where "what actually happened, and how many times" lives. The runs table holds
  -- only the current state; without this, a retry would overwrite the record of why
  -- the previous attempt failed.
  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    attempt      INTEGER NOT NULL,
    harness      TEXT,
    -- Process group of this attempt, for post-hoc diagnosis. Live-process tracking
    -- stays on 'runs', which is what the reaper reads.
    pgid         INTEGER,
    exit_code    INTEGER,
    -- Why the attempt ended: completed | timeout | cancelled | budget | error.
    outcome      TEXT,
    cost_usd     REAL,
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER
  ) STRICT;

  CREATE INDEX idx_tasks_run ON tasks (run_id);
  CREATE UNIQUE INDEX idx_tasks_attempt ON tasks (run_id, attempt);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
