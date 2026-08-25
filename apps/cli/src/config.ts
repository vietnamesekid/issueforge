import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IssueForgeConfig } from '@issueforge/contracts';
import { IssueForgeConfig as ConfigSchema } from '@issueforge/contracts';

/**
 * Loads `.issueforge/config.yaml`, or the safe defaults when it is absent.
 *
 * An empty or missing config must be safe rather than merely valid — the defaults are
 * the ones that matter (isolated harness, draft PRs only, a seven-variable env
 * allowlist), so a repository that never writes a config still gets them.
 */
export function loadConfig(cwd: string = process.cwd()): IssueForgeConfig {
  const path = join(cwd, '.issueforge', 'config.yaml');
  if (!existsSync(path)) return ConfigSchema.parse({});

  // JSON is a subset of YAML, and v0.1 accepts only what it can parse without a
  // dependency. A YAML parser arrives when a config actually needs YAML-only syntax.
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return ConfigSchema.parse({});
  }
}
