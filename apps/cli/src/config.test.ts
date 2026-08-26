import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from './config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'if-config-'));
  mkdirSync(join(dir, '.issueforge'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(contents: string, name = 'config.json'): void {
  writeFileSync(join(dir, '.issueforge', name), contents);
}

describe('loadConfig', () => {
  it('reads the file `init` actually writes', () => {
    // The bug this test exists for: `init` wrote config.json while the loader read
    // config.yaml, so every config anyone wrote was ignored in silence — including
    // maxBudgetUsd and forbiddenPaths, which flow into the task card.
    writeConfig(JSON.stringify({ harness: { maxBudgetUsd: 99 } }));

    expect(loadConfig(dir).harness.maxBudgetUsd).toBe(99);
  });

  it('applies every configured value, not just the first level', () => {
    writeConfig(
      JSON.stringify({
        harness: { maxTurns: 7, timeoutMs: 1234 },
        policy: { forbiddenPaths: ['secrets/**'] },
        retention: { days: 3 },
      }),
    );

    const config = loadConfig(dir);
    expect(config.harness.maxTurns).toBe(7);
    expect(config.harness.timeoutMs).toBe(1234);
    expect(config.policy.forbiddenPaths).toContain('secrets/**');
    expect(config.retention.days).toBe(3);
  });

  it('falls back to safe defaults when there is no config at all', () => {
    // The common case, and it must stay silent: a repository that never writes a
    // config is not misconfigured.
    const config = loadConfig(dir);
    expect(config.harness.maxBudgetUsd).toBe(2);
    expect(config.policy.forbiddenPaths.length).toBeGreaterThan(0);
  });

  it('REFUSES a malformed config rather than silently using defaults', () => {
    // The second half of the bug. Swallowing the error made a broken config
    // indistinguishable from an absent one, so a typo in maxBudgetUsd would run at
    // the default budget and nobody would ever be told.
    writeConfig('{ not valid json');

    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/config\.json/);
  });

  it('REFUSES a config that parses but violates the schema', () => {
    writeConfig(JSON.stringify({ harness: { maxTurns: 'lots' } }));

    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('names the offending file and the reason, so the fix is obvious', () => {
    writeConfig(JSON.stringify({ retention: { days: -1 } }));

    try {
      loadConfig(dir);
      expect.unreachable('a schema violation must not be silently accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('.issueforge/config.json');
      expect(message).toMatch(/retention|days/i);
    }
  });
});
