import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotOurLabelError, parseEventFile } from './handle-github-event.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-evt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeEvent(payload: unknown): string {
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: 'labeled',
  issue: { number: 7, title: 'bug', body: 'it breaks', labels: [] },
  label: { name: 'issueforge:reproduce' },
  repository: { full_name: 'owner/repo', default_branch: 'main' },
  sender: { login: 'maintainer' },
  ...overrides,
});

describe('parseEventFile', () => {
  it('reads the fields a run needs from a real payload shape', () => {
    const event = parseEventFile(writeEvent(payload()));

    expect(event.repo).toBe('owner/repo');
    expect(event.issueNumber).toBe(7);
    expect(event.intent).toBe('reproduce');
    expect(event.actor).toBe('maintainer');
    expect(event.defaultBranch).toBe('main');
  });

  it('carries attacker-authored text through verbatim', () => {
    // The defence is that this never reaches a command line, not that it is mangled
    // here — sanitising would only make the reproduction harder to read.
    const hostile = '$(touch /tmp/pwned) `id`; rm -rf /';
    const event = parseEventFile(
      writeEvent(payload({ issue: { number: 7, title: hostile, body: hostile, labels: [] } })),
    );

    expect(event.issue.title).toBe(hostile);
    expect(event.issue.body).toBe(hostile);
  });

  it('treats a label that is not ours as nothing to do', () => {
    // Repositories label issues for all sorts of reasons; being triggered is not the
    // same as being addressed.
    expect(() => parseEventFile(writeEvent(payload({ label: { name: 'bug' } })))).toThrow(
      NotOurLabelError,
    );
  });

  it('tolerates a null body, which GitHub sends for an empty one', () => {
    const event = parseEventFile(
      writeEvent(payload({ issue: { number: 7, title: 't', body: null, labels: [] } })),
    );
    expect(event.issue.body).toBe('');
  });

  it('tolerates unknown fields, since GitHub adds them over time', () => {
    const event = parseEventFile(writeEvent({ ...payload(), unexpected_new_field: true }));
    expect(event.issueNumber).toBe(7);
  });

  it('rejects a payload for a different action', () => {
    expect(() => parseEventFile(writeEvent(payload({ action: 'opened' })))).toThrow();
  });
});
