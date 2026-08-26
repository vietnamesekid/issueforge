import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueForgeConfig } from '@issueforge/contracts';
import { renderInit, runInit } from './init.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-init-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const workflow = (): string =>
  readFileSync(join(dir, '.github', 'workflows', 'issueforge.yml'), 'utf8');

describe('init', () => {
  it('generates a config the loader actually accepts', () => {
    // Caught for real: an escaped quote inside the template literal produced invalid
    // JSON, so `init` wrote a config that every later command rejected. The template is
    // a string in a .ts file, which means nothing typechecks its contents.
    runInit(dir);
    const raw = readFileSync(join(dir, '.issueforge', 'config.json'), 'utf8');

    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect(() => IssueForgeConfig.parse(JSON.parse(raw))).not.toThrow();
  });

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

describe('next steps', () => {
  it('offers the no-runner path before the one that needs a runner', () => {
    // The bug this test exists for: `init` sent every new user straight to
    // "register a self-hosted runner" — eight manual commands and repository admin
    // rights — without mentioning that `issueforge run` already works locally with
    // none of it. Most people who bounce, bounce there.
    const text = renderInit(runInit(dir));

    const local = text.indexOf('issueforge run reproduce');
    const runner = text.indexOf('self-hosted runner');

    expect(local, 'init never mentions the local run').toBeGreaterThan(-1);
    expect(local).toBeLessThan(runner);
  });
});
