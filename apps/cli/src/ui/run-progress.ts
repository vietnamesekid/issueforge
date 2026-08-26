import type { RunPhase, RunPhaseEvent } from '@issueforge/contracts';
import type { LiveRegion } from './live-region.js';
import { oneLine } from './terminal-text.js';
import type { Theme } from './theme.js';

/**
 * Shows what a run is doing while it does it.
 *
 * A run takes minutes and, until now, printed nothing until it finished — so the
 * honest reading of a slow run and a hung one were identical. This turns the phases
 * `TaskRunner` already reports into a checklist that fills in as the run proceeds:
 *
 *   ✓ reaped orphaned runs
 *   ✓ acquired lock on issue #7
 *   ✓ cloned owner/repo at 4f1c2ab
 *   ▶ running claude-code             1m12s
 *   · audit
 *
 * Finished phases are committed to scrollback, so the run leaves a readable account
 * behind rather than erasing itself. On a non-TTY only the committed lines print, one
 * per phase, which is what a CI log wants.
 *
 * Nothing here reports what the AGENT is doing — only what IssueForge is doing on its
 * behalf. The harness reports its findings to the issue; that is the design, and
 * streaming its reasoning here would be the supervisor pretending to be the agent.
 */

/** Phases in the order they occur, with the line each one shows. */
const LABEL: Record<RunPhase, string> = {
  reaping: 'check for orphaned runs',
  locking: 'acquire the issue lock',
  cloning: 'clone the pinned commit',
  preparing: 'prepare the workspace',
  spawning: 'start the harness',
  working: 'run the task',
  auditing: 'audit the write boundary',
  finishing: 'record the result',
};

/** Past tense, for the line committed to scrollback once a phase is done. */
const DONE: Record<RunPhase, string> = {
  reaping: 'checked for orphaned runs',
  locking: 'acquired the issue lock',
  cloning: 'cloned the pinned commit',
  preparing: 'prepared the workspace',
  spawning: 'started the harness',
  working: 'ran the task',
  auditing: 'audited the write boundary',
  finishing: 'recorded the result',
};

const ORDER: readonly RunPhase[] = [
  'reaping',
  'locking',
  'cloning',
  'preparing',
  'spawning',
  'working',
  'auditing',
  'finishing',
];

/**
 * The frames of the running indicator.
 *
 * Braille dots rather than an ASCII spinner: they occupy one cell, are present in
 * every font that renders a modern terminal, and read as motion rather than as a
 * character changing.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** How often the elapsed clock and the spinner advance. */
const TICK_MS = 120;

export interface RunProgressOptions {
  theme: Theme;
  region: LiveRegion;
  /** Injected so a test can assert on elapsed rendering without waiting. */
  now?: () => number;
}

export class RunProgress {
  readonly #theme: Theme;
  readonly #region: LiveRegion;
  readonly #now: () => number;

  #current: RunPhase | undefined;
  #detail: string | undefined;
  #startedAt = 0;
  #frame = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RunProgressOptions) {
    this.#theme = options.theme;
    this.#region = options.region;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Advance to a phase.
   *
   * Committing the previous phase before painting the new one is what builds the
   * scrollback: each finished step becomes a permanent line, and only the current one
   * is transient.
   */
  advance(event: RunPhaseEvent): void {
    // Committed with the detail belonging to the phase being FINISHED, not the one
    // starting. Reading `#detail` after reassigning it printed "cloned the pinned
    // commit" annotated with the next phase's text.
    if (this.#current !== undefined) {
      this.#region.commit(this.#doneLine(this.#current, this.#detail));
    }

    this.#current = event.phase;
    // Sanitised because a detail can carry a repo name or an issue title, and issue
    // text is data, never instructions.
    this.#detail = event.detail === undefined ? undefined : oneLine(event.detail);
    this.#startedAt = this.#now();
    this.#frame = 0;

    this.#paint();
    this.#startTicking();
  }

  /**
   * Finish, committing the last phase and clearing the live block.
   *
   * Must run in a `finally`: an uncleared live region leaves the terminal cursor
   * hidden, and the timer would keep the process alive.
   */
  stop(): void {
    this.#stopTicking();
    if (this.#current !== undefined) {
      this.#region.commit(this.#doneLine(this.#current, this.#detail));
      this.#current = undefined;
    }
    this.#region.stop();
  }

  #doneLine(phase: RunPhase, detail: string | undefined): string {
    return `${this.#theme.success('✓')} ${DONE[phase]}${this.#suffix(detail)}`;
  }

  #suffix(detail: string | undefined): string {
    return detail === undefined ? '' : ` ${this.#theme.dim(detail)}`;
  }

  #paint(): void {
    const current = this.#current;
    if (current === undefined) return;

    const spinner = this.#theme.accent(FRAMES[this.#frame % FRAMES.length] ?? FRAMES[0]);
    const elapsed = this.#theme.dim(formatElapsed(this.#now() - this.#startedAt));

    const rows = [`${spinner} ${LABEL[current]}${this.#suffix(this.#detail)}  ${elapsed}`];

    // The steps still to come, so the user can see how much is left rather than
    // watching one line and guessing.
    for (const phase of ORDER.slice(ORDER.indexOf(current) + 1)) {
      rows.push(this.#theme.dim(`· ${LABEL[phase]}`));
    }

    this.#region.paint(rows);
  }

  #startTicking(): void {
    if (!this.#region.animating || this.#timer !== undefined) return;

    this.#timer = setInterval(() => {
      this.#frame += 1;
      this.#paint();
    }, TICK_MS);
    // Never hold the process open. A run that finished must exit even if `stop` was
    // somehow missed.
    this.#timer.unref();
  }

  #stopTicking(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Elapsed time, at the precision a watching human cares about.
 *
 * Seconds below a minute, then minutes and seconds. Hours matter because a fix task's
 * default timeout is 30 minutes and a self-hosted job may be given far longer.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
