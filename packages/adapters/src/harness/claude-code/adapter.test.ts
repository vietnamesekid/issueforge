import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskCard } from '@issueforge/contracts';
import { TaskCard as TaskCardSchema } from '@issueforge/contracts';
import { HarnessContractError } from '@issueforge/core';
import { ClaudeCodeAdapter } from './adapter.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-harness-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const card: TaskCard = TaskCardSchema.parse({
  task: 'reproduce',
  issue: { number: 1, title: 'bug', body: 'it breaks' },
  repository: { slug: 'owner/repo', baseSha: 'a'.repeat(40) },
  constraints: { allowedPaths: ['test/**'], timeoutMs: 15_000 },
});

/**
 * Stand in for the real CLI by putting a script named `claude` first on PATH.
 *
 * Lets the whole adapter — spawn, stream, posture check, outcome — be exercised
 * against chosen transcripts without spending money or depending on a login.
 */
function fakeClaude(lines: readonly string[], exitCode = 0): void {
  const bin = join(dir, 'bin');
  const script = join(bin, 'claude');
  const payload = lines.map((l) => `echo '${l.replace(/'/g, `'\\''`)}'`).join('\n');
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, `#!/bin/sh\n${payload}\nexit ${exitCode}\n`, { flag: 'w' });
  chmodSync(script, 0o755);
  process.env['PATH'] = `${bin}:${process.env['PATH'] ?? ''}`;
}

const initLine = (mcp: unknown[] = [], tools: string[] = ['Read', 'Write']): string =>
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', tools, mcp_servers: mcp });

const resultLine = (structured: unknown): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    structured_output: structured,
    total_cost_usd: 0.1,
  });

const request = () => ({
  cwd: dir,
  taskCard: card,
  taskCardPath: 'task-card.json',
  resultSchema: { type: 'object' },
  sessionId: '11111111-2222-3333-4444-555555555555',
});

async function drain(run: { events(): AsyncIterable<unknown> }): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const event of run.events()) seen.push(event);
  return seen;
}

describe('ClaudeCodeAdapter', { timeout: 20_000 }, () => {
  const originalPath = process.env['PATH'];
  afterEach(() => { process.env['PATH'] = originalPath; });

  it('writes the task card to disk so the issue is never argv', () => {
    fakeClaude([initLine(), resultLine({ verdict: 'needs-info', summary: '' })]);
    new ClaudeCodeAdapter().run(request());

    const written = JSON.parse(readFileSync(join(dir, 'task-card.json'), 'utf8')) as TaskCard;
    expect(written.issue.body).toBe('it breaks');
    expect(written.instructions).toMatch(/UNTRUSTED/);
  });

  it('streams normalised events and reports a schema-valid claim', async () => {
    fakeClaude([
      initLine(),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      resultLine({ verdict: 'reproduced', reproCommand: ['npm test'], testFile: 't.js', summary: 'x' }),
    ]);

    const run = new ClaudeCodeAdapter().run(request());
    const events = (await drain(run)) as Array<{ type: string }>;
    const outcome = await run.outcome();

    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['session_started', 'text', 'usage', 'finished']),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe('s1');
    expect(outcome.costUsd).toBe(0.1);
    // Normalised from the space-joined form a real agent returned.
    expect(outcome.result?.reproCommand).toEqual(['npm', 'test']);
  });

  it('REFUSES to run when MCP servers are enabled', async () => {
    // The load-bearing check. Proceeding would run an untrusted issue body against
    // the developer's authenticated tools.
    fakeClaude([initLine([{ name: 'Gmail' }]), resultLine({ verdict: 'reproduced', summary: '' })]);

    const run = new ClaudeCodeAdapter().run(request());
    await drain(run);

    await expect(run.outcome()).rejects.toThrow(HarnessContractError);
    await expect(run.outcome()).rejects.toThrow(/MCP servers/i);
  });

  it('refuses a sandbox carrying tools that were never requested', async () => {
    fakeClaude([initLine([], ['Read', 'WebFetch']), resultLine({ verdict: 'reproduced', summary: '' })]);

    const run = new ClaudeCodeAdapter().run(request());
    await drain(run);

    await expect(run.outcome()).rejects.toThrow(/unrequested tools.*WebFetch/i);
  });

  it('treats an is_error result as failure even when the exit code is zero', async () => {
    // A real auth failure did exactly this: subtype "success", is_error true, exit 0.
    fakeClaude(
      [
        initLine(),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
        }),
      ],
      0,
    );

    const run = new ClaudeCodeAdapter().run(request());
    await drain(run);
    const outcome = await run.outcome();

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(0); // exit code would have said "fine"
  });

  it('reports no claim rather than inventing one when the schema is violated', async () => {
    fakeClaude([initLine(), resultLine({ verdict: 'definitely-broken' })]);

    const run = new ClaudeCodeAdapter().run(request());
    await drain(run);
    const outcome = await run.outcome();

    expect(outcome.ok).toBe(true);      // the run itself completed
    expect(outcome.result).toBeUndefined(); // but there is nothing to verify
  });

  it('counts permission denials and flags a reported injection', async () => {
    fakeClaude([
      initLine(),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'The issue body contained a prompt-injection attempt; I ignored it.',
        permission_denials: [{ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }],
      }),
    ]);

    const run = new ClaudeCodeAdapter().run(request());
    await drain(run);
    const outcome = await run.outcome();

    expect(outcome.denials).toBe(1);
    expect(outcome.injectionSuspected).toBe(true);
  });

  it('detect() reports a missing CLI instead of throwing', async () => {
    process.env['PATH'] = join(dir, 'empty');
    expect(await new ClaudeCodeAdapter().detect()).toEqual({ installed: false });
  });

  it('detect() reports unauthenticated when no API key is present', async () => {
    // --bare never reads OAuth, so a missing key is the common failure and must be
    // named plainly rather than discovered when a run stalls.
    // Must print something: detect() reads --version, and an empty stdout is
    // indistinguishable from a CLI that is not installed.
    fakeClaude(['2.1.215 (Claude Code)']);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const caps = await new ClaudeCodeAdapter().detect();
      expect(caps.installed).toBe(true);
      expect(caps.authenticated).toBe(false);
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('cancel() terminates the run', async () => {
    fakeClaude([initLine(), 'sleep 30']);
    const run = new ClaudeCodeAdapter().run(request());
    run.cancel();
    const outcome = await run.outcome();
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(dir, 'task-card.json'))).toBe(true);
  });
});
