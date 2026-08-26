import { describe, expect, it } from 'vitest';
import { LiveRegion, type WriteStream } from './live-region.js';

const ESC = String.fromCharCode(0x1b);

/**
 * A hand-written fake, per the repo rule against `vi.mock`.
 *
 * Records every chunk separately so a test can assert on the ORDER of writes, which is
 * what the repaint correctness actually depends on.
 */
class FakeStream implements WriteStream {
  readonly chunks: string[] = [];
  isTTY: boolean | undefined;
  columns: number | undefined;

  constructor(isTTY: boolean, columns?: number) {
    this.isTTY = isTTY;
    this.columns = columns;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get all(): string {
    return this.chunks.join('');
  }
}

describe('LiveRegion on a TTY', () => {
  it('does not move the cursor up on the first paint — there is nothing above yet', () => {
    // The bug this guards: seeding #liveRowCount from the rows being painted rather
    // than the rows already on screen makes the first paint climb into whatever the
    // user's shell printed before the command ran, and erase it.
    const stream = new FakeStream(true, 80);
    const region = new LiveRegion({ stream });

    region.paint(['one', 'two', 'three']);

    expect(stream.all).not.toContain(`${ESC}[2F`);
    expect(stream.all).toContain('\r');
  });

  it('climbs exactly rows-1 lines on the second paint', () => {
    // The cursor sits on the LAST row after writing, so reaching the first means going
    // up rows-1. Off by one here silently eats a line of committed history per repaint.
    const stream = new FakeStream(true, 80);
    const region = new LiveRegion({ stream });

    region.paint(['one', 'two', 'three']);
    stream.chunks.length = 0;
    region.paint(['one', 'two', 'three']);

    expect(stream.all).toContain(`${ESC}[2F`);
  });

  it('uses a carriage return rather than ESC[0F for a single row', () => {
    // `ESC[0F` is not reliably a no-op — some terminals treat 0 as 1 and climb anyway.
    const stream = new FakeStream(true, 80);
    const region = new LiveRegion({ stream });

    region.paint(['only']);
    stream.chunks.length = 0;
    region.paint(['only']);

    expect(stream.all).not.toContain(`${ESC}[0F`);
    expect(stream.all).toContain('\r');
  });

  it('wraps each repaint in synchronized-output markers', () => {
    // Without mode 2026 the erase and the redraw are separate writes and the frame
    // tears visibly.
    const stream = new FakeStream(true, 80);
    new LiveRegion({ stream }).paint(['row']);

    expect(stream.all).toContain(`${ESC}[?2026h`);
    expect(stream.all).toContain(`${ESC}[?2026l`);
  });

  it('clips a row to the terminal width, because one row must be one screen line', () => {
    // A wrapped row occupies two screen lines while the region believes it occupies
    // one, so every later repaint climbs too few lines and corrupts the history above.
    const stream = new FakeStream(true, 20);
    const region = new LiveRegion({ stream });

    region.paint(['x'.repeat(200)]);

    const painted = stream.all.split(`${ESC}[0J`)[1] ?? '';
    expect(painted.replace(`${ESC}[?2026l`, '').length).toBeLessThanOrEqual(20);
  });

  it('hides the cursor once, not on every paint', () => {
    const stream = new FakeStream(true, 80);
    const region = new LiveRegion({ stream });

    region.paint(['a']);
    region.paint(['b']);
    region.paint(['c']);

    const hides = stream.all.split(`${ESC}[?25l`).length - 1;
    expect(hides).toBe(1);
  });

  it('restores the cursor on stop', () => {
    // A run that dies with the cursor hidden leaves the user's shell broken until they
    // type `reset` — the cosmetic twin of leaving an issue locked.
    const stream = new FakeStream(true, 80);
    const region = new LiveRegion({ stream });

    region.paint(['a']);
    region.stop();

    expect(stream.all).toContain(`${ESC}[?25h`);
  });

  it('keeps the live rows visible after committing a line above them', () => {
    const stream = new FakeStream(true, 80);
    const region = new LiveRegion({ stream });

    region.paint(['live one', 'live two']);
    stream.chunks.length = 0;
    region.commit('done');

    expect(stream.all).toContain('done');
    // Repainted from its own state, so committing never drops rows still in flight.
    expect(stream.all).toContain('live one');
    expect(stream.all).toContain('live two');
  });
});

describe('LiveRegion without a TTY', () => {
  it('emits NOTHING for a paint — a CI log gets no repaint spam', () => {
    // 400 progress updates through a pipe must not become 400 lines of escape codes.
    const stream = new FakeStream(false);
    const region = new LiveRegion({ stream });

    region.paint(['working', 'still working']);

    expect(stream.all).toBe('');
  });

  it('prints committed lines plainly, with no escape sequences at all', () => {
    const stream = new FakeStream(false);
    const region = new LiveRegion({ stream });

    region.commit('cloned pinned commit');
    region.commit('workspace prepared');

    expect(stream.all).toBe('cloned pinned commit\nworkspace prepared\n');
    expect(stream.all).not.toContain(ESC);
  });

  it('writes nothing on stop, having hidden no cursor', () => {
    const stream = new FakeStream(false);
    const region = new LiveRegion({ stream });

    region.paint(['a']);
    region.stop();

    expect(stream.all).toBe('');
  });
});

describe('width handling', () => {
  it('falls back to 80 columns when the stream reports none', () => {
    expect(new LiveRegion({ stream: new FakeStream(true) }).columns).toBe(80);
  });

  it('follows the stream, so a resize is picked up on the next paint', () => {
    // Read on each access rather than cached in the constructor: a terminal resized
    // mid-run would otherwise keep clipping to the old width for the rest of the run.
    const stream = new FakeStream(true, 100);
    const region = new LiveRegion({ stream });
    expect(region.columns).toBe(100);

    stream.columns = 40;
    expect(region.columns).toBe(40);
  });
});
