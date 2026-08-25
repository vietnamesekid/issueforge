import { z } from 'zod';
import type { RunStatus } from './common.js';
import { Argv, HarnessName } from './common.js';

/**
 * The normalised harness event stream.
 *
 * Both Claude Code (`--output-format stream-json`) and Codex (`exec --json`) emit
 * NDJSON, but with different shapes. Adapters map onto this union; nothing outside
 * an adapter should know which harness produced an event.
 *
 * Observed in practice and encoded here:
 *  - Harnesses emit event types that are not documented. The adapter must IGNORE
 *    unknown ones rather than fail, so `unknown` exists as an explicit escape hatch.
 *  - Trailing events can arrive AFTER the terminal event, so "the last line is the
 *    result" is not strictly true. Consumers terminate on `finished`/`failed` and
 *    then drain briefly.
 */

export const HarnessEvent = z.discriminatedUnion('type', [
  /** First event. Carries the sandbox posture to assert BEFORE any tokens are spent. */
  z.object({
    type: z.literal('session_started'),
    sessionId: z.string().min(1),
    model: z.string().optional(),
    /** Tools actually enabled. Assert this matches what was requested. */
    tools: z.array(z.string()).default([]),
    /** MUST be empty. A non-empty list means MCP isolation failed. */
    mcpServers: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_started'),
    toolId: z.string().min(1),
    name: z.string().min(1),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_finished'),
    toolId: z.string().min(1),
    ok: z.boolean(),
    output: z.string().optional(),
  }),
  z.object({ type: z.literal('file_changed'), path: z.string().min(1) }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    /** Claude Code only, and documented as a client-side estimate. Never bill from it. */
    costUsd: z.number().nonnegative().optional(),
  }),
  /**
   * An attempt to act outside the permitted boundary. A first-class policy event —
   * but note its ABSENCE proves nothing: a model often refuses before calling a tool,
   * so contained runs are frequently recorded with zero denials.
   */
  z.object({
    type: z.literal('permission_denied'),
    tool: z.string().min(1),
    target: z.string().optional(),
  }),
  /** Terminal, success. */
  z.object({
    type: z.literal('finished'),
    finalText: z.string().default(''),
    structured: z.unknown().optional(),
  }),
  /** Terminal, failure. */
  z.object({ type: z.literal('failed'), message: z.string().min(1) }),
  /** Anything the adapter did not recognise. Recorded, never fatal. */
  z.object({ type: z.literal('unknown'), raw: z.string() }),
]);

/**
 * What the harness CLAIMS. This is untrusted input, not a verdict.
 *
 * IssueForge independently replays the evidence before believing any of it, so a
 * schema-valid claim carries no authority whatsoever.
 */
export const HarnessResult = z.object({
  verdict: z.enum(['reproduced', 'cannot-reproduce', 'needs-info']),
  /**
   * Command that demonstrates the bug, as an ARGV ARRAY.
   * A real agent returned this as one space-joined string ("node --test test/x.js"),
   * so adapters normalise before validation; never assume argv arrived correctly.
   */
  reproCommand: Argv.optional(),
  /** Repo-relative path to the failing test or repro script. */
  testFile: z.string().min(1).optional(),
  /** Substring the replay output is expected to contain, if the harness names one. */
  expectedSignal: z.string().optional(),
  summary: z.string().default(''),
});

/** Outcome of one harness process, assembled by the adapter. */
export const HarnessRunOutcome = z.object({
  harness: HarnessName,
  /** Version string of the CLI, recorded so a failure is reproducible. */
  version: z.string().optional(),
  sessionId: z.string().optional(),
  /**
   * Success is a TERMINAL EVENT, never an exit code and never `subtype` alone:
   * a real auth failure returned `subtype: "success"` with `is_error: true`.
   */
  ok: z.boolean(),
  result: HarnessResult.optional(),
  exitCode: z.number().int().optional(),
  costUsd: z.number().nonnegative().optional(),
  denials: z.number().int().nonnegative().default(0),
  /** Set when the harness reported an injection attempt; surfaced to the maintainer. */
  injectionSuspected: z.boolean().default(false),
});

export const HarnessCapabilities = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  authenticated: z.boolean().optional(),
});

export type HarnessEvent = z.infer<typeof HarnessEvent>;
export type HarnessResult = z.infer<typeof HarnessResult>;
export type HarnessRunOutcome = z.infer<typeof HarnessRunOutcome>;
export type HarnessCapabilities = z.infer<typeof HarnessCapabilities>;
export type { RunStatus };
