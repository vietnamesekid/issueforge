import type { HarnessEvent, HarnessResult } from '@issueforge/contracts';
import { HarnessResult as HarnessResultSchema, optionalDefined } from '@issueforge/contracts';

/**
 * Translates Claude Code's stream-json into the normalised event union.
 *
 * Pure, so it can be tested against captured transcripts without spending money.
 *
 * Written defensively on purpose. Real runs emit event types that are not documented
 * — `thinking_tokens`, `background_tasks_changed`, `task_started|updated|notification`
 * were all observed — and more will appear. An unrecognised event becomes `unknown`
 * and is recorded; it never aborts a run that is otherwise going fine.
 */

/** The shape of the terminal `result` line, as far as we rely on it. */
interface ResultLine {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  permission_denials?: { tool_name?: string; tool_input?: Record<string, unknown> }[];
  terminal_reason?: string;
}

/** What the first `system/init` line tells us about the sandbox we actually got. */
export interface SessionPosture {
  sessionId: string;
  model?: string;
  tools: string[];
  mcpServers: string[];
}

export interface ParsedLine {
  events: HarnessEvent[];
  /** Present only on the `system/init` line. */
  posture?: SessionPosture;
  /** Present only on the terminal `result` line. */
  terminal?: TerminalOutcome;
}

export interface TerminalOutcome {
  ok: boolean;
  subtype: string;
  finalText: string;
  structured: unknown;
  costUsd?: number;
  turns?: number;
  denials: number;
  /** Set when the agent reported an injection attempt, so it can be surfaced. */
  injectionSuspected: boolean;
}

/** Phrases an agent uses when it notices the issue text trying to give it orders. */
const INJECTION_HINT = /prompt[- ]injection|ignore (?:all )?previous instructions|fake SYSTEM/i;

/**
 * Parse one NDJSON line.
 *
 * Never throws: a malformed line is data about a run in trouble, not a reason to
 * abandon a transcript that may still explain what went wrong.
 */
export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { events: [] };

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { events: [{ type: 'unknown', raw: truncate(trimmed) }] };
  }

  if (typeof value !== 'object' || value === null) {
    return { events: [{ type: 'unknown', raw: truncate(trimmed) }] };
  }

  const record = value as Record<string, unknown>;
  switch (record['type']) {
    case 'system':
      return parseSystem(record, trimmed);
    case 'assistant':
      return { events: parseAssistant(record) };
    case 'user':
      return { events: parseToolResults(record) };
    case 'result':
      return parseResult(record as unknown as ResultLine);
    default:
      return { events: [{ type: 'unknown', raw: truncate(trimmed) }] };
  }
}

function parseSystem(record: Record<string, unknown>, raw: string): ParsedLine {
  // Only `init` carries the posture. Every other subtype — documented or not — is
  // recorded and ignored.
  if (record['subtype'] !== 'init') {
    return { events: [{ type: 'unknown', raw: truncate(raw) }] };
  }

  const posture: SessionPosture = {
    sessionId: asString(record['session_id']) ?? '',
    tools: asStringArray(record['tools']),
    mcpServers: namesOf(record['mcp_servers']),
    ...optionalDefined('model', asString(record['model'])),
  };

  return {
    events: [
      {
        type: 'session_started',
        sessionId: posture.sessionId,
        tools: posture.tools,
        mcpServers: posture.mcpServers,
        ...optionalDefined('model', posture.model),
      },
    ],
    posture,
  };
}

function parseAssistant(record: Record<string, unknown>): HarnessEvent[] {
  const message = record['message'] as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const events: HarnessEvent[] = [];

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;

    if (b['type'] === 'text') {
      const text = asString(b['text'])?.trim();
      if (text) events.push({ type: 'text', text });
    } else if (b['type'] === 'tool_use') {
      const detail = b['input'] === undefined ? undefined : truncate(JSON.stringify(b['input']));
      events.push({
        type: 'tool_started',
        toolId: asString(b['id']) ?? 'unknown',
        name: asString(b['name']) ?? 'unknown',
        ...optionalDefined('detail', detail),
      });
    }
  }

  return events;
}

function parseToolResults(record: Record<string, unknown>): HarnessEvent[] {
  const message = record['message'] as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const events: HarnessEvent[] = [];

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_result') continue;

    const output = typeof b['content'] === 'string' ? truncate(b['content']) : undefined;
    events.push({
      type: 'tool_finished',
      toolId: asString(b['tool_use_id']) ?? 'unknown',
      ok: b['is_error'] !== true,
      ...optionalDefined('output', output),
    });
  }

  return events;
}

function parseResult(line: ResultLine): ParsedLine {
  const denials = line.permission_denials ?? [];
  const finalText = line.result ?? '';

  // Success is a TERMINAL EVENT, and `subtype` alone is not it: a real
  // authentication failure returned subtype "success" with is_error true.
  const ok = line.is_error !== true && line.subtype === 'success';

  const events: HarnessEvent[] = denials.map((denial) => ({
    type: 'permission_denied' as const,
    tool: denial.tool_name ?? 'unknown',
    ...optionalDefined(
      'target',
      // Only a string is meaningful here. `String()` on an object would write
      // "[object Object]" into the record of what an agent tried to reach outside its
      // boundary — the one place that data is wanted during an incident.
      typeof denial.tool_input?.['file_path'] === 'string'
        ? denial.tool_input['file_path']
        : undefined,
    ),
  }));

  if (line.total_cost_usd !== undefined) {
    events.push({ type: 'usage', costUsd: line.total_cost_usd });
  }

  events.push(
    ok
      ? {
          type: 'finished',
          finalText,
          ...optionalDefined('structured', line.structured_output),
        }
      : { type: 'failed', message: finalText || (line.subtype ?? 'harness reported failure') },
  );

  return {
    events,
    terminal: {
      ok,
      subtype: line.subtype ?? 'unknown',
      finalText,
      structured: line.structured_output,
      denials: denials.length,
      injectionSuspected: INJECTION_HINT.test(finalText),
      ...optionalDefined('costUsd', line.total_cost_usd),
      ...optionalDefined('turns', line.num_turns),
    },
  };
}

/**
 * Interpret the harness's structured claim.
 *
 * Returns null when there is nothing schema-valid to read. That is not a failure of
 * the run — it means the harness reported nothing structured, which the runner
 * treat as `needs-info`.
 *
 * A real agent returned `reproCommand` as one space-joined string rather than argv,
 * so it is normalised here: no reader should have to guess whether it was
 * handed a command or a sentence.
 */
export function readClaim(structured: unknown): HarnessResult | null {
  if (typeof structured !== 'object' || structured === null) return null;

  const raw = { ...(structured as Record<string, unknown>) };
  const command = raw['reproCommand'];

  if (typeof command === 'string') {
    raw['reproCommand'] = splitCommand(command);
  } else if (Array.isArray(command) && command.length === 1 && typeof command[0] === 'string') {
    const single = command[0];
    if (single.includes(' ')) raw['reproCommand'] = splitCommand(single);
  }

  const parsed = HarnessResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Split on whitespace. Deliberately not a shell parser — see the note in `Argv`. */
function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function truncate(text: string, max = 2_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** MCP servers arrive as objects; only their names matter for the posture check. */
function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (typeof entry === 'object' && entry !== null) {
      const name = (entry as Record<string, unknown>)['name'];
      return typeof name === 'string' ? [name] : [];
    }
    return [];
  });
}
