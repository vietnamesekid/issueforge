import { clip } from './terminal-text.js';

/**
 * A block of rows that is redrawn in place, above which permanent history scrolls.
 *
 * Terminal output is append-only unless you move the cursor, so a naive progress
 * display either owns a single line or clears the screen and destroys the user's
 * scrollback. This splits output in two:
 *
 *   ✓ cloned pinned commit      ← committed: printed once, then the terminal owns it
 *   ✓ workspace prepared        ←
 *   ▶ running claude-code  2m14s  ← live: erased and redrawn on every update
 *   · audit
 *
 * `commit()` moves a row from the live block into permanent history, which is how a
 * long run leaves a readable transcript behind rather than a single final line.
 *
 * ONE RULE, and it is not optional: a row must fit the terminal width, because one row
 * must equal one screen line. If a row wraps, the region no longer knows how many
 * screen lines it occupied, so it moves the cursor up by the wrong amount and starts
 * corrupting the history above it. `paint` clips every row for exactly this reason.
 */

const ESC = '\u001b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_BELOW = `${ESC}[0J`;
/**
 * Synchronized output: buffer everything until the matching end, then swap atomically.
 *
 * Without this a multi-row repaint tears — the erase and the redraw are separate
 * writes, and a terminal can present a frame drawn between them. Terminals that do not
 * implement mode 2026 ignore both sequences, so there is no capability check.
 */
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

export interface WriteStream {
  write(chunk: string): boolean;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

export interface LiveRegionOptions {
  stream?: WriteStream;
  /**
   * Overrides TTY detection.
   *
   * Gated on more than `isTTY` by callers: when logs are being followed, repainting
   * erases the very lines the user is reading.
   */
  animate?: boolean;
  /** Fallback when the stream reports no width; 80 is the historical default. */
  columns?: number;
}

export class LiveRegion {
  readonly #stream: WriteStream;
  readonly #animate: boolean;
  readonly #fallbackColumns: number;

  /**
   * How many screen lines the live block occupied at the last paint.
   *
   * The single piece of state the whole repaint depends on. It is set from the rows
   * actually written, never from the rows requested, so a clip or an empty row cannot
   * desynchronise it from the screen.
   */
  #liveRowCount = 0;
  #cursorHidden = false;
  #live: readonly string[] = [];

  constructor(options: LiveRegionOptions = {}) {
    this.#stream = options.stream ?? process.stderr;
    this.#animate = options.animate ?? this.#stream.isTTY === true;
    this.#fallbackColumns = options.columns ?? 80;
  }

  /** Whether rows will be redrawn. False means every row is printed once, plainly. */
  get animating(): boolean {
    return this.#animate;
  }

  get columns(): number {
    return this.#stream.columns ?? this.#fallbackColumns;
  }

  /**
   * Replace the live rows.
   *
   * On a non-TTY this is a no-op: an un-animated stream shows rows only when they are
   * committed, so a hundred progress updates become one line instead of a hundred.
   */
  paint(rows: readonly string[]): void {
    if (!this.#animate) return;

    this.#live = rows;
    this.#hideCursor();

    // Clipped here rather than trusted from the caller: a row that wraps breaks the
    // cursor arithmetic for every subsequent paint, and the caller cannot always know
    // the width.
    const fitted = rows.map((row) => clip(row, this.columns));

    this.#stream.write(
      SYNC_START +
        this.#moveToTop() +
        CLEAR_BELOW +
        fitted.join('\n') +
        SYNC_END,
    );

    this.#liveRowCount = fitted.length;
  }

  /**
   * Move a line into permanent history, above the live block.
   *
   * On a non-TTY this is the ONLY thing that prints, which is what makes the same code
   * produce a clean CI log and a live display without the caller branching.
   */
  commit(line: string): void {
    if (!this.#animate) {
      this.#stream.write(`${line}\n`);
      return;
    }

    this.#hideCursor();
    // Erase the live block, print the committed line where it started, then redraw the
    // live block below it. Repainting from `#live` rather than asking the caller means
    // committing never loses the rows still in flight.
    this.#stream.write(SYNC_START + this.#moveToTop() + CLEAR_BELOW + clip(line, this.columns) + '\n');
    this.#liveRowCount = 0;
    this.#stream.write(SYNC_END);

    this.paint(this.#live);
  }

  /**
   * Erase the live block and restore the cursor.
   *
   * Must run in a `finally`. IssueForge's own convention is that a crashed run cleans
   * up after itself — a run that dies leaving the cursor hidden is the cosmetic twin of
   * one that dies leaving an issue locked, and the user's shell stays broken until they
   * type `reset`.
   */
  stop(): void {
    if (this.#animate && this.#liveRowCount > 0) {
      this.#stream.write(this.#moveToTop() + CLEAR_BELOW);
      this.#liveRowCount = 0;
    }
    this.#live = [];
    this.#showCursor();
  }

  /**
   * Put the cursor at column 0 of the first live row.
   *
   * `ESC[nF` is Cursor Previous Line: up n lines AND to column 0. The count is
   * `rows - 1` because the cursor already sits on the last row after writing it. With
   * zero or one rows there is nothing to climb, so a bare carriage return is enough —
   * and `ESC[0F` is not reliably a no-op across terminals.
   */
  #moveToTop(): string {
    return this.#liveRowCount > 1 ? `${ESC}[${this.#liveRowCount - 1}F` : '\r';
  }

  #hideCursor(): void {
    if (this.#cursorHidden) return;
    this.#stream.write(HIDE_CURSOR);
    this.#cursorHidden = true;
  }

  #showCursor(): void {
    if (!this.#cursorHidden) return;
    this.#stream.write(SHOW_CURSOR);
    this.#cursorHidden = false;
  }
}
