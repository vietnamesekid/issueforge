import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  optional,
  optionalDefined,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRunOutcome,
} from '@issueforge/contracts';
import {
  HarnessContractError,
  HarnessRunError,
  type HarnessAdapter,
  type HarnessRun,
  type HarnessRunRequest,
} from '@issueforge/core';
import { spawnSupervised, type SupervisedProcess } from '../../process/index.js';
import { buildClaudeArgv } from './argv.js';
import { parseLine, readClaim, type SessionPosture, type TerminalOutcome } from './events.js';

const execFileAsync = promisify(execFile);
const CLI = 'claude';
const DETECT_TIMEOUT_MS = 10_000;

/**
 * Drives the Claude Code CLI.
 *
 * The adapter translates and enforces the contract; it does not judge the run. What a
 * harness claims is untrusted input, and whether the claim holds is settled later by
 * replaying the evidence.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = 'claude-code' as const;

  /**
   * Report usability without spending tokens and without hanging.
   *
   * Authentication is either an existing interactive login or ANTHROPIC_API_KEY;
   * reusing the login a developer already has is the point, so a missing key is not
   * by itself a failure.
   */
  async detect(): Promise<HarnessCapabilities> {
    const version = await this.#version();
    if (version === null) return { installed: false };

    return {
      installed: true,
      version,
      authenticated:
        process.env['ANTHROPIC_API_KEY'] !== undefined || (await this.#signedIn()),
    };
  }

  run(request: HarnessRunRequest): HarnessRun {
    // The task card is written by the caller, not here: every adapter needs it on
    // disk before starting, and leaving that to each one means the second adapter
    // can forget. The runner owns the precondition.
    const argv = buildClaudeArgv({
      taskCardPath: request.taskCardPath,
      resultSchema: request.resultSchema,
      sessionId: request.sessionId,
      card: request.taskCard,
    });

    const child = spawnSupervised(CLI, argv, {
      cwd: request.cwd,
      timeoutMs: request.taskCard.constraints.timeoutMs,
      // Forwarded when present, for a headless or CI setup. It is optional: without
      // it the harness uses the developer's existing interactive login, which is the
      // authentication this product is built to reuse. Naming it explicitly is what
      // makes it an allowed exception to the environment allowlist.
      env: {
        ...optionalDefined('allow', request.envAllow),
        extra: {
          ...optionalDefined('ANTHROPIC_API_KEY', process.env['ANTHROPIC_API_KEY']),
          // The harness reports its own findings, so it needs to reach GitHub. This is
          // the job's own token: scoped to this repository, valid for this run, and
          // named explicitly here rather than inherited — the environment allowlist
          // still blocks everything else.
          ...optionalDefined('GH_TOKEN', request.githubToken),
        },
      },
      ...optionalDefined('signal', request.signal),
    });

    return new ClaudeCodeRun(child);
  }

  /** Whether an interactive login exists. `claude auth status` exits non-zero if not. */
  async #signedIn(): Promise<boolean> {
    try {
      await execFileAsync(CLI, ['auth', 'status'], { timeout: DETECT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async #version(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(CLI, ['--version'], { timeout: DETECT_TIMEOUT_MS });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

/** One in-flight run. Owns the stream translation and the posture check. */
class ClaudeCodeRun implements HarnessRun {
  readonly #child: SupervisedProcess;
  #terminal: TerminalOutcome | undefined;
  #posture: SessionPosture | undefined;
  #postureError: string | undefined;

  constructor(child: SupervisedProcess) {
    this.#child = child;
  }

  get pgid(): number {
    return this.#child.pgid;
  }

  get ownership() {
    return this.#child.ownership;
  }

  async *events(): AsyncIterable<HarnessEvent> {
    for await (const line of this.#child.lines()) {
      const parsed = parseLine(line);

      if (parsed.posture) {
        this.#posture = parsed.posture;
        this.#postureError = checkPosture(parsed.posture);
        // Abort BEFORE the model spends anything. The first event reports the sandbox
        // we actually got, and proceeding on a sandbox we did not ask for would mean
        // running an untrusted issue body against tools we thought were disabled.
        if (this.#postureError) this.#child.terminate();
      }

      if (parsed.terminal) this.#terminal = parsed.terminal;

      yield* parsed.events;
    }
  }

  async outcome(): Promise<HarnessRunOutcome> {
    const result = await this.#child.wait();

    if (this.#postureError) {
      throw new HarnessContractError(this.#postureError);
    }

    // The supervisor knows whether the wall clock or an operator ended this run.
    // Surfacing it as a typed error is what stops the runner inferring it from prose:
    // a timed-out run otherwise reports as an ordinary failure and is filed in the
    // ledger as `completed`.
    if (result.reason === 'timeout') {
      throw new HarnessRunError('timeout', 'the harness exceeded its time budget');
    }
    if (result.reason === 'cancelled') {
      throw new HarnessRunError('cancelled', 'the run was cancelled');
    }

    const terminal = this.#terminal;
    const claim = terminal ? readClaim(terminal.structured) : null;

    return {
      harness: 'claude-code',
      // Success is the terminal event, never the exit code: an in-run failure is
      // printed as a result on stdout and can still exit zero.
      ok: terminal?.ok === true,
      denials: terminal?.denials ?? 0,
      injectionSuspected: terminal?.injectionSuspected ?? false,
      ...optional('sessionId', this.#posture?.sessionId),
      ...optional('result', claim),
      // `optional`, not a truthiness check: exit code 0 is the most common one there
      // is, and `&&` would silently drop it.
      ...optional('exitCode', result.exitCode),
    };
  }

  cancel(): void {
    this.#child.terminate();
  }
}

/**
 * Verify the one thing that must hold before any token is spent.
 *
 * Only MCP is checked. Without `--strict-mcp-config` a run was observed inheriting
 * five of the developer's authenticated servers — Gmail, Drive, Notion — which turns
 * a hostile issue body into an exfiltration path. Nothing the task needs comes from
 * them, so their presence means the sandbox is not what was asked for.
 *
 * The tool set is deliberately NOT checked. Which tools the harness needs is its
 * decision, and an earlier version of this function killed a live run for carrying
 * `StructuredOutput` — a tool Claude Code adds precisely because we ask for a
 * structured result. We caused it, then treated it as an intrusion.
 */
function checkPosture(posture: SessionPosture): string | undefined {
  if (posture.mcpServers.length > 0) {
    return (
      `harness started with MCP servers enabled (${posture.mcpServers.join(', ')}); ` +
      `expected none. Refusing to run an untrusted issue body against them.`
    );
  }

  return undefined;
}

