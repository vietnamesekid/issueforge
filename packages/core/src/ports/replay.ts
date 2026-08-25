import type { Argv, ReplayObservation } from '@issueforge/contracts';

/**
 * Runs a command and reports what happened, without interpreting it.
 *
 * Declared as a port because replay is the one thing IssueForge must do itself: the
 * whole product is that a harness's claim is checked by independent execution rather
 * than believed. Keeping it behind an interface also keeps the ladder pure, so the
 * decision logic can be tested without spawning anything.
 *
 * Implementations run untrusted code and must apply the same containment as a harness
 * run: env allowlist, argv arrays with no shell, and a wall-clock timeout.
 */
export interface Replayer {
  run(command: Argv, options: ReplayOptions): Promise<ReplayObservation>;
}

export interface ReplayOptions {
  cwd: string;
  timeoutMs?: number;
}

/**
 * Removes the defect so the differential check can run, then restores it.
 *
 * Step 7 needs to observe the repro passing once the bug is gone. Supplying that is
 * the caller's job — the fix task knows what the fix is — so this stays an optional
 * capability rather than something the validator invents.
 */
export interface DefectToggle {
  applyFix(cwd: string): Promise<void>;
  revertFix(cwd: string): Promise<void>;
}
