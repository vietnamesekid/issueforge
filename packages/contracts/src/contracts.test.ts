import { describe, it, expect } from 'vitest';
import {
  Argv,
  GitHubIssueEvent,
  HarnessEvent,
  HarnessResult,
  IssueForgeConfig,
  RunState,
  Sha,
  TaskCard,
  Verdict,
  RunStatus,
} from './index.js';

const SHA = 'a'.repeat(40);

describe('primitives', () => {
  it('accepts a full SHA and rejects a short one with a readable message', () => {
    expect(Sha.parse(SHA)).toBe(SHA);
    const bad = Sha.safeParse('a1b2c3d');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain('40-character git SHA');
  });

  it('requires argv arrays, not shell strings', () => {
    expect(Argv.parse(['node', '--test'])).toEqual(['node', '--test']);
    // The failure mode this guards: a real agent returned one space-joined string.
    // That is still a valid array of one element, so the ADAPTER must split it —
    // the schema only guarantees non-empty.
    expect(Argv.safeParse([]).success).toBe(false);
    expect(Argv.safeParse('node --test').success).toBe(false);
  });
});

describe('TaskCard', () => {
  const minimal = {
    task: 'reproduce',
    issue: { number: 1, title: 't', body: 'b' },
    repository: { slug: 'owner/repo', baseSha: SHA },
    constraints: { allowedPaths: ['test/**'] },
  };

  it('round-trips and applies safe defaults', () => {
    const card = TaskCard.parse(minimal);
    expect(card.constraints.timeoutMs).toBeGreaterThan(0);
    expect(card.constraints.maxTurns).toBeGreaterThan(0);
    // The untrusted-data wording is part of the contract, not adapter boilerplate.
    expect(card.instructions).toContain('UNTRUSTED');
    expect(TaskCard.parse(TaskCard.parse(minimal))).toEqual(card);
  });

  it('rejects an empty allowedPaths — a task with no write boundary is not runnable', () => {
    const bad = TaskCard.safeParse({ ...minimal, constraints: { allowedPaths: [] } });
    expect(bad.success).toBe(false);
  });

  it('keeps hostile issue text intact rather than sanitising it', () => {
    // Escaping here would be the wrong layer: the defence is argv arrays and a file,
    // not string mangling. The contract must preserve the body verbatim.
    const evil = '$(touch /tmp/pwned) `id`; rm -rf /';
    expect(TaskCard.parse({ ...minimal, issue: { number: 1, title: 't', body: evil } }).issue.body)
      .toBe(evil);
  });
});

describe('HarnessEvent', () => {
  it('parses the normalised union', () => {
    const started = HarnessEvent.parse({ type: 'session_started', sessionId: 's1' });
    expect(started.type === 'session_started' && started.mcpServers).toEqual([]);
    expect(HarnessEvent.parse({ type: 'finished', finalText: 'ok' }).type).toBe('finished');
    expect(HarnessEvent.parse({ type: 'permission_denied', tool: 'Read' }).type).toBe(
      'permission_denied',
    );
  });

  it('carries unrecognised events instead of failing', () => {
    // Real harnesses emit undocumented event types; an adapter must not crash on them.
    const e = HarnessEvent.parse({ type: 'unknown', raw: '{"type":"thinking_tokens"}' });
    expect(e.type).toBe('unknown');
  });

  it('rejects an event with no discriminator', () => {
    expect(HarnessEvent.safeParse({ sessionId: 's1' }).success).toBe(false);
  });
});

describe('HarnessResult', () => {
  it('is a claim, and a schema-valid claim carries no authority', () => {
    const claim = HarnessResult.parse({
      verdict: 'reproduced',
      reproCommand: ['node', '--test', 'test/x.test.js'],
      testFile: 'test/x.test.js',
    });
    expect(claim.verdict).toBe('reproduced');
    expect(claim.reproCommand).toEqual(['node', '--test', 'test/x.test.js']);
  });

  it('rejects a verdict outside the allowed set', () => {
    expect(HarnessResult.safeParse({ verdict: 'definitely-broken' }).success).toBe(false);
  });
});

describe('Verdict', () => {
  it('is the same set a harness may claim', () => {
    expect(Verdict.options).toEqual(HarnessResult.shape.verdict.options);
    expect(Verdict.options).toEqual(['reproduced', 'cannot-reproduce', 'needs-info']);
  });

  it('is a SUBSET of RunStatus, because a verdict is recorded as the run status', () => {
    // classifyAttempt() stores the harness's verdict directly in the run's status
    // field. If a verdict were ever added without a matching status, that write
    // would produce a row the ledger cannot represent.
    for (const verdict of Verdict.options) {
      expect(RunStatus.options).toContain(verdict);
    }
  });
});


describe('RunState', () => {
  const base = {
    id: 'run_a1b2c3',
    repo: 'owner/repo',
    issueNumber: 7,
    task: 'reproduce',
    status: 'running',
    baseSha: SHA,
    createdAt: 1,
    updatedAt: 2,
  };

  it('round-trips', () => {
    expect(RunState.parse(RunState.parse(base))).toEqual(RunState.parse(base));
  });

  it('carries process ownership so orphans are detectable after a hard kill', () => {
    const run = RunState.parse({
      ...base,
      ownership: { pgid: 123, ownerPid: 122, ownerStart: 'Mon Aug 25 10:00:00 2026', startedAt: 1 },
    });
    // ownerStart guards against PID reuse; without it a recycled pid looks alive.
    expect(run.ownership?.ownerStart).toBeTruthy();
  });

  it('rejects a malformed run id', () => {
    expect(RunState.safeParse({ ...base, id: 'nope' }).success).toBe(false);
  });
});

describe('IssueForgeConfig', () => {
  it('an empty config is valid and safe by default', () => {
    const cfg = IssueForgeConfig.parse({});
    expect(cfg.policy.draftPrOnly).toBe(true);
    // Turn and time limits must have real values: they are the only bound on how far
    // a run can go, and a missing config must not mean "unlimited".
    expect(cfg.harness.maxTurns).toBeGreaterThan(0);
    expect(cfg.harness.timeoutMs).toBeGreaterThan(0);
    expect(cfg.policy.forbiddenPaths).toContain('.github/**');
    expect(cfg.env.allow).toContain('PATH');
    // an allowlist, not a denylist, and small enough to audit at a glance
    expect(cfg.env.allow).not.toContain('ANTHROPIC_API_KEY');
    expect(cfg.env.allow.length).toBeLessThan(10);
  });
});

describe('GitHubIssueEvent', () => {
  const payload = {
    action: 'labeled',
    issue: { number: 1, title: 't', body: 'b', labels: [{ name: 'bug' }] },
    label: { name: 'issueforge:reproduce' },
    repository: { full_name: 'owner/repo', default_branch: 'main' },
    sender: { login: 'someone' },
  };

  it('parses a real payload shape', () => {
    expect(GitHubIssueEvent.parse(payload).issue.number).toBe(1);
  });

  it('tolerates a null body and unknown fields', () => {
    // GitHub sends null for an empty body and adds fields over time; neither may fail a run.
    const e = GitHubIssueEvent.parse({
      ...payload,
      issue: { ...payload.issue, body: null, reactions: { '+1': 3 } },
      unexpected_new_field: true,
    });
    expect(e.issue.body).toBe(null);
  });

  it('rejects a payload for a different action', () => {
    expect(GitHubIssueEvent.safeParse({ ...payload, action: 'opened' }).success).toBe(false);
  });
});
