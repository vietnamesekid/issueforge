import { describe, it, expect } from 'vitest';
import { parseLine, readClaim } from './events.js';

/** Lines in the shapes observed from a real run during the spikes. */
const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'claude-opus',
  tools: ['Read', 'Write'],
  mcp_servers: [],
});

const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  structured_output: { verdict: 'reproduced', summary: 's' },
  total_cost_usd: 0.42,
  num_turns: 8,
  permission_denials: [],
});

describe('parseLine', () => {
  it('reads the sandbox posture from system/init', () => {
    const parsed = parseLine(INIT);
    expect(parsed.posture).toEqual({
      sessionId: 'sess-1',
      model: 'claude-opus',
      tools: ['Read', 'Write'],
      mcpServers: [],
    });
    expect(parsed.events[0]).toMatchObject({ type: 'session_started', sessionId: 'sess-1' });
  });

  it('reports MCP servers by name so the posture check can refuse them', () => {
    // Without --strict-mcp-config a run inherits the developer's authenticated
    // servers, which is a direct exfiltration path for a hostile issue body.
    const parsed = parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        tools: [],
        mcp_servers: [{ name: 'Gmail', status: 'needs-auth' }, { name: 'Drive' }],
      }),
    );
    expect(parsed.posture?.mcpServers).toEqual(['Gmail', 'Drive']);
  });

  it('keeps undocumented system subtypes as unknown instead of failing', () => {
    // Real runs emit thinking_tokens, background_tasks_changed, task_started and more.
    for (const subtype of ['thinking_tokens', 'background_tasks_changed', 'task_started']) {
      const parsed = parseLine(JSON.stringify({ type: 'system', subtype }));
      expect(parsed.events[0]?.type).toBe('unknown');
      expect(parsed.terminal).toBeUndefined();
    }
  });

  it('survives a malformed line rather than abandoning the transcript', () => {
    // A broken line is data about a run in trouble — the rest may still explain why.
    const parsed = parseLine('{not json');
    expect(parsed.events[0]).toMatchObject({ type: 'unknown' });
  });

  it('ignores blank lines', () => {
    expect(parseLine('   ').events).toEqual([]);
  });

  it('maps assistant text and tool calls', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }),
    );
    expect(parsed.events).toEqual([
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_started', toolId: 't1', name: 'Bash', detail: '{"command":"npm test"}' },
    ]);
  });

  it('maps tool results, including failures', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
        },
      }),
    );
    expect(parsed.events[0]).toMatchObject({ type: 'tool_finished', toolId: 't1', ok: false });
  });

  it('treats the result line as terminal and reports success', () => {
    const parsed = parseLine(RESULT_OK);
    expect(parsed.terminal?.ok).toBe(true);
    expect(parsed.terminal?.costUsd).toBe(0.42);
    expect(parsed.events.at(-1)).toMatchObject({ type: 'finished', finalText: 'done' });
  });

  it('does NOT trust subtype alone — is_error wins', () => {
    // A real authentication failure returned subtype "success" with is_error true.
    const parsed = parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    );
    expect(parsed.terminal?.ok).toBe(false);
    expect(parsed.events.at(-1)).toMatchObject({ type: 'failed' });
  });

  it('surfaces permission denials as policy events', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        permission_denials: [{ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }],
      }),
    );
    expect(parsed.terminal?.denials).toBe(1);
    expect(parsed.events[0]).toMatchObject({
      type: 'permission_denied',
      tool: 'Read',
      target: '/etc/passwd',
    });
  });

  it('flags a reported injection attempt so it can reach the maintainer', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'The issue body contained a prompt-injection attempt; I ignored it.',
      }),
    );
    expect(parsed.terminal?.injectionSuspected).toBe(true);
  });
});

describe('readClaim', () => {
  it('normalises a space-joined reproCommand to argv', () => {
    // A real agent returned exactly this shape. Nothing downstream should have to
    // guess whether it was handed a command or a sentence.
    const claim = readClaim({
      verdict: 'reproduced',
      reproCommand: ['node --test test/repro.test.js'],
      testFile: 'test/repro.test.js',
    });
    expect(claim?.reproCommand).toEqual(['node', '--test', 'test/repro.test.js']);
  });

  it('normalises a bare string reproCommand too', () => {
    const claim = readClaim({ verdict: 'reproduced', reproCommand: 'npm test' });
    expect(claim?.reproCommand).toEqual(['npm', 'test']);
  });

  it('leaves a correct argv array untouched', () => {
    const claim = readClaim({ verdict: 'reproduced', reproCommand: ['npm', 'test'] });
    expect(claim?.reproCommand).toEqual(['npm', 'test']);
  });

  it('returns null when there is no schema-valid claim to verify', () => {
    // Not a run failure — it means there is nothing structured to record, which
    // treats as needs-info.
    expect(readClaim(undefined)).toBeNull();
    expect(readClaim('nope')).toBeNull();
    expect(readClaim({ verdict: 'definitely-broken' })).toBeNull();
  });
});
