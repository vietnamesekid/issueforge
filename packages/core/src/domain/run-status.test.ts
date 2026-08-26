import { describe, it, expect } from 'vitest';
import { RunStatus } from '@issueforge/contracts';
import { isTerminal, mayHoldProcesses } from './run-status.js';

describe('run lifecycle classification', () => {
  it('classifies EVERY status — a run is finished, or it is not', () => {
    // The bug this test exists for: TERMINAL and ACTIVE were two hand-maintained
    // arrays, and `interrupted` was in neither. `clean` filters on isTerminal, so
    // runs killed by the reaper — the ones most likely to have left a dirty worktree —
    // were the only ones it never removed. The leak grew with every crash.
    const unclassified = RunStatus.options.filter(
      (status) => !isTerminal(status) && !mayHoldProcesses(status),
    );

    expect(unclassified, 'every status must be terminal or active').toEqual([]);
  });

  it('never calls a status both finished and running', () => {
    const both = RunStatus.options.filter((s) => isTerminal(s) && mayHoldProcesses(s));
    expect(both).toEqual([]);
  });

  it('treats a reaped run as finished, so cleanup can reclaim its workspace', () => {
    // `interrupted` is written by exactly one component — the reaper, after it kills
    // an orphaned process group. The processes are gone by then, so the run is over.
    expect(isTerminal('interrupted')).toBe(true);
    expect(mayHoldProcesses('interrupted')).toBe(false);
  });

  it('treats queued and running as possibly holding processes', () => {
    expect(mayHoldProcesses('queued')).toBe(true);
    expect(mayHoldProcesses('running')).toBe(true);
  });

  it('treats every conclusion as finished', () => {
    for (const status of ['reproduced', 'cannot-reproduce', 'needs-info'] as const) {
      expect(isTerminal(status), status).toBe(true);
    }
  });

  it('treats a blocked or cancelled run as finished', () => {
    expect(isTerminal('blocked')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
  });
});
