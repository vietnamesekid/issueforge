import { closeSync, mkdirSync, openSync, writeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactValue } from './redact.js';

/**
 * Append-only JSONL writer for a run's `events.jsonl`.
 *
 * Buffered writes with an explicit, SYNCHRONOUS `flush()`.
 *
 * Why synchronous: when a workflow run is cancelled the runner sends SIGINT to the
 * step's shell and kills the process tree ~10s later. The interrupt handler must
 * finish inside that window, and an async flush racing a process-tree kill is exactly
 * the case where events are silently lost. `flush()` here is a plain `writeSync`, so
 * it either completed or the process died before it started — never half-written.
 *
 * Records are redacted on the way in: an event stream that reached disk unredacted is
 * already a leak, regardless of what the reader does later.
 */
export class JsonlWriter {
  readonly path: string;
  #fd: number | null = null;
  #buffer: string[] = [];
  #bytesPending = 0;
  readonly #flushAtBytes: number;

  constructor(path: string, options: { flushAtBytes?: number } = {}) {
    this.path = path;
    this.#flushAtBytes = options.flushAtBytes ?? 64 * 1024;
  }

  #ensureOpen(): number {
    if (this.#fd === null) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.#fd = openSync(this.path, 'a');
    }
    return this.#fd;
  }

  /** Queue one record. Order is preserved; nothing is written until a flush threshold or `flush()`. */
  write(record: unknown): void {
    const line = `${JSON.stringify(redactValue(record))}\n`;
    this.#buffer.push(line);
    this.#bytesPending += line.length;
    if (this.#bytesPending >= this.#flushAtBytes) this.flush();
  }

  /** Write everything queued. Synchronous and safe to call from a signal handler. */
  flush(): void {
    if (this.#buffer.length === 0) return;
    const payload = this.#buffer.join('');
    this.#buffer = [];
    this.#bytesPending = 0;
    writeSync(this.#ensureOpen(), payload);
  }

  /**
   * Flush, then force the OS to persist to disk.
   *
   * Named for what it adds over `flush()` — an fsync — because `flush()` is already
   * synchronous; a `Sync` suffix would imply an async/sync distinction that does not
   * exist here.
   */
  flushDurable(): void {
    this.flush();
    if (this.#fd !== null) fsyncSync(this.#fd);
  }

  close(): void {
    this.flush();
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }

  /** Records queued but not yet written. */
  get pending(): number {
    return this.#buffer.length;
  }
}
