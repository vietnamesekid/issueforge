import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderInit, runInit } from './init.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-init-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const workflow = (): string =>
  readFileSync(join(dir, '.github', 'workflows', 'issueforge.yml'), 'utf8');

describe('init', () => {
  it('writes both files a repository needs', () => {
    const results = runInit(dir);
    expect(results.every((r) => r.written)).toBe(true);
    expect(workflow()).toContain('name: IssueForge');
    expect(readFileSync(join(dir, '.issueforge', 'config.json'), 'utf8')).toContain('claude-code');
  });

  it('generates a workflow with queue: max', () => {
    // The default (`single`) keeps only ONE pending run, so labelling a third issue
    // silently cancels the second — no error anywhere. This is the whole reason the
    // template exists rather than being left to a copy-paste from the README.
    expect(workflowOf(dir)).toContain('queue: max');
  });

  it('sets an explicit timeout, since the default is undocumented', () => {
    expect(workflowOf(dir)).toMatch(/timeout-minutes:\s*\d+/);
  });

  it('does not check out the repository in the runner workspace', () => {
    // IssueForge clones the pinned commit itself; checking out here would make the
    // runner's workspace the agent's workspace. The template mentions the omission in
    // a comment, so assert there is no `uses:` step rather than no mention at all.
    expect(workflowOf(dir)).not.toMatch(/^\s*-?\s*uses:\s*actions\/checkout/m);
  });

  it('explains why each fragile choice is there', () => {
    // Whoever edits this next will not have read the design notes.
    const text = workflowOf(dir);
    expect(text).toContain('silently cancels');
    expect(text).toContain('never becomes the agent');
  });

  it('refuses to overwrite an edited file', () => {
    mkdirSync(join(dir, '.issueforge'), { recursive: true });
    writeFileSync(join(dir, '.issueforge', 'config.json'), '{"mine":true}');

    const results = runInit(dir);
    const config = results.find((r) => r.path.endsWith('config.json'));
    expect(config?.written).toBe(false);
    expect(readFileSync(join(dir, '.issueforge', 'config.json'), 'utf8')).toContain('mine');
  });

  it('replaces when explicitly forced', () => {
    runInit(dir);
    writeFileSync(join(dir, '.issueforge', 'config.json'), '{"mine":true}');
    runInit(dir, true);
    expect(readFileSync(join(dir, '.issueforge', 'config.json'), 'utf8')).toContain('claude-code');
  });

  it('warns about running this on a public repository', () => {
    // A self-hosted runner executes on the user's machine, and anyone can write the
    // issue text an agent will read.
    expect(renderInit(runInit(dir))).toContain('private repository');
  });
});

function workflowOf(cwd: string): string {
  runInit(cwd);
  return readFileSync(join(cwd, '.github', 'workflows', 'issueforge.yml'), 'utf8');
}
