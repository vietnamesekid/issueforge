import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  HarnessCapabilities,
  HarnessEvent,
  HarnessRunOutcome,
  IssueForgeConfig,
  ProcessOwnership,
  Sha,
} from '@issueforge/contracts';
import { IssueForgeConfig as ConfigSchema, sha } from '@issueforge/contracts';
import { HarnessContractError, type HarnessAdapter, type HarnessRun } from '@issueforge/core';
import {
  GitWorkspaceManager,
  TaskRunner,
  SqliteRunStore,
  createLogger,
  reapOrphans,
} from '@issueforge/adapters';
import { BUGGY_SOURCE, GENUINE_REPRO, buildOrigin } from '../fixtures/build-fixture.js';

/**
 * The v0.1 slice, end to end.
 *
 * What this proves is ORCHESTRATION: a task reaches a harness with a workspace pinned
 * to the right commit, the run is recorded so it survives being killed, the issue lock
 * is held and released, and no processes are left behind.
 *
 * It deliberately does not judge the harness's findings. Those go to the issue, where
 * a human reviews them — an earlier design replayed the evidence here and rejected a
 * correct reproduction three separate times in live runs, each because a free agent
 * had chosen a form the check did not anticipate.
 */

let dir: string;
let origin: string;
let root: string;
let baseSha: Sha;
let store: SqliteRunStore;

const REPO = 'owner/fixture';
const config: IssueForgeConfig = ConfigSchema.parse({});
const logger = createLogger({ level: 'fatal' });

/** A harness under the test's control, standing in for a real one. */
class ScriptedHarness implements HarnessAdapter {
  readonly name = 'claude-code' as const;
  files: Record<string, string> = {};
  claim: Record<string, unknown> | undefined;
  ok = true;
  failure: Error | undefined;
  observedCwd: string | undefined;
  observedToken: string | undefined;

  async detect(): Promise<HarnessCapabilities> {
    return { installed: true, version: 'scripted', authenticated: true };
  }

  run(request: { cwd: string; githubToken?: string }): HarnessRun {
    this.observedCwd = request.cwd;
    this.observedToken = request.githubToken;

    for (const [relative, contents] of Object.entries(this.files)) {
      const path = join(request.cwd, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }

    const events: HarnessEvent[] = [
      { type: 'session_started', sessionId: 'e2e', tools: ['Read', 'Write'], mcpServers: [] },
      { type: 'text', text: 'looked at the code' },
    ];
    const outcome: HarnessRunOutcome = {
      harness: 'claude-code',
      ok: this.ok,
      denials: 0,
      injectionSuspected: false,
      exitCode: 0,
      ...(this.claim !== undefined ? { result: this.claim as never } : {}),
    };
    const ownership: ProcessOwnership = {
      pgid: process.pid,
      ownerPid: process.pid,
      ownerStart: 'scripted',
      startedAt: Date.now(),
    };
    const failure = this.failure;

    return {
      pgid: ownership.pgid,
      ownership,
      async *events() { for (const event of events) yield event; },
      async outcome() {
        if (failure !== undefined) throw failure;
        return outcome;
      },
      cancel() {},
    };
  }
}

let harness: ScriptedHarness;
let runner: TaskRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-e2e-'));
  origin = join(dir, 'origin');
  root = join(dir, 'home');
  baseSha = sha(buildOrigin(origin));

  store = new SqliteRunStore(join(root, 'state.db'));
  store.migrate();
  harness = new ScriptedHarness();
  runner = new TaskRunner({
    store,
    workspaces: new GitWorkspaceManager(root),
    harness,
    config,
    logger,
    root,
  });
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const reproduce = (githubToken?: string) =>
  runner.run({
    repo: REPO,
    issueNumber: 7,
    issue: {
      number: 7,
      title: 'parsePair truncates values containing "="',
      body: "parsePair('url=http://x?a=1') returns 'http://x?a' instead of the full value.",
    },
    remote: origin,
    baseSha,
    ...(githubToken !== undefined ? { githubToken } : {}),
  });

const claimed = {
  verdict: 'reproduced',
  reproCommand: ['node', '--test', 'test/repro.test.js'],
  testFile: 'test/repro.test.js',
  summary: 'the value is truncated at the second "="',
};

describe('v0.1 slice — orchestration', { timeout: 120_000 }, () => {
  it('hands the harness a workspace pinned to the requested commit', async () => {
    harness.claim = claimed;
    const result = await reproduce();

    const workdir = store.getRun(result.runId)?.workdir ?? '';
    expect(harness.observedCwd).toBe(workdir);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim()).toBe(
      baseSha,
    );
    // The bug is present at this commit — the point of pinning.
    expect(readFileSync(join(workdir, 'src', 'parse.js'), 'utf8')).toBe(BUGGY_SOURCE);
  });

  it('gives the harness the issue as data in a file, never as a command line', async () => {
    harness.claim = claimed;
    const result = await reproduce();
    const workdir = store.getRun(result.runId)?.workdir ?? '';

    const card = JSON.parse(readFileSync(join(workdir, 'task-card.json'), 'utf8')) as {
      issue: { body: string };
      instructions: string;
    };
    expect(card.issue.body).toContain('url=http://x?a=1');
    expect(card.instructions).toMatch(/UNTRUSTED/);
  });

  it('lets the harness report its own findings', async () => {
    // It posts to the issue itself; IssueForge passes the token and stays out of it.
    harness.claim = claimed;
    await reproduce('gh_token_for_this_run');
    expect(harness.observedToken).toBe('gh_token_for_this_run');
  });

  it('does not second-guess what the harness concluded', async () => {
    // A verdict of cannot-reproduce is recorded as-is. Adjudicating it is the
    // reviewer's job, and three live runs showed us getting that wrong.
    harness.claim = { ...claimed, verdict: 'cannot-reproduce', summary: 'no repro steps given' };
    const result = await reproduce();
    expect(result.outcome?.result?.verdict).toBe('cannot-reproduce');
  });

  it('records the run so it survives the process being killed', async () => {
    harness.claim = claimed;
    const result = await reproduce();

    const run = store.getRun(result.runId);
    expect(run?.baseSha).toBe(baseSha);
    expect(run?.harness).toBe('claude-code');
    expect(store.listAttempts(result.runId)).toHaveLength(1);
    expect(existsSync(join(root, 'runs', result.runId, 'events.jsonl'))).toBe(true);
  });

  it('streams the transcript while the run is live', async () => {
    // A run killed mid-flight must still show how far it got.
    harness.claim = claimed;
    const result = await reproduce();

    const lines = readFileSync(join(root, 'runs', result.runId, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: 'session_started' });
  });

  it('releases the issue so a retry can take it, and keeps the earlier run', async () => {
    harness.claim = claimed;
    const first = await reproduce();
    expect(store.getLock({ repo: REPO, issueNumber: 7 })).toBeNull();

    const second = await reproduce();
    expect(second.runId).not.toBe(first.runId);
    expect(store.listRuns({ repo: REPO, issueNumber: 7 })).toHaveLength(2);
  });

  it('releases the lock even when the harness throws', async () => {
    harness.failure = new Error('harness exploded');
    await reproduce();
    expect(store.getLock({ repo: REPO, issueNumber: 7 })).toBeNull();
  });

  it('BLOCKS a run that touched .github, whatever else it did', async () => {
    // The boundary that remains, and it is not about method: this is how a run would
    // rewrite the workflow that runs it.
    harness.files = {
      'test/repro.test.js': GENUINE_REPRO,
      '.github/workflows/ci.yml': 'name: pwned\n',
    };
    harness.claim = claimed;

    const result = await reproduce();

    expect(result.status).toBe('blocked');
    expect(result.detail).toContain('.github/workflows/ci.yml');
  });

  it('treats a contract breach as blocked, not as a finding about the bug', async () => {
    harness.failure = new HarnessContractError('harness started with MCP servers enabled');
    const result = await reproduce();

    expect(result.status).toBe('blocked');
    expect(result.detail).toMatch(/MCP servers/);
  });

  it('leaves no orphaned processes behind', async () => {
    harness.claim = claimed;
    await reproduce();

    expect(store.listReapCandidates()).toHaveLength(0);
    expect(reapOrphans(store)).toEqual([]);
  });
});
