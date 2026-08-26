import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '@issueforge/contracts';
import { repoSlug, runId, sha } from '@issueforge/contracts';
import { SqliteRunStore } from '@issueforge/adapters';
import type { AppContext } from '../context.js';
import { collectStatus, renderStatusTable } from './status.js';

let root: string;
let store: SqliteRunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'if-status-'));
  store = new SqliteRunStore(join(root, 'runs.db'));
  store.migrate();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** A finished run in the ledger. `at` drives ordering, which is what status reports. */
function finishedRun(
  id: string,
  issueNumber: number,
  status: RunState['status'],
  at: number,
  detail?: string,
): RunState {
  const run: RunState = {
    id: runId(id),
    repo: repoSlug(),
    issueNumber,
    task: 'reproduce',
    status,
    baseSha: sha(),
    harness: 'claude-code',
    createdAt: at,
    updatedAt: at,
    ...(detail === undefined ? {} : { detail }),
  };
  store.createRun(run);
  return run;
}

const context = () => ({ store, root }) as unknown as AppContext;

describe('collectStatus', () => {
  it('returns nothing on a fresh install rather than failing', () => {
    expect(collectStatus(context())).toEqual([]);
  });

  it('reports a run the supervisor never finished writing', () => {
    // The reason transitions are written before their side effects: a run whose
    // supervisor was SIGKILLed still has to be visible here, in whatever state it
    // reached, or the user has no way to see that anything happened at all.
    finishedRun('killed11', 7, 'running', 1_000);

    const [row] = collectStatus(context());

    expect(row?.status).toBe('running');
    expect(row?.issue).toBe(7);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) finishedRun(`run${i}0000`, i, 'reproduced', 1_000 + i);
    expect(collectStatus(context(), 2)).toHaveLength(2);
  });

  it('renders updatedAt as an ISO timestamp, not a raw epoch', () => {
    // The ledger stores milliseconds; a bare number in the output would be unusable
    // to the person reading it.
    finishedRun('stamped1', 3, 'fixed', Date.UTC(2026, 0, 2, 3, 4, 5));

    expect(collectStatus(context())[0]?.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('turns a missing detail into an empty string', () => {
    // renderStatusTable interpolates detail directly; `undefined` would print the
    // word "undefined" to the user.
    finishedRun('nodetail', 4, 'cancelled', 2_000);

    expect(collectStatus(context())[0]?.detail).toBe('');
  });
});

describe('renderStatusTable', () => {
  it('says there is nothing rather than printing an empty table', () => {
    expect(renderStatusTable([])).toBe('No runs yet.');
  });

  it('puts one run per line, with its status, issue and id', () => {
    finishedRun('shown111', 12, 'fixed', 3_000, 'opened a draft PR');

    const text = renderStatusTable(collectStatus(context()));

    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('fixed');
    expect(text).toContain('#12');
    expect(text).toContain('shown111');
    expect(text).toContain('opened a draft PR');
  });

  it('keeps the run id readable when a status is long', () => {
    // Statuses vary from "fixed" to "cannot-reproduce"; without padding the id
    // column moves line to line and the output stops being scannable.
    finishedRun('short111', 1, 'fixed', 4_000);
    finishedRun('longer11', 2, 'cannot-reproduce', 5_000);

    const lines = renderStatusTable(collectStatus(context())).split('\n');
    const columns = lines.map((line) => line.indexOf('#'));

    expect(new Set(columns).size).toBe(1);
  });
});
