import { describe, it, expect } from 'vitest';
import type { Sha, ValidationOutcome } from '@issueforge/contracts';
import {
  ALL_STATUS_LABELS,
  COMMENT_MARKER,
  renderStatusComment,
  statusLabelFor,
} from './status-report.js';

const BASE = 'a'.repeat(40) as Sha;

const validation = (overrides: Partial<ValidationOutcome> = {}): ValidationOutcome => ({
  verdict: 'reproduced',
  why: 'independent replay observed the claimed failure',
  evidence: {
    baseSha: BASE,
    changedFiles: ['test/repro.test.js'],
    checks: [
      { step: 'replay-fails-on-base', passed: true, detail: 'exit 1' },
      { step: 'differential-passes-after-fix', passed: true, detail: '' },
    ],
  },
  ...overrides,
});

describe('status labels', () => {
  it('maps every run status to a label', () => {
    expect(statusLabelFor('reproduced')).toBe('issueforge:reproduced');
    expect(statusLabelFor('blocked')).toBe('issueforge:blocked');
  });

  it('reports an interrupted run as needing information, not as a finding', () => {
    // "Interrupted" says nothing about the bug, so it must not imply one.
    expect(statusLabelFor('interrupted')).toBe('issueforge:needs-info');
  });

  it('exposes the full set so stale labels can be removed', () => {
    expect(ALL_STATUS_LABELS).toContain('issueforge:reproduced');
    expect(new Set(ALL_STATUS_LABELS).size).toBe(ALL_STATUS_LABELS.length);
  });
});

describe('renderStatusComment', () => {
  it('carries the marker so the comment can be updated rather than duplicated', () => {
    expect(renderStatusComment({ runId: 'run_a1', status: 'reproduced', detail: '' })).toContain(
      COMMENT_MARKER,
    );
  });

  it('reports the VALIDATED verdict, never the harness claim', () => {
    // The whole product is that a claim can be rejected. A rejected claim must not
    // read as though it had been accepted.
    const body = renderStatusComment({
      runId: 'run_a1',
      status: 'cannot-reproduce',
      detail: 'harness claims: reproduced',
      validation: validation({
        verdict: 'cannot-reproduce',
        why: 'the reproduction command PASSED on the pinned base commit',
      }),
    });

    expect(body).toContain('Could not reproduce');
    expect(body).toContain('PASSED on the pinned base commit');
    expect(body).not.toContain('harness claims: reproduced');
  });

  it('shows the checks, so the verdict can be argued with', () => {
    // A verdict nobody can inspect is just another claim.
    const body = renderStatusComment({
      runId: 'run_a1',
      status: 'reproduced',
      detail: '',
      validation: validation(),
    });

    expect(body).toContain('Checks performed');
    expect(body).toContain('replay-fails-on-base');
    expect(body).toContain('differential-passes-after-fix');
  });

  it('marks a failed check distinctly from a passed one', () => {
    const body = renderStatusComment({
      runId: 'run_a1',
      status: 'reproduced',
      detail: '',
      validation: validation({
        evidence: {
          baseSha: BASE,
          changedFiles: [],
          checks: [
            { step: 'replay-fails-on-base', passed: true, detail: '' },
            {
              step: 'differential-passes-after-fix',
              passed: false,
              detail: 'not checked — no fix was available',
            },
          ],
        },
      }),
    });

    expect(body).toContain('❌');
    expect(body).toContain('no fix was available');
  });

  it('says a blocked run concluded nothing', () => {
    // A wrong sandbox is not a finding about the bug.
    const body = renderStatusComment({
      runId: 'run_a1',
      status: 'blocked',
      detail: 'harness started with MCP servers enabled',
    });

    expect(body).toContain('Blocked');
    expect(body).toContain('nothing was concluded');
  });

  it('warns when the issue text tried to instruct the agent', () => {
    const body = renderStatusComment({
      runId: 'run_a1',
      status: 'cannot-reproduce',
      detail: '',
      injectionSuspected: true,
    });

    expect(body).toContain('instructions aimed at the agent');
    expect(body).toContain('treated as data');
  });

  it('keeps local detail local', () => {
    // Transcripts, paths and environment stay on the machine by design.
    const body = renderStatusComment({
      runId: 'run_a1',
      status: 'reproduced',
      detail: '',
      validation: validation(),
      costUsd: 0.42,
    });

    expect(body).toContain('run `run_a1`');
    expect(body).toContain('evidence kept locally');
    expect(body).toContain('$0.42');
    expect(body).not.toMatch(/\/(?:Users|home|var|tmp)\//);
  });
});
