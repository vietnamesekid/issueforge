import type { HarnessRunOutcome, RunStatus } from '@issueforge/contracts';

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
  status: RunStatus;
  detail: string;
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
    return { status: 'needs-info', detail: 'the harness did not complete its task' };
  }

  if (outcome.result === undefined) {
    return { status: 'needs-info', detail: 'the harness returned no structured result' };
  }

  // Verdict is a subset of RunStatus, asserted in the contracts test.
  return {
    status: outcome.result.verdict,
    detail: outcome.result.summary || `harness reported: ${outcome.result.verdict}`,
  };
}

/** Classify a run the supervisor or the contract cut short. */
export function classifyFailure(failure: AttemptFailure): AttemptClassification {
  switch (failure.kind) {
    case 'contract':
      // The sandbox was not what was requested, so nothing the harness produced may
      // be interpreted. That is a policy stop, not a finding about the bug.
      return { status: 'blocked', detail: failure.message };
    case 'timeout':
      return { status: 'needs-info', detail: `the harness exceeded its time budget: ${failure.message}` };
    case 'cancelled':
      return { status: 'cancelled', detail: failure.message };
    case 'crash':
      return { status: 'needs-info', detail: failure.message };
  }
}
