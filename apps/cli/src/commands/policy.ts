import type { IssueForgeConfig, TaskKind } from '@issueforge/contracts';

/**
 * How far a run may go on this repository.
 *
 * The two tasks form a ladder — `reproduce` investigates and reports, `fix` also
 * changes code and opens a draft PR — and `policy.stopAfter` lets a repository pin
 * itself to the lower rung.
 *
 * Modelled on Sentry Seer's "Automated Run Stopping Point", which defaults to stopping
 * before code generation. The reasoning that carries over: triage output is valuable on
 * its own, and a maintainer should be able to say "not on this repo" without
 * uninstalling anything or trusting everyone with write access to avoid a label.
 *
 * Default is the full ladder. A tool that silently declined to fix would confuse more
 * than it protects, so stopping early is opt-in and is reported when it happens.
 */
const LADDER: readonly TaskKind[] = ['reproduce', 'fix'];

export function taskIsPermitted(task: TaskKind, config: Pick<IssueForgeConfig, 'policy'>): boolean {
  const limit = LADDER.indexOf(config.policy.stopAfter);
  const wanted = LADDER.indexOf(task);

  // An unknown task is not on the ladder at all; refuse rather than guess.
  if (wanted === -1) return false;
  return wanted <= limit;
}

/** Why a task was declined, written for the maintainer who applied the label. */
export function declinedReason(task: TaskKind, config: Pick<IssueForgeConfig, 'policy'>): string {
  return (
    `the "${task}" task is disabled on this repository: ` +
    `policy.stopAfter is "${config.policy.stopAfter}" in .issueforge/config.json. ` +
    `Change it to "${task}" to allow this, or remove the label.`
  );
}
