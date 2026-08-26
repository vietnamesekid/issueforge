import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IssueForgeConfig } from '@issueforge/contracts';
import { IssueForgeConfig as ConfigSchema } from '@issueforge/contracts';

/** The config file exists but cannot be used. */
export class ConfigError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} could not be read: ${reason}`);
    this.name = 'ConfigError';
  }
}

/** Written by `issueforge init`. The two must never disagree again. */
const CONFIG_FILE = 'config.json';

/**
 * Loads `.issueforge/config.json`, or the safe defaults when it is absent.
 *
 * Absent is fine and stays silent: a repository that never writes a config is not
 * misconfigured, and the defaults are the ones that matter.
 *
 * Present but broken is NOT fine. An earlier version read `config.yaml` while `init`
 * wrote `config.json`, and swallowed parse errors on top — so every config anyone
 * wrote was ignored without a word, and a typo was indistinguishable from a missing
 * file. `maxBudgetUsd`, `maxTurns`, `timeoutMs` and `forbiddenPaths` all reach the
 * harness through this, which made silence the most expensive possible behaviour.
 */
export function loadConfig(cwd: string = process.cwd()): IssueForgeConfig {
  const path = join(cwd, '.issueforge', CONFIG_FILE);
  if (!existsSync(path)) return ConfigSchema.parse({});

  const relative = join('.issueforge', CONFIG_FILE);

  let raw: unknown;
  try {
    // JSON is a subset of YAML, so a YAML parser can arrive later without breaking
    // any file written today.
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(relative, error instanceof Error ? error.message : 'invalid JSON');
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.error) {
    throw new ConfigError(relative, describeIssues(parsed.error));
  }

  return parsed.data;
}

/** Zod's default rendering is a stack of JSON; this names the fields a human must fix. */
function describeIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.map(String).join('.');
      return field ? `${field} — ${issue.message}` : issue.message;
    })
    .join('; ');
}
