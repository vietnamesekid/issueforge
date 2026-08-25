import { describe, it, expect } from 'vitest';
import { hasBlockingProblem, renderDoctor, runDoctor, type CheckResult } from './doctor.js';

describe('doctor', () => {
  it('checks everything a run depends on', () => {
    const names = runDoctor().map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['node', 'git', 'gh', 'gh auth', 'claude', 'api key', 'home']),
    );
  });

  it('treats a missing ANTHROPIC_API_KEY as blocking, not a warning', () => {
    // --bare never reads an interactive login, so a logged-in developer still needs
    // the key. Without a blocking check they discover that when a run stalls.
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const key = runDoctor().find((r) => r.name === 'api key');
      expect(key?.level).toBe('blocked');
      expect(key?.fix).toMatch(/--bare/);
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
