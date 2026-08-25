import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  HarnessCapabilities,
  HarnessEvent,
  HarnessRunOutcome,
  ProcessOwnership,
  Sha,
} from '@issueforge/contracts';
import { IssueForgeConfig as ConfigSchema } from '@issueforge/contracts';
import { validateReproduction, type HarnessAdapter, type HarnessRun } from '@issueforge/core';
import {
  GitWorkspaceManager,
  FileDefectToggle,
  ProcessReplayer,
  ReproduceRunner,
  SqliteRunStore,
  createLogger,
  reapOrphans,
} from '@issueforge/adapters';
import {
  BUGGY_SOURCE,
  FIXED_SOURCE,
  GENUINE_REPRO,
  TRIVIAL_REPRO,
  UNRELATED_FAILURE,
  buildOrigin,
} from '../fixtures/build-fixture.js';

/**
 * The v0.1 vertical slice, end to end.
 *
 * Every component is real — ledger, workspace, supervisor, runner, validator — and
 * only the harness is scripted, because a live run costs money and needs a login
 * while proving nothing these cases do not.
 *
 * The point is NOT that a reproduction succeeds. It is that an unsupported claim is
 * REJECTED: a green end-to-end test exercising only the happy path would prove
 * nothing about a product whose entire claim is that it does not trust its agent.
 */

let dir: string;
let origin: string;
let root: string;
let baseSha: Sha;
let store: SqliteRunStore;

const REPO = 'owner/fixture';
const config = ConfigSchema.parse({});
const logger = createLogger({ level: 'fatal' });

/** A harness that writes chosen files and returns a chosen claim. */
class ScriptedHarness implements HarnessAdapter {
  readonly name = 'claude-code' as const;
  files: Record<string, string> = {};
  claim: Record<string, unknown> | undefined;
  ok = true;

  async detect(): Promise<HarnessCapabilities> {
    return { installed: true, version: 'scripted', authenticated: true };
  }

  run(request: { cwd: string }): HarnessRun {
    // Write what the "agent" produced, exactly where a real one would.
    for (const [relative, contents] of Object.entries(this.files)) {
      const path = join(request.cwd, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }

    const events: HarnessEvent[] = [
      { type: 'session_started', sessionId: 'e2e', tools: ['Read', 'Write'], mcpServers: [] },
      { type: 'text', text: 'wrote a regression test' },
    ];
    const outcome: HarnessRunOutcome = {
      harness: 'claude-code',
      ok: this.ok,
      denials: 0,
      injectionSuspected: false,
      costUsd: 0.31,
      exitCode: 0,
      ...(this.claim !== undefined ? { result: this.claim as never } : {}),
    };
    const ownership: ProcessOwnership = {
      pgid: process.pid,
      ownerPid: process.pid,
      ownerStart: 'scripted',
      startedAt: Date.now(),
    };

    return {
      pgid: ownership.pgid,
      ownership,
      async *events() { for (const event of events) yield event; },
      async outcome() { return outcome; },
      cancel() {},
    };
  }
}

let harness: ScriptedHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-e2e-'));
  origin = join(dir, 'origin');
  root = join(dir, 'home');
  baseSha = buildOrigin(origin) as Sha;

  store = new SqliteRunStore(join(root, 'state.db'));
  store.migrate();
  harness = new ScriptedHarness();
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** The whole path: run the task, then replay its evidence independently. */
async function reproduceAndValidate(defect?: FileDefectToggle): Promise<{
  runId: string;
  verdict: string;
  why: string;
  workdir: string;
}> {
  const runner = new ReproduceRunner({
    store,
    workspaces: new GitWorkspaceManager(root),
    harness,
    config,
    logger,
    root,
  });

  const result = await runner.run({
    repo: REPO,
    issueNumber: 7,
    issue: {
      number: 7,
      title: 'parsePair truncates values containing "="',
      body: "parsePair('url=http://x?a=1') returns 'http://x?a' instead of the full value.",
    },
    remote: origin,
    baseSha,
  });

  const run = store.getRun(result.runId);
  const workdir = run?.workdir ?? '';
  const claim = result.outcome?.result;

  if (claim === undefined) {
    return { runId: result.runId, verdict: result.status, why: result.detail, workdir };
  }

  const validation = await validateReproduction({
    claim,
    cwd: workdir,
    baseSha,
    headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim() as Sha,
    changedFiles: execFileSync('git', ['status', '--porcelain'], { cwd: workdir, encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3).trim()),
    readArtifact: (path) => {
      try { return readFileSync(join(workdir, path), 'utf8'); } catch { return null; }
    },
    replayer: new ProcessReplayer(),
    timeoutMs: 30_000,
    ...(defect !== undefined ? { defect } : {}),
  });

  store.updateRun(result.runId, { status: validation.verdict, detail: validation.why });
  return { runId: result.runId, verdict: validation.verdict, why: validation.why, workdir };
}

describe('v0.1 vertical slice', { timeout: 120_000 }, () => {
  it('confirms a genuine reproduction of a real bug', async () => {
    harness.files = { 'test/repro.test.js': GENUINE_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'the value is truncated at the second "="',
    };

    const { runId, verdict, workdir } = await reproduceAndValidate();

    expect(verdict).toBe('reproduced');

    // The whole ledger tells a coherent story afterwards.
    const run = store.getRun(runId);
    expect(run?.status).toBe('reproduced');
    expect(run?.baseSha).toBe(baseSha);
    expect(store.listAttempts(runId)).toHaveLength(1);
    expect(store.listAttempts(runId)[0]?.costUsd).toBe(0.31);

    // The transcript survives the run.
    expect(existsSync(join(root, 'runs', runId, 'events.jsonl'))).toBe(true);

    // The workspace is pinned, and the evidence is still there to inspect.
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim()).toBe(
      baseSha,
    );
    expect(readFileSync(join(workdir, 'src', 'parse.js'), 'utf8')).toBe(BUGGY_SOURCE);
  });

  it('REJECTS a claim when the bug is not actually present', async () => {
    // The adversarial case, and the reason this product exists. The agent asserts a
    // reproduction; the code is already correct; the claim must not survive.
    rmSync(origin, { recursive: true, force: true });
    baseSha = buildOrigin(origin, FIXED_SOURCE) as Sha;

    harness.files = { 'test/repro.test.js': GENUINE_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'claims a bug that is not there',
    };

    const { runId, verdict, why } = await reproduceAndValidate();

    expect(verdict).toBe('cannot-reproduce');
    expect(why).toMatch(/PASSED on the pinned base/);
    expect(store.getRun(runId)?.status).toBe('cannot-reproduce');
  });

  it('marks the differential as unproven when no fix is available to diff against', async () => {
    // Replay alone cannot separate a genuine reproduction from a failure that has
    // nothing to do with the bug — both simply fail. With no fix to remove the
    // defect, the gap is recorded rather than papered over: the verdict stands, but
    // the check is visibly unproven.
    harness.files = { 'test/repro.test.js': UNRELATED_FAILURE };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'unrelated assertion',
    };

    const { why } = await reproduceAndValidate();

    expect(why).toMatch(/differential check not available/);
  });

  it('REJECTS an unrelated failure once a fix IS available to diff against', async () => {
    // The case nothing else catches. The test really fails, and keeps failing after
    // the defect is removed — so it never demonstrated the reported bug at all.
    harness.files = { 'test/repro.test.js': UNRELATED_FAILURE };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'unrelated assertion',
    };

    const { verdict, why } = await reproduceAndValidate(
      new FileDefectToggle(new Map([['src/parse.js', FIXED_SOURCE]])),
    );

    expect(verdict).toBe('cannot-reproduce');
    expect(why).toMatch(/does not isolate the reported bug/);
  });

  it('confirms a genuine reproduction THROUGH the differential check', async () => {
    // Fails on the bug, passes without it — the strongest evidence available.
    harness.files = { 'test/repro.test.js': GENUINE_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'truncation at the second "="',
    };

    const { verdict, why, workdir } = await reproduceAndValidate(
      new FileDefectToggle(new Map([['src/parse.js', FIXED_SOURCE]])),
    );

    expect(verdict).toBe('reproduced');
    expect(why).toMatch(/disappears once the defect is removed/);
    // The workspace is the evidence, so the defect must be back afterwards.
    expect(readFileSync(join(workdir, 'src', 'parse.js'), 'utf8')).toBe(BUGGY_SOURCE);
  });

  it('REJECTS a reproduction script that only exits non-zero', async () => {
    // Inside the allowed paths, so the write boundary lets it through and the
    // validator is the one that judges it — which is the layer that should.
    harness.files = { 'test/repro.sh': TRIVIAL_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['sh', 'test/repro.sh'],
      summary: 'lazy repro',
    };

    const { verdict, why } = await reproduceAndValidate();

    expect(verdict).toBe('cannot-reproduce');
    expect(why).toMatch(/does nothing but exit/);
  });

  it('BLOCKS a run that wrote outside its permitted paths', async () => {
    // A reproduce task adds evidence; it does not edit source. A run that did is
    // reported as `blocked`, never as a verdict — it misbehaved, which says nothing
    // about the bug, and calling it `cannot-reproduce` would be false.
    harness.files = {
      'test/repro.test.js': GENUINE_REPRO,
      'src/parse.js': FIXED_SOURCE, // "helpfully" fixed the bug it was asked to reproduce
    };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 'also fixed it',
    };

    const { runId, verdict, why } = await reproduceAndValidate();

    expect(verdict).toBe('blocked');
    expect(why).toMatch(/outside its permitted paths/);
    expect(why).toContain('src/parse.js');
    expect(store.getRun(runId)?.status).toBe('blocked');
  });

  it('BLOCKS a run that touched .github, whatever else it did', async () => {
    // This is how a run would rewrite the workflow that runs it.
    harness.files = {
      'test/repro.test.js': GENUINE_REPRO,
      '.github/workflows/ci.yml': 'name: pwned\n',
    };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 's',
    };

    const { verdict, why } = await reproduceAndValidate();

    expect(verdict).toBe('blocked');
    expect(why).toContain('.github/workflows/ci.yml');
  });

  it('reports needs-info when the harness returns no claim at all', async () => {
    harness.claim = undefined;

    const { verdict } = await reproduceAndValidate();

    expect(verdict).toBe('needs-info');
  });

  it('leaves no orphaned processes behind', async () => {
    // The failure mode that made process supervision the riskiest task.
    harness.files = { 'test/repro.test.js': GENUINE_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 's',
    };

    await reproduceAndValidate();

    expect(store.listReapCandidates()).toHaveLength(0);
    expect(reapOrphans(store)).toEqual([]);
  });

  it('releases the issue so a second run can take it', async () => {
    harness.files = { 'test/repro.test.js': GENUINE_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 's',
    };

    const first = await reproduceAndValidate();
    expect(store.getLock({ repo: REPO, issueNumber: 7 })).toBeNull();

    const second = await reproduceAndValidate();
    expect(second.runId).not.toBe(first.runId);
    // Both runs remain readable: a retry adds history rather than erasing it.
    expect(store.listRuns({ repo: REPO, issueNumber: 7 })).toHaveLength(2);
  });

  it('never lets attacker-authored text reach a command line', async () => {
    // The issue body is carried verbatim as data. The defence is that it lives in a
    // file the harness reads, not that it was sanitised on the way in.
    harness.files = { 'test/repro.test.js': GENUINE_REPRO };
    harness.claim = {
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/repro.test.js'],
      testFile: 'test/repro.test.js',
      summary: 's',
    };

    const { workdir } = await reproduceAndValidate();
    const card = JSON.parse(readFileSync(join(workdir, 'task-card.json'), 'utf8')) as {
      issue: { body: string };
      instructions: string;
    };

    expect(card.issue.body).toContain('url=http://x?a=1');
    expect(card.instructions).toMatch(/UNTRUSTED/);
    expect(existsSync('/tmp/if-e2e-pwned')).toBe(false);
  });
});
