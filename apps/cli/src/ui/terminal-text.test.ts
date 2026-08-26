import { describe, expect, it } from 'vitest';
import { clip, displayWidth, fit, oneLine, padTo, sanitise, stripAnsi } from './terminal-text.js';

/** Built from a code point so no raw control byte is ever typed into this file. */
const ESC = String.fromCharCode(0x1b);
const red = (text: string): string => `${ESC}[31m${text}${ESC}[0m`;

describe('displayWidth', () => {
  it('counts a wide character as the two cells it actually occupies', () => {
    // The bug this guards: `renderStatusTable` padded with `padEnd`, which counts
    // UTF-16 units. A repo or issue title with CJK text made every column after it
    // ragged, and nothing failed — the table just looked broken.
    expect(displayWidth('日本語')).toBe(6);
    expect('日本語'.length).toBe(3);
  });

  it('ignores escape sequences, which occupy no cells', () => {
    expect(displayWidth(red('abc'))).toBe(3);
  });

  it('counts an astral-plane emoji once, not twice', () => {
    // Iterating by UTF-16 unit would see two surrogates and return 4.
    expect(displayWidth('🚀')).toBe(2);
  });

  it('does not count combining marks, which render into the preceding cell', () => {
    expect(displayWidth('é')).toBe(1);
  });
});

describe('sanitise', () => {
  it('strips a carriage return, which would overwrite the line above it', () => {
    // Issue text is attacker-controlled. `\r` returns the cursor to column 0, so a
    // crafted issue title can overwrite whatever IssueForge printed before it.
    expect(sanitise('safe\rEVIL')).toBe('safeEVIL');
  });

  it('strips a clear-screen sequence out of untrusted text', () => {
    expect(sanitise(`title${ESC}[2J`)).toBe('title');
  });

  it('keeps newline and tab, which renderers use deliberately', () => {
    expect(sanitise('a\nb\tc')).toBe('a\nb\tc');
  });
});

describe('oneLine', () => {
  it('collapses a newline, which would otherwise forge a whole extra row', () => {
    // The bug this exists for: `sanitise` deliberately keeps `\n`, so a detail
    // containing one printed a second line indistinguishable from a real run — issue
    // text inventing a status the ledger never recorded.
    expect(oneLine('real\n✓ fixed  #999  run_forged')).toBe('real ✓ fixed  #999  run_forged');
  });

  it('collapses tabs too, which shift a cell out of its column', () => {
    expect(oneLine('a\tb')).toBe('a b');
  });

  it('collapses a run of whitespace into a single space', () => {
    expect(oneLine('a\n\n\nb')).toBe('a b');
  });

  it('still strips what sanitise strips', () => {
    expect(oneLine('safe\rEVIL')).toBe('safeEVIL');
    expect(oneLine(`x${ESC}[2J`)).toBe('x');
  });
});

describe('clip', () => {
  it('leaves text that already fits completely alone', () => {
    expect(clip('abc', 10)).toBe('abc');
  });

  it('never exceeds the limit, counting the ellipsis', () => {
    const clipped = clip('abcdefghij', 5);
    expect(displayWidth(clipped)).toBe(5);
    expect(clipped).toBe('abcd…');
  });

  it('resets style when the cut passed through an escape', () => {
    // Without the reset the terminal stays red for everything printed afterwards —
    // the clipped row bleeds its colour into the rest of the table.
    const clipped = clip(red('abcdefghij'), 5);
    expect(clipped.endsWith(`${ESC}[0m`)).toBe(true);
    expect(displayWidth(clipped)).toBe(5);
  });

  it('does not split a wide character across the boundary', () => {
    // Budget is 3 cells after reserving one for the ellipsis; the second CJK char
    // costs 2 and must not be half-emitted.
    expect(displayWidth(clip('日本語', 4))).toBeLessThanOrEqual(4);
  });
});

describe('padTo and fit', () => {
  it('pads by measured width, not by .length', () => {
    expect(displayWidth(padTo('日本', 10))).toBe(10);
  });

  it('pads a styled string to its visible width', () => {
    // `padEnd` would count the escape bytes and pad far too little.
    expect(displayWidth(padTo(red('ok'), 8))).toBe(8);
  });

  it('leaves text longer than the target untouched', () => {
    expect(padTo('abcdef', 3)).toBe('abcdef');
  });

  it('fit always produces exactly the requested width, in both directions', () => {
    expect(displayWidth(fit('a', 6))).toBe(6);
    expect(displayWidth(fit('abcdefghij', 6))).toBe(6);
    expect(displayWidth(fit('日本語です', 6))).toBe(6);
  });
});

describe('stripAnsi', () => {
  it('removes sequences we would never emit ourselves', () => {
    // The point is measuring text someone else produced, not only our own colours.
    expect(stripAnsi(`${ESC}[38;5;204mx${ESC}[0m`)).toBe('x');
  });
});
