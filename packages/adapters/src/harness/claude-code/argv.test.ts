import { describe, it, expect } from 'vitest';
import type { TaskCard } from '@issueforge/contracts';
import { TaskCard as TaskCardSchema } from '@issueforge/contracts';
import { buildClaudeArgv, DEFAULT_ALLOWED_TOOLS } from './argv.js';

const card: TaskCard = TaskCardSchema.parse({
  task: 'reproduce',
  issue: { number: 1, title: 't', body: 'b' },
  repository: { slug: 'owner/repo', baseSha: 'a'.repeat(40) },
  constraints: { allowedPaths: ['test/**'], maxTurns: 12, maxBudgetUsd: 1.5 },
});

const argv = (): string[] =>
  buildClaudeArgv({
    taskCardPath: 'task-card.json',
    resultSchema: { type: 'object' },
    sessionId: '11111111-2222-3333-4444-555555555555',
    card,
  });

/** Value that follows `flag`, so assertions read as pairs rather than indices. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('claude argv contract', () => {
  it('does NOT pass --bare, which would break reuse of an existing login', () => {
    // --bare adds nothing here (hooks and MCP are already blocked) while forcing
    // ANTHROPIC_API_KEY, because it never reads an interactive login. Requiring a
    // separate key would break the promise to reuse the installation and
    // authentication a developer already has.
    expect(argv()).not.toContain('--bare');
  });

  it('blocks the developer MCP servers, and only those', () => {
    // The one isolation that stays. Without it a run was observed loading five
    // authenticated servers — Gmail, Drive, Notion — turning a hostile issue body
    // into an exfiltration path. Nothing the task needs comes from them.
    const args = argv();
    expect(args).toContain('--strict-mcp-config');
    expect(valueAfter(args, '--mcp-config')).toBe('{"mcpServers":{}}');
  });

  it('lets the repository configure the harness', () => {
    // CLAUDE.md and the project's skills are the context that makes the harness
    // useful here. Blocking them is what broke the first live run: the agent could
    // not learn the repo uses vitest and needs an install step.
    expect(argv()).not.toContain('--setting-sources');
  });

  it('does NOT restrict which tools the harness may use', () => {
    // Which tools the work needs is the harness's decision. A narrow list here would
    // be us guessing at a repository we have not read — and blocking WebSearch also
    // blocks looking up the error message in the issue.
    expect(argv()).not.toContain('--tools');
  });

  it('never lets `dontAsk` ship without an explicit tool allowlist', () => {
    // Bare dontAsk denies every write: the agent leaks nothing and does nothing.
    // A defence that blocks the product's own function is an outage.
    const args = argv();
    expect(valueAfter(args, '--permission-mode')).toBe('dontAsk');

    const allowIndex = args.indexOf('--allowedTools');
    expect(allowIndex).toBeGreaterThan(-1);
    expect(args[allowIndex + 1]).toBe(DEFAULT_ALLOWED_TOOLS[0]);
  });

  it('passes the issue only as a file path, never as argument text', () => {
    // Attacker-authored text must never be interpolated into argv.
    const hostile = TaskCardSchema.parse({
      ...card,
      issue: { number: 1, title: '$(touch /tmp/pwned)', body: '`id`; rm -rf /' },
    });
    const args = buildClaudeArgv({
      taskCardPath: 'task-card.json',
      resultSchema: {},
      sessionId: 's',
      card: hostile,
    });

    expect(args.join(' ')).not.toContain('rm -rf');
    expect(args.join(' ')).not.toContain('$(touch');
    expect(args.some((a) => a.includes('task-card.json'))).toBe(true);
  });

  it('tells the harness the card holds untrusted data', () => {
    // Measured in SPIKE-E to materially help against injection.
    const prompt = argv()[argv().indexOf('-p') + 1] ?? '';
    expect(prompt).toMatch(/untrusted data/i);
  });

  it('carries the caller budget rather than trusting the harness to self-limit', () => {
    const args = argv();
    expect(valueAfter(args, '--max-turns')).toBe('12');
    expect(valueAfter(args, '--max-budget-usd')).toBe('1.5');
  });

  it('pre-assigns a session id and does not persist the session', () => {
    // Pre-assigned so a run that dies before reporting is still correlatable.
    const args = argv();
    expect(valueAfter(args, '--session-id')).toBe('11111111-2222-3333-4444-555555555555');
    expect(args).toContain('--no-session-persistence');
  });

  it('requests machine-readable output and a structured result', () => {
    const args = argv();
    expect(valueAfter(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(valueAfter(args, '--json-schema')).toBe('{"type":"object"}');
  });
});
