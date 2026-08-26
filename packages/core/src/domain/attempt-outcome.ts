import type { HarnessRunOutcome, RunStatus, TaskOutcome } from '@issueforge/contracts';

/**
 * How an attempt ended, in the ledger's vocabulary.
 *
 * Pure, so the mapping can be reasoned about without a database or a subprocess.
 *
 * The distinction that matters most here is between "the harness reached a conclusion"
 * and "we could not run it properly". Both leave the issue unfixed, but only the first
 * says anything about the bug — reporting a broken sandbox as `cannot-reproduce` would
 * tell a maintainer something false.
 */
export interface AttemptClassification {
  /** The run's lifecycle state, shown by `issueforge status`. */
  status: RunStatus;
  detail: string;
  /**
   * How this attempt ended, for the per-attempt ledger.
   *
   * Emitted here rather than re-derived from `status` by the caller. It used to be
   * re-derived, by a mapper with no branch that could produce `timeout` — so every
   * timed-out attempt was recorded as `completed`, and the most common way an agent
   * run fails looked like success in the one table meant to explain retries.
   */
  outcome: TaskOutcome;
}

export interface AttemptFailure {
  kind: 'contract' | 'timeout' | 'cancelled' | 'crash';
  message: string;
}

/**
 * Classify a harness run that completed without the supervisor intervening.
 *
 * This is bookkeeping, not adjudication. The harness reports its findings to the issue
 * and a human reviews them there; what is recorded here is what `issueforge status`
 * needs to answer "what happened" without anyone reading a transcript.
 */
export function classifyAttempt(outcome: HarnessRunOutcome): AttemptClassification {
  if (!outcome.ok) {
    return {
      status: 'needs-info',
      detail: 'the harness did not complete its task',
      outcome: 'error',
    };
  }

  if (outcome.result === undefined) {
    return {
      status: 'needs-info',
      detail: 'the harness returned no structured result',
      outcome: 'error',
    };
  }

  // Verdict is a subset of RunStatus, asserted in the contracts test.
  return {
    status: outcome.result.verdict,
    detail: outcome.result.summary || `harness reported: ${outcome.result.verdict}`,
    outcome: 'completed',
  };
}

/** Classify a run the supervisor or the contract cut short. */
export function classifyFailure(failure: AttemptFailure): AttemptClassification {
  switch (failure.kind) {
    case 'contract':
      // The sandbox was not what was requested, so nothing the harness produced may
      // be interpreted. That is a policy stop, not a finding about the bug.
      return { status: 'blocked', detail: failure.message, outcome: 'error' };
    case 'timeout':
      return {
        status: 'needs-info',
        detail: `the harness exceeded its time budget: ${failure.message}`,
        outcome: 'timeout',
      };
    case 'cancelled':
      return { status: 'cancelled', detail: failure.message, outcome: 'cancelled' };
    case 'crash':
      return { status: 'needs-info', detail: failure.message, outcome: 'error' };
  }
}
