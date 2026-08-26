import { describe, it, expect } from 'vitest';
import { IssueForgeConfig } from '@issueforge/contracts';
import { taskIsPermitted } from './policy.js';

const config = (stopAfter?: 'reproduce' | 'fix') =>
  IssueForgeConfig.parse(stopAfter === undefined ? {} : { policy: { stopAfter } });

describe('taskIsPermitted', () => {
  it('allows both tasks by default', () => {
    // A tool that silently refused to fix would confuse more than it protects.
    expect(taskIsPermitted('reproduce', config())).toBe(true);
    expect(taskIsPermitted('fix', config())).toBe(true);
  });

  it('lets a repository pin itself to investigation only', () => {
    // Sentry's stopping point: triage output is valuable on its own, and a maintainer
    // should be able to say "not on this repo" without uninstalling anything.
    expect(taskIsPermitted('reproduce', config('reproduce'))).toBe(true);
    expect(taskIsPermitted('fix', config('reproduce'))).toBe(false);
  });

  it('never blocks reproduce — it is the rung everything else stands on', () => {
    for (const stopAfter of ['reproduce', 'fix'] as const) {
      expect(taskIsPermitted('reproduce', config(stopAfter)), stopAfter).toBe(true);
    }
  });
});
