import { pino, type Logger as PinoLogger } from 'pino';
import { redactValue } from './redact.js';

/**
 * Structured local logging.
 *
 * Pino writing straight to a stream — deliberately no worker-thread transports.
 * Transports buy throughput this tool does not need, and cost a worker whose
 * shutdown races the ~10s process-tree kill on cancellation. A plain sync stream
 * has no such race.
 *
 * There is no telemetry and no log shipping. Everything stays on the machine.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  level?: LogLevel;
  /** Where human-readable logs go. stderr keeps stdout clean for `--json` output. */
  destination?: NodeJS.WritableStream;
  /** Fields attached to every record, e.g. `{ runId }`. */
  base?: Record<string, unknown>;
}

export type Logger = PinoLogger;

export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = 'info', destination = process.stderr, base = {} } = options;

  return pino(
    {
      level,
      base: { ...base },
      // Redact on the way out as defence in depth. The primary control is that
      // credentials never enter the harness environment at all.
      formatters: {
        log: (obj) => redactValue(obj) as Record<string, unknown>,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

/**
 * Silence Node's `ExperimentalWarning` for `node:sqlite`.
 *
 * `node:sqlite` is a release candidate and warns on first use. For a CLI that must
 * keep stderr clean — and whose users would reasonably read the warning as a fault —
 * the noise is worse than the information. Everything else keeps warning normally.
 */
let sqliteWarningSuppressed = false;

/** The warning's type, whether it arrived as an Error or as loose arguments. */
function warningType(warning: string | Error, rest: readonly unknown[]): string {
  if (warning instanceof Error) return warning.name;
  if (typeof rest[0] === 'string') return rest[0];
  return (rest[0] as { type?: string } | undefined)?.type ?? '';
}

/**
 * Silence Node's `ExperimentalWarning` for `node:sqlite`.
 *
 * `node:sqlite` is a release candidate and warns on first load. For a CLI that must
 * keep stderr clean — and whose users would reasonably read the warning as a fault —
 * the noise is worse than the information. Every other warning still surfaces.
 *
 * Idempotent: it is called from the lazy sqlite loader, and patching an already
 * patched `emitWarning` would build a chain of wrappers.
 */
export function suppressSqliteExperimentalWarning(): void {
  if (sqliteWarningSuppressed) return;
  sqliteWarningSuppressed = true;

  const original = process.emitWarning.bind(process);

  const patched = (warning: string | Error, ...rest: readonly unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning;
    const isSqliteNotice =
      warningType(warning, rest) === 'ExperimentalWarning' && /\bSQLite\b/i.test(message);

    if (isSqliteNotice) return;
    (original as (...args: readonly unknown[]) => void)(warning, ...rest);
  };

  process.emitWarning = patched as typeof process.emitWarning;
}
