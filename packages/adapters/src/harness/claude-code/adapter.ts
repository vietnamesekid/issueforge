import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessCapabilities, HarnessEvent, HarnessRunOutcome } from '@issueforge/contracts';
import { HarnessContractError, type HarnessAdapter, type HarnessRun, type HarnessRunRequest } from '@issueforge/core';
import { spawnSupervised, type SupervisedProcess } from '../../process/index.js';
import { buildClaudeArgv, DEFAULT_ALLOWED_TOOLS } from './argv.js';
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
   * `--bare` is required for isolation, and under it authentication is strictly
   * ANTHROPIC_API_KEY — OAuth and the keychain are never read. A missing key is the
   * common failure, so it is reported here as a plain "not authenticated" rather than
   * discovered when a run stalls.
   */
  async detect(): Promise<HarnessCapabilities> {
    const version = await this.#version();
    if (version === null) return { installed: false };

    return {
      installed: true,
      version,
      authenticated: process.env['ANTHROPIC_API_KEY'] !== undefined,
    };
  }

  run(request: HarnessRunRequest): HarnessRun {
    writeTaskCard(request);

    const argv = buildClaudeArgv({
      taskCardPath: request.taskCardPath,
      resultSchema: request.resultSchema,
      sessionId: request.sessionId,
      card: request.taskCard,
    });

    const child = spawnSupervised(CLI, argv, {
      cwd: request.cwd,
      timeoutMs: request.taskCard.constraints.timeoutMs,
      // --bare reads no OAuth, so the key must be passed deliberately. Naming it here
      // is what makes it an allowed exception to the environment allowlist.
      env: {
        ...(process.env['ANTHROPIC_API_KEY'] !== undefined
          ? { extra: { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] } }
          : {}),
      },
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    return new ClaudeCodeRun(child);
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

  async *events(): AsyncIterable<HarnessEvent> {
    for await (const line of this.#child.lines()) {
      const parsed = parseLine(line);

      if (parsed.posture !== undefined) {
        this.#posture = parsed.posture;
        this.#postureError = checkPosture(parsed.posture);
        // Abort BEFORE the model spends anything. The first event reports the sandbox
        // we actually got, and proceeding on a sandbox we did not ask for would mean
        // running an untrusted issue body against tools we thought were disabled.
        if (this.#postureError !== undefined) this.#child.terminate();
      }

      if (parsed.terminal !== undefined) this.#terminal = parsed.terminal;

      yield* parsed.events;
    }
  }

  async outcome(): Promise<HarnessRunOutcome> {
    const result = await this.#child.wait();

    if (this.#postureError !== undefined) {
      throw new HarnessContractError(this.#postureError);
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
      ...(this.#posture?.sessionId ? { sessionId: this.#posture.sessionId } : {}),
      ...(claim !== null ? { result: claim } : {}),
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      ...(terminal?.costUsd !== undefined ? { costUsd: terminal.costUsd } : {}),
    };
  }

  cancel(): void {
    this.#child.terminate();
  }
}

/**
 * Verify the sandbox is the one that was requested.
 *
 * Returns a message when it is not. The MCP check is the load-bearing one: without
 * `--strict-mcp-config` a run was observed inheriting five of the developer's
 * authenticated servers, which turns a hostile issue body into an exfiltration path.
 */
function checkPosture(posture: SessionPosture): string | undefined {
  if (posture.mcpServers.length > 0) {
    return (
      `harness started with MCP servers enabled (${posture.mcpServers.join(', ')}); ` +
      `expected none. Refusing to run an untrusted issue body against them.`
    );
  }

  const unexpected = posture.tools.filter((tool) => !isAllowed(tool));
  if (unexpected.length > 0) {
    return `harness started with unrequested tools: ${unexpected.join(', ')}`;
  }

  return undefined;
}

/** Tool names are reported bare; the allowlist may scope them, e.g. `Bash(npm *)`. */
function isAllowed(tool: string): boolean {
  return DEFAULT_ALLOWED_TOOLS.some((allowed) => allowed === tool || allowed.startsWith(`${tool}(`));
}

function writeTaskCard(request: HarnessRunRequest): void {
  const path = join(request.cwd, request.taskCardPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(request.taskCard, null, 2));
}
