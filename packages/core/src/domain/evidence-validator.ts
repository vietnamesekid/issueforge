import type {
  Argv,
  Evidence,
  HarnessResult,
  ReplayObservation,
  Sha,
  ValidationCheck,
  ValidationOutcome,
  ValidationStep,
  Verdict,
} from '@issueforge/contracts';
import type { DefectToggle, Replayer } from '../ports/replay.js';

/**
 * Decides whether a reproduction claim is supported by evidence.
 *
 * This is the product. Everything else — event delivery, worktrees, process
 * supervision — exists so that this check can be made honestly. A harness's
 * `result.json` is a *claim*; only replaying it settles whether it is true.
 *
 * The ladder runs cheapest-first, and the order is load-bearing rather than tidy:
 * the two expensive steps are the two that actually decide, so everything that can
 * disqualify a claim for free happens before a command is ever run.
 *
 * Two steps exist because of specific failures observed while proving this design:
 *
 *  - **Step 4** — a repro script containing nothing but `exit 1` initially passed.
 *    "The command failed" is weak evidence: a script that cannot succeed proves
 *    nothing about the bug.
 *  - **Step 7** — the differential check. A genuine reproduction fails on the buggy
 *    code *and passes once the bug is removed*. Without it, a test that fails for an
 *    entirely unrelated reason is indistinguishable from a real reproduction, and no
 *    amount of output-matching separates them.
 */

export interface ValidationRequest {
  claim: HarnessResult;
  /** Workspace the harness ran in, pinned to `baseSha`. */
  cwd: string;
  baseSha: Sha;
  /** HEAD as it actually is, so a moved workspace is caught rather than assumed. */
  headSha: Sha;
  /** Files the harness touched, from `git status --porcelain` — includes untracked. */
  changedFiles: readonly string[];
  /** Reads an artifact's contents; absent means it does not exist. */
  readArtifact(path: string): string | null;
  replayer: Replayer;
  /** Enables step 7. When absent the differential check is recorded as skipped. */
  defect?: DefectToggle;
  timeoutMs?: number;
}

/** Signals that a command failed for environmental reasons rather than the reported bug. */
const ENVIRONMENTAL = /MODULE_NOT_FOUND|Cannot find module|SyntaxError|command not found|ENOENT/i;

/** Evidence of a real check: an assertion, a comparison, or a test declaration. */
const MEANINGFUL = /assert|expect|throw|strictEqual|deepEqual|\btest\s*\(|\bit\s*\(|describe\s*\(|diff|grep|\[\[|\btest\b/i;

/** A script that only exits, with no logic at all. */
const ONLY_EXITS = /^\s*(#![^\n]*\n)?\s*(exit\s+\d+\s*)?$/;

export async function validateReproduction(
  request: ValidationRequest,
): Promise<ValidationOutcome> {
  const checks: ValidationCheck[] = [];
  const evidence: Evidence = {
    baseSha: request.baseSha,
    changedFiles: [...request.changedFiles],
    checks,
  };

  const reject = (verdict: Verdict, step: ValidationStep, detail: string): ValidationOutcome => {
    checks.push({ step, passed: false, detail });
    return { verdict, why: detail, evidence: { ...evidence, checks } };
  };
  const pass = (step: ValidationStep, detail = ''): void => {
    checks.push({ step, passed: true, detail });
  };

  // ---- 1. the claim itself ------------------------------------------------
  if (request.claim.verdict !== 'reproduced') {
    // Nothing to disprove. The harness already says it did not reproduce the bug,
    // and IssueForge does not manufacture a stronger claim than it was given.
    pass('claim-structure', `harness claimed ${request.claim.verdict}`);
    return {
      verdict: request.claim.verdict,
      why: 'the harness did not claim a reproduction',
      evidence,
    };
  }

  const command = request.claim.reproCommand;
  if (command === undefined || command.length === 0) {
    return reject('needs-info', 'claim-structure', 'the claim names no reproduction command');
  }
  pass('claim-structure');

  // ---- 2. artifacts exist -------------------------------------------------
  const artifacts = collectArtifacts(request.claim.testFile, command);
  const contents = new Map<string, string>();

  for (const path of artifacts) {
    const body = request.readArtifact(path);
    if (body === null) {
      return reject('needs-info', 'artifacts-exist', `claimed artifact does not exist: ${path}`);
    }
    if (body.trim().length === 0) {
      return reject('needs-info', 'artifacts-exist', `claimed artifact is empty: ${path}`);
    }
    contents.set(path, body);
  }
  pass('artifacts-exist', `${artifacts.length} artifact(s)`);

  // ---- 3. the workspace is where we think it is ---------------------------
  if (request.headSha !== request.baseSha) {
    return reject(
      'needs-info',
      'base-sha-matches',
      `workspace HEAD ${short(request.headSha)} does not match the pinned base ${short(request.baseSha)}`,
    );
  }
  pass('base-sha-matches');

  // ---- 4. the artifacts actually check something --------------------------
  for (const [path, body] of contents) {
    if (ONLY_EXITS.test(body)) {
      return reject(
        'cannot-reproduce',
        'artifacts-assert-something',
        `${path} does nothing but exit — failing is not evidence of the reported bug`,
      );
    }
    if (!MEANINGFUL.test(body)) {
      return reject(
        'cannot-reproduce',
        'artifacts-assert-something',
        `${path} contains no assertion or comparison, so it cannot demonstrate a failure`,
      );
    }
  }
  pass('artifacts-assert-something');

  // ---- 5. replay it ourselves ---------------------------------------------
  const onBase = await request.replayer.run(command, {
    cwd: request.cwd,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });
  evidence.baseReplay = onBase;

  if (onBase.timedOut) {
    return reject('needs-info', 'replay-fails-on-base', 'the reproduction command timed out');
  }
  if (onBase.exitCode === 0) {
    // The claim says the bug reproduces. It does not.
    return reject(
      'cannot-reproduce',
      'replay-fails-on-base',
      'the reproduction command PASSED on the pinned base commit — the claimed failure did not occur',
    );
  }
  pass('replay-fails-on-base', `exit ${onBase.exitCode}`);

  // ---- 6. it failed for the right kind of reason --------------------------
  if (ENVIRONMENTAL.test(onBase.output)) {
    return reject(
      'needs-info',
      'failure-is-not-environmental',
      'the command failed for an environmental reason (a missing module or syntax error), not the reported bug',
    );
  }
  if (
    request.claim.expectedSignal !== undefined &&
    !onBase.output.includes(request.claim.expectedSignal)
  ) {
    return reject(
      'cannot-reproduce',
      'failure-is-not-environmental',
      `the claimed failure signal ${JSON.stringify(request.claim.expectedSignal)} is absent from the replay output`,
    );
  }
  pass('failure-is-not-environmental');

  // ---- 7. does it discriminate? -------------------------------------------
  if (request.defect === undefined) {
    // Recorded as unproven rather than quietly treated as passed: without this check
    // a failure unrelated to the reported bug is indistinguishable from a real one.
    checks.push({
      step: 'differential-passes-after-fix',
      passed: false,
      detail: 'not checked — no fix was available to remove the defect',
    });
    return {
      verdict: 'reproduced',
      why: 'independent replay observed the claimed failure (differential check not available)',
      evidence,
    };
  }

  const afterFix = await runWithFix(request, command);
  evidence.postFixReplay = afterFix;

  if (afterFix.exitCode !== 0) {
    return reject(
      'cannot-reproduce',
      'differential-passes-after-fix',
      'the reproduction still fails once the defect is removed, so it does not isolate the reported bug',
    );
  }
  pass('differential-passes-after-fix', 'fails on the bug, passes without it');

  return {
    verdict: 'reproduced',
    why: 'independent replay observed the claimed failure, and it disappears once the defect is removed',
    evidence,
  };
}

/**
 * Run the repro with the defect removed, restoring it afterwards.
 *
 * The restore is in a `finally` because leaving a patched workspace behind would make
 * every later inspection of the evidence misleading.
 */
async function runWithFix(request: ValidationRequest, command: Argv): Promise<ReplayObservation> {
  const defect = request.defect;
  if (defect === undefined) throw new Error('unreachable: differential requires a defect toggle');

  await defect.applyFix(request.cwd);
  try {
    return await request.replayer.run(command, {
      cwd: request.cwd,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
  } finally {
    await defect.revertFix(request.cwd);
  }
}

/**
 * Every artifact the claim rests on.
 *
 * Deliberately includes any local script named in the command, not just `testFile`:
 * checking only the named test is what let a `repro.sh` containing `exit 1` through.
 */
function collectArtifacts(testFile: string | undefined, command: Argv): string[] {
  const paths = testFile !== undefined ? [testFile] : [];

  for (const argument of command) {
    if (/^\.{0,2}\/?[\w./-]+\.(sh|js|mjs|cjs|ts|py|rb)$/.test(argument)) {
      const normalised = argument.replace(/^\.\//, '');
      if (!paths.includes(normalised)) paths.push(normalised);
    }
  }

  return paths;
}

function short(sha: Sha): string {
  return sha.slice(0, 7);
}
