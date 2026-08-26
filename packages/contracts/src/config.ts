import { z } from 'zod';
import { HarnessName } from './common.js';

/**
 * `.issueforge/config.yaml`. Every field has a safe default; an empty file is valid.
 *
 * Nested objects use `.prefault({})`, not `.default({})`. In Zod 4 a default value is
 * returned as-is without being parsed, so `.default({})` on a nested object yields a
 * literal `{}` and silently drops every inner default — which here would mean an empty
 * config produced no forbidden paths and no env allowlist. `.prefault` runs the value
 * through the schema, so the safe defaults actually apply. Covered by a test.
 */
export const IssueForgeConfig = z.object({
  harness: z
    .object({
      preferred: HarnessName.default('claude-code'),
      maxBudgetUsd: z.number().positive().default(2),
      maxTurns: z.number().int().positive().default(30),
      timeoutMs: z.number().int().positive().default(1_800_000),
    })
    .prefault({}),
  policy: z
    .object({
      /**
       * Reserved. The reproduce card sets `['**']` unconditionally: which files the
       * work needs is the harness's decision, and the control that matters is
       * `forbiddenPaths`, which is enforced by the post-run audit.
       */
      allowedPaths: z.array(z.string().min(1)).default(['**']),
      /** Always blocked in addition to whatever is configured here. */
      forbiddenPaths: z
        .array(z.string().min(1))
        .default(['.github/**', '.git/**', '**/.env', '**/*.pem', '**/id_rsa*']),
      /** Draft PRs only; human review and merge stay mandatory. */
      draftPrOnly: z.literal(true).default(true),
    })
    .prefault({}),
  retention: z.object({ days: z.number().int().positive().default(14) }).prefault({}),
  /**
   * Environment variables passed to a harness. An ALLOWLIST, never a denylist:
   * a naively spawned child inherits everything (82 variables on the validation
   * machine), and these seven are enough to run git with no credentials present.
   */
  env: z
    .object({
      allow: z
        .array(z.string().min(1))
        .default(['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR', 'TERM']),
    })
    .prefault({}),
});

export type IssueForgeConfig = z.infer<typeof IssueForgeConfig>;
