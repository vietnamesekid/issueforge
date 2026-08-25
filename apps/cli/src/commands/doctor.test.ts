import { describe, it, expect } from 'vitest';
import { hasBlockingProblem, renderDoctor, runDoctor, type CheckResult } from './doctor.js';

describe('doctor', () => {
  it('checks everything a run depends on', () => {
    const names = runDoctor().map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['node', 'git', 'gh', 'gh auth', 'claude', 'harness auth', 'home']),
    );
  });

  it('accepts an existing interactive login instead of demanding an API key', () => {
    // Reusing the Claude Code installation and authentication a developer already
    // has is the point of the product. Demanding a separate key from someone already
    // signed in would break that promise and cost them twice.
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const auth = runDoctor().find((r) => r.name === 'harness auth');
      // On a machine with Claude Code signed in this passes; on one without, it
      // blocks with a fix naming both routes.
      if (auth?.level === 'blocked') {
        expect(auth.fix).toMatch(/sign in|ANTHROPIC_API_KEY/);
      } else {
        expect(auth?.detail).toMatch(/signed in/);
      }
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('never prints the key itself, only whether one is present', () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret-value';
    try {
      const rendered = renderDoctor(runDoctor());
      expect(rendered).not.toContain('sk-ant-secret-value');
      expect(rendered).toContain('ANTHROPIC_API_KEY is set');
    } finally {
      if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('gives every failure an actionable fix', () => {
    // A check that reports a fault without a remedy just moves the puzzle.
    for (const result of runDoctor()) {
      if (result.level === 'blocked') expect(result.fix, result.name).toBeTruthy();
    }
  });

  it('reports a blocking problem so a setup script can branch on it', () => {
    const blocked: CheckResult[] = [{ name: 'x', level: 'blocked', detail: 'broken', fix: 'fix it' }];
    expect(hasBlockingProblem(blocked)).toBe(true);
    expect(hasBlockingProblem([{ name: 'x', level: 'ok', detail: 'fine' }])).toBe(false);
  });

  it('says what to do next when everything passes', () => {
    const rendered = renderDoctor([{ name: 'x', level: 'ok', detail: 'fine' }]);
    expect(rendered).toContain('Ready.');
    expect(rendered).toContain('issueforge run reproduce');
  });
});
