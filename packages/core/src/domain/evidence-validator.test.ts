import { describe, it, expect } from 'vitest';
import type { Argv, HarnessResult, ReplayObservation, Sha } from '@issueforge/contracts';
import type { DefectToggle, ReplayOptions, Replayer } from '../ports/replay.js';
import { validateReproduction, type ValidationRequest } from './evidence-validator.js';

const BASE = 'a'.repeat(40) as Sha;

/** A replayer under the test's control, so the ladder is exercised without spawning. */
class ScriptedReplayer implements Replayer {
  readonly calls: Argv[] = [];
  #results: ReplayObservation[];

  constructor(...results: Array<Partial<ReplayObservation>>) {
    this.#results = results.map((r) => ({
      command: ['npm', 'test'],
      exitCode: 1,
      output: '',
      durationMs: 1,
      timedOut: false,
      ...r,
    }));
  }

  async run(command: Argv, _options: ReplayOptions): Promise<ReplayObservation> {
    this.calls.push(command);
    const next = this.#results.shift();
    if (next === undefined) throw new Error('replayer called more times than scripted');
    return { ...next, command: [...command] };
  }
}

class RecordingToggle implements DefectToggle {
  applied = 0;
  reverted = 0;
  async applyFix(): Promise<void> { this.applied++; }
  async revertFix(): Promise<void> { this.reverted++; }
}

const REAL_TEST = `
import { test } from 'node:test';
import assert from 'node:assert';
test('value containing = is truncated', () => {
  assert.deepEqual(parsePair('url=http://x?a=1'), { key: 'url', value: 'http://x?a=1' });
});
`;

function request(overrides: Partial<ValidationRequest> = {}): ValidationRequest {
  const claim: HarnessResult = {
    verdict: 'reproduced',
    reproCommand: ['npm', 'test'],
    testFile: 'test/repro.test.js',
    summary: 's',
  };

  return {
    claim,
    cwd: '/ws',
    baseSha: BASE,
    headSha: BASE,
    changedFiles: ['test/repro.test.js'],
    readArtifact: () => REAL_TEST,
    replayer: new ScriptedReplayer({ exitCode: 1, output: 'AssertionError: expected ...' }),
    ...overrides,
  };
}

describe('validateReproduction — the ladder', () => {
  it('accepts a genuine reproduction that fails on base', async () => {
    const outcome = await validateReproduction(request());

    expect(outcome.verdict).toBe('reproduced');
    expect(outcome.evidence.baseReplay?.exitCode).toBe(1);
    expect(outcome.evidence.checks.filter((c) => c.passed).map((c) => c.step)).toContain(
      'replay-fails-on-base',
    );
  });

  it('REJECTS a liar whose command actually passes', async () => {
    // The plain case: the harness says "reproduced", the command says otherwise.
    const outcome = await validateReproduction(
      request({ replayer: new ScriptedReplayer({ exitCode: 0, output: 'all tests passed' }) }),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/PASSED on the pinned base/);
  });

  it('REJECTS a repro script that does nothing but exit', async () => {
    // "The command failed" is weak evidence. This slipped through in SPIKE-D because
    // only `testFile` was inspected, not the script the command actually runs.
    const outcome = await validateReproduction(
      request({
        claim: { verdict: 'reproduced', reproCommand: ['./repro.sh'], summary: 's' },
        readArtifact: () => '#!/bin/sh\nexit 1\n',
      }),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/does nothing but exit/);
  });

  it('inspects a script named in the command, not only testFile', async () => {
    const outcome = await validateReproduction(
      request({
        claim: {
          verdict: 'reproduced',
          reproCommand: ['sh', './repro.sh'],
          testFile: 'test/repro.test.js',
          summary: 's',
        },
        readArtifact: (path) => (path.endsWith('repro.sh') ? 'exit 1\n' : REAL_TEST),
      }),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/repro\.sh/);
  });

  it('REJECTS an artifact with no assertion at all', async () => {
    const outcome = await validateReproduction(
      request({ readArtifact: () => '// just a comment\nconsole.log("ran");\n' }),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/no assertion or comparison/);
  });

  it('reports needs-info when a claimed artifact is missing', async () => {
    const outcome = await validateReproduction(request({ readArtifact: () => null }));
    expect(outcome.verdict).toBe('needs-info');
    expect(outcome.why).toMatch(/does not exist/);
  });

  it('reports needs-info when an artifact is empty', async () => {
    const outcome = await validateReproduction(request({ readArtifact: () => '   \n' }));
    expect(outcome.verdict).toBe('needs-info');
    expect(outcome.why).toMatch(/is empty/);
  });

  it('reports needs-info when the workspace is not on the pinned commit', async () => {
    // Evidence gathered somewhere else says nothing about this base SHA.
    const outcome = await validateReproduction(request({ headSha: 'b'.repeat(40) as Sha }));
    expect(outcome.verdict).toBe('needs-info');
    expect(outcome.why).toMatch(/does not match the pinned base/);
  });

  it('reports needs-info when the failure is environmental', async () => {
    // A missing module is a broken checkout, not a reproduction of the reported bug.
    const outcome = await validateReproduction(
      request({
        replayer: new ScriptedReplayer({
          exitCode: 1,
          output: "Error: Cannot find module '../src/does-not-exist.js'",
        }),
      }),
    );

    expect(outcome.verdict).toBe('needs-info');
    expect(outcome.why).toMatch(/environmental/);
  });

  it('reports needs-info when the replay times out', async () => {
    const outcome = await validateReproduction(
      request({ replayer: new ScriptedReplayer({ exitCode: -1, timedOut: true }) }),
    );
    expect(outcome.verdict).toBe('needs-info');
    expect(outcome.why).toMatch(/timed out/);
  });

  it('rejects a claim whose expected signal is absent from the output', async () => {
    const outcome = await validateReproduction(
      request({
        claim: {
          verdict: 'reproduced',
          reproCommand: ['npm', 'test'],
          testFile: 'test/repro.test.js',
          expectedSignal: 'TypeError: cannot read property',
          summary: 's',
        },
        replayer: new ScriptedReplayer({ exitCode: 1, output: 'AssertionError: something else' }),
      }),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/signal.*absent/i);
  });

  it('reports needs-info when the claim names no command', async () => {
    const outcome = await validateReproduction(
      request({ claim: { verdict: 'reproduced', summary: 's' } }),
    );
    expect(outcome.verdict).toBe('needs-info');
    expect(outcome.why).toMatch(/names no reproduction command/);
  });

  it('passes through a harness that already said it could not reproduce', async () => {
    // Nothing to disprove, and IssueForge never manufactures a stronger claim than
    // the one it was given.
    const outcome = await validateReproduction(
      request({ claim: { verdict: 'cannot-reproduce', summary: 'no repro steps' } }),
    );
    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.evidence.baseReplay).toBeUndefined(); // nothing was run
  });
});

describe('the differential check — step 7', () => {
  it('accepts a repro that fails on the bug and passes once it is removed', async () => {
    const toggle = new RecordingToggle();
    const outcome = await validateReproduction(
      request({
        replayer: new ScriptedReplayer(
          { exitCode: 1, output: 'AssertionError' }, // on base
          { exitCode: 0, output: 'ok' },             // after the fix
        ),
        defect: toggle,
      }),
    );

    expect(outcome.verdict).toBe('reproduced');
    expect(outcome.evidence.postFixReplay?.exitCode).toBe(0);
    expect(toggle.applied).toBe(1);
    expect(toggle.reverted).toBe(1);
  });

  it('REJECTS a failure that persists after the defect is removed', async () => {
    // The case nothing else catches: the test really fails, but for a reason that has
    // nothing to do with the reported bug. Output-matching cannot tell them apart.
    const outcome = await validateReproduction(
      request({
        replayer: new ScriptedReplayer(
          { exitCode: 1, output: 'AssertionError' }, // on base
          { exitCode: 1, output: 'AssertionError' }, // still failing without the bug
        ),
        defect: new RecordingToggle(),
      }),
    );

    expect(outcome.verdict).toBe('cannot-reproduce');
    expect(outcome.why).toMatch(/does not isolate the reported bug/);
  });

  it('restores the workspace even when the replay throws', async () => {
    // The workspace IS the evidence; leaving it patched would mislead every later
    // inspection of it.
    const toggle = new RecordingToggle();
    const exploding: Replayer = {
      calls: 0,
      async run(command: Argv): Promise<ReplayObservation> {
        this.calls = (this.calls as number) + 1;
        if ((this.calls as number) === 1) {
          return { command, exitCode: 1, output: 'AssertionError', durationMs: 1, timedOut: false };
        }
        throw new Error('replay exploded');
      },
    } as Replayer & { calls: number };

    await expect(
      validateReproduction(request({ replayer: exploding, defect: toggle })),
    ).rejects.toThrow('replay exploded');

    expect(toggle.applied).toBe(1);
    expect(toggle.reverted).toBe(1); // reverted despite the failure
  });

  it('records the check as unproven rather than passed when no fix is available', async () => {
    // Silently treating this as passed would be the single most misleading thing the
    // validator could do: it is exactly the gap that lets an unrelated failure through.
    const outcome = await validateReproduction(request());

    expect(outcome.verdict).toBe('reproduced');
    expect(outcome.why).toMatch(/differential check not available/);
    const differential = outcome.evidence.checks.find(
      (c) => c.step === 'differential-passes-after-fix',
    );
    expect(differential?.passed).toBe(false);
    expect(differential?.detail).toMatch(/no fix was available/);
  });
});

describe('the ladder runs cheapest checks first', () => {
  it('does not spawn anything when a cheap check already disqualifies the claim', async () => {
    // Ordering is load-bearing, not tidiness: replaying is by far the expensive step.
    const replayer = new ScriptedReplayer({ exitCode: 1 });
    await validateReproduction(request({ readArtifact: () => null, replayer }));
    expect(replayer.calls).toHaveLength(0);
  });

  it('records every check it performed, in order', async () => {
    const outcome = await validateReproduction(request());
    expect(outcome.evidence.checks.map((c) => c.step)).toEqual([
      'claim-structure',
      'artifacts-exist',
      'base-sha-matches',
      'artifacts-assert-something',
      'replay-fails-on-base',
      'failure-is-not-environmental',
      'differential-passes-after-fix',
    ]);
  });
});
