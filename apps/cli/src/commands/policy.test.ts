import { describe, it, expect } from 'vitest';
import { IssueForgeConfig } from '@issueforge/contracts';
import { taskIsPermitted, declinedReason } from './policy.js';

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

describe('taskIsPermitted — fail closed', () => {
  it('refuses a task that is not on the ladder at all', () => {
    // The bug this guards: a new TaskKind registered in contracts but never added
    // to LADDER would be permitted by a permissive default. `verify` is planned;
    // until it is placed on the ladder deliberately, policy must decline it rather
    // than let an unplaced task run code on someone's machine.
    const unknown = 'verify' as Parameters<typeof taskIsPermitted>[0];

    expect(taskIsPermitted(unknown, config())).toBe(false);
    expect(taskIsPermitted(unknown, config('fix'))).toBe(false);
  });

  it('refuses everything when stopAfter names something off the ladder', () => {
    // A hand-edited config.json can hold anything. An unrecognised stopAfter must
    // not read as "no limit" — the run that follows would be the one the maintainer
    // was trying to prevent.
    const broken = { policy: { stopAfter: 'nonsense' } } as unknown as Parameters<
      typeof taskIsPermitted
    >[1];

    expect(taskIsPermitted('reproduce', broken)).toBe(false);
    expect(taskIsPermitted('fix', broken)).toBe(false);
  });
});

describe('declinedReason', () => {
  it('names the setting, the file and the fix', () => {
    // Written for the maintainer who just applied a label and saw nothing happen.
    // "Not permitted" alone leaves them guessing which of several controls stopped
    // it.
    const reason = declinedReason('fix', config('reproduce'));

    expect(reason).toContain('fix');
    expect(reason).toContain('policy.stopAfter');
    expect(reason).toContain('.issueforge/config.json');
    expect(reason).toContain('reproduce');
  });
});
