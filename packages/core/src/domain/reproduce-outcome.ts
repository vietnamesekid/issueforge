import type { HarnessRunOutcome, RunStatus } from '@issueforge/contracts';

/**
 * How a reproduce attempt ended, in the ledger's vocabulary.
 *
 * Pure, so the mapping can be reasoned about without a database or a subprocess.
 *
 * The distinction that matters most here is between "the bug did not reproduce" and
 * "we could not run the check properly". Both leave the issue unfixed, but only the
 * first is a statement about the bug — reporting a broken sandbox as
 * `cannot-reproduce` would tell a maintainer something false.
 */
export interface AttemptClassification {
  status: RunStatus;
  detail: string;
  /** Whether the harness produced a claim worth validating at all. */
  hasClaim: boolean;
}

export interface AttemptFailure {
  kind: 'contract' | 'timeout' | 'cancelled' | 'crash';
  message: string;
}

/**
 * Classify a harness run that completed without the supervisor intervening.
 *
 * Note this is deliberately NOT a verdict on the bug: a claim is untrusted input, and
 * only replaying the evidence can settle it. The most this can say is whether there
 * is anything worth replaying.
 */
export function classifyAttempt(outcome: HarnessRunOutcome): AttemptClassification {
  if (!outcome.ok) {
    return {
      status: 'needs-info',
      detail: 'the harness did not complete its task',
      hasClaim: false,
    };
  }

  if (outcome.result === undefined) {
    return {
      status: 'needs-info',
      detail: 'the harness returned no structured result to verify',
      hasClaim: false,
    };
  }

  // A claim exists. Whether it holds is IF-010's decision, so the run stays `running`
  // until evidence has been replayed — recording a verdict here would be trusting it.
  return {
    status: 'running',
    detail: `harness claims: ${outcome.result.verdict}`,
    hasClaim: true,
  };
}

/** Classify a run the supervisor or the contract cut short. */
export function classifyFailure(failure: AttemptFailure): AttemptClassification {
  switch (failure.kind) {
    case 'contract':
      // The sandbox was not what was requested, so nothing the harness produced may
      // be interpreted. That is a policy stop, not a finding about the bug.
      return { status: 'blocked', detail: failure.message, hasClaim: false };
    case 'timeout':
      return {
        status: 'needs-info',
        detail: `the harness exceeded its time budget: ${failure.message}`,
        hasClaim: false,
      };
    case 'cancelled':
      return { status: 'cancelled', detail: failure.message, hasClaim: false };
    case 'crash':
      return { status: 'needs-info', detail: failure.message, hasClaim: false };
  }
}
