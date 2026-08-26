/**
 * Measuring, sanitising and clipping text destined for a terminal.
 *
 * Three separate things break when a renderer treats a string as its `.length`:
 *
 *  - A CJK or emoji character occupies TWO screen cells but counts as one (or two)
 *    UTF-16 code units, so `padEnd` produces columns that do not line up. Every value
 *    IssueForge prints today is ASCII, which is the only reason the existing tables
 *    look correct — a repository named `owner/日本語` breaks them immediately.
 *  - Styled text carries escape sequences that count toward `.length` and occupy no
 *    cells, so padding a coloured string pads it to the wrong width.
 *  - Slicing a styled string mid-escape leaves the terminal in that colour for
 *    everything printed afterwards.
 *
 * The fourth reason is not cosmetic. Issue titles and bodies are attacker-controlled
 * text, and IssueForge's rule is that issue text is data, never instructions. A title
 * containing `\r` overwrites the line above it; one containing `ESC[2J` clears the
 * screen. Anything sourced from GitHub goes through `sanitise` before it is printed.
 */

/**
 * CSI escape sequences: `ESC [ ... final-byte`.
 *
 * Deliberately matches the whole grammar rather than the colour codes we happen to
 * emit — the point is to measure and strip sequences someone ELSE produced, including
 * ones we would never write.
 */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Control characters that must never reach a terminal from untrusted text.
 *
 * Excludes `\n` (0x0a) and `\t` (0x09), which renderers use deliberately. Includes
 * `\r` (0x0d): a carriage return returns the cursor to column 0, letting a crafted
 * issue title overwrite the line printed before it.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Ranges that occupy two terminal cells. */
function isWide(codePoint: number): boolean {
  return (
    // CJK, Hangul, Kana, and the fullwidth forms block.
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    // Emoji and pictographs.
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff)
  );
}

/** Remove every escape sequence, leaving only what occupies screen cells. */
export function stripAnsi(text: string): string {
  return text.replace(CSI, '');
}

/**
 * Make untrusted text safe to print.
 *
 * Strips escape sequences AND raw control characters. Called on anything that came
 * from a GitHub issue — a title, a body, a harness detail string.
 */
export function sanitise(text: string): string {
  return stripAnsi(text).replace(CONTROL, '');
}

/**
 * Make untrusted text safe to print INSIDE A CELL.
 *
 * `sanitise` keeps `\n` and `\t` because renderers use them deliberately; a table cell
 * is not such a place. A detail carrying a newline printed a second line that looked
 * exactly like a real row, letting issue text forge a run status the ledger never
 * recorded — so anything going into one row of one column comes through here instead.
 */
export function oneLine(text: string): string {
  return sanitise(text).replace(/[\n\t]+/g, ' ');
}

/**
 * How many terminal cells this string occupies.
 *
 * Iterated by code point rather than by UTF-16 unit, so an astral-plane character is
 * measured once rather than twice.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    // Combining marks render into the preceding cell rather than one of their own.
    if (codePoint >= 0x0300 && codePoint <= 0x036f) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Cut text to at most `limit` cells, appending `…` when anything was removed.
 *
 * Escape sequences are carried through rather than counted, and a reset is appended
 * when the cut passed through one — otherwise the style bleeds into whatever the
 * terminal prints next.
 */
export function clip(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (displayWidth(text) <= limit) return text;

  // Reserve one cell for the ellipsis, so the result never exceeds `limit`.
  const budget = limit - 1;
  let width = 0;
  let output = '';
  let sawEscape = false;

  // Split so escape sequences survive as single units rather than being measured.
  for (const piece of text.split(/(\u001b\[[0-?]*[ -/]*[@-~])/)) {
    if (piece.length === 0) continue;

    if (CSI.test(piece)) {
      // `CSI` is a global regex, so `test` advances `lastIndex`; reset it or the next
      // call starts mid-string and reports a false negative.
      CSI.lastIndex = 0;
      sawEscape = true;
      output += piece;
      continue;
    }
    CSI.lastIndex = 0;

    for (const char of piece) {
      const cost = displayWidth(char);
      if (width + cost > budget) {
        return `${output}…${sawEscape ? '\u001b[0m' : ''}`;
      }
      width += cost;
      output += char;
    }
  }

  return `${output}…${sawEscape ? '\u001b[0m' : ''}`;
}

/**
 * Pad text to `width` cells with spaces.
 *
 * The measured-width counterpart to `padEnd`, which pads by `.length` and so produces
 * ragged columns for any non-ASCII or styled value.
 */
export function padTo(text: string, width: number): string {
  const padding = width - displayWidth(text);
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

/**
 * Fit text into exactly `width` cells: clipped if too long, padded if too short.
 *
 * What table columns want — a cell that is always the same width whatever is in it.
 */
export function fit(text: string, width: number): string {
  return padTo(clip(text, width), width);
}
