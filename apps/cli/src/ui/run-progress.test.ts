import { describe, expect, it } from 'vitest';
import { LiveRegion, type WriteStream } from './live-region.js';
import { formatElapsed, RunProgress } from './run-progress.js';
import { createTheme } from './theme.js';

class FakeStream implements WriteStream {
  readonly chunks: string[] = [];
  isTTY: boolean | undefined;
  columns: number | undefined = 100;

  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get all(): string {
    return this.chunks.join('');
  }
}

const plain = createTheme({ color: false });

function progressOn(stream: FakeStream): RunProgress {
  return new RunProgress({
    theme: plain,
    region: new LiveRegion({ stream }),
    now: () => 0,
  });
}

describe('RunProgress on a non-TTY', () => {
  it('prints one line per finished phase and nothing else', () => {
    // What a CI log wants: an account of what happened, not repaint traffic.
    const stream = new FakeStream(false);
    const progress = progressOn(stream);

    progress.advance({ phase: 'cloning', at: 0 });
    progress.advance({ phase: 'spawning', at: 0 });
    progress.stop();

    expect(stream.all).toBe('✓ cloned the pinned commit\n✓ started the harness\n');
  });

  it('commits the FINISHED phase with its own detail, not the incoming one', () => {
    // The bug this exists for: `#detail` was read after being reassigned, so the line
    // for a completed phase was annotated with the text belonging to the one starting.
    const stream = new FakeStream(false);
    const progress = progressOn(stream);

    progress.advance({ phase: 'cloning', at: 0, detail: 'owner/repo at 4f1c2ab' });
    progress.advance({ phase: 'spawning', at: 0, detail: 'claude-code' });

    expect(stream.all).toContain('✓ cloned the pinned commit owner/repo at 4f1c2ab');
    expect(stream.all).not.toContain('cloned the pinned commit claude-code');
  });

  it('flattens a detail to one line, because a live row IS one screen line', () => {
    // Worse here than in a table: the live region moves the cursor up by the number of
    // rows it believes it painted. A detail containing `\n` makes one row occupy two
    // screen lines, so every later repaint climbs too few and corrupts the history
    // above it. The detail can carry a repo name or issue text, so it is reachable.
    const stream = new FakeStream(false);
    const progress = progressOn(stream);

    progress.advance({ phase: 'cloning', at: 0, detail: 'owner/repo\nSECOND LINE' });
    progress.stop();

    expect(stream.all.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
  });

  it('sanitises a detail, because it can carry issue-derived text', () => {
    // Issue text is data, never instructions. A crafted repo or issue string must not
    // be able to move the cursor or clear the screen.
    const stream = new FakeStream(false);
    const progress = progressOn(stream);

    progress.advance({ phase: 'cloning', at: 0, detail: 'safe\rEVIL' });
    progress.stop();

    expect(stream.all).not.toContain('\r');
    expect(stream.all).toContain('safeEVIL');
  });
});

describe('RunProgress on a TTY', () => {
  it('shows the remaining steps, so the user sees how much is left', () => {
    const stream = new FakeStream(true);
    const progress = progressOn(stream);

    progress.advance({ phase: 'cloning', at: 0 });

    expect(stream.all).toContain('clone the pinned commit');
    expect(stream.all).toContain('audit the write boundary');
    progress.stop();
  });

  it('clears the live block and restores the cursor on stop', () => {
    // The timer is unref'd and the cursor must come back, or the user's shell stays
    // broken until they type `reset`.
    const stream = new FakeStream(true);
    const progress = progressOn(stream);

    progress.advance({ phase: 'working', at: 0 });
    progress.stop();

    expect(stream.all).toContain(`${String.fromCharCode(0x1b)}[?25h`);
  });

  it('stop is safe when no phase ever started', () => {
    const stream = new FakeStream(true);
    expect(() => progressOn(stream).stop()).not.toThrow();
  });
});

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(7_000)).toBe('7s');
  });

  it('shows minutes and zero-padded seconds', () => {
    expect(formatElapsed(72_000)).toBe('1m12s');
  });

  it('shows hours, because a self-hosted job may be given far longer than the default', () => {
    expect(formatElapsed(3_723_000)).toBe('1h02m');
  });

  it('never renders negative time from a clock that moved backwards', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});
