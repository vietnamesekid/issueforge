import type { IssueForgeConfig } from '@issueforge/contracts';

/**
 * The environment a spawned harness receives.
 *
 * An ALLOWLIST, never a denylist. A naively spawned child inherits everything — 82
 * variables on the validation machine — and a denylist only excludes the leaks you
 * thought of. Seven variables are enough to run git, and none of them carry a
 * credential.
 *
 * This is the primary control behind "no GITHUB_TOKEN in the harness environment":
 * the token is not withheld from the child, it is never there to begin with.
 */

/** Variables a child needs to locate tools, a home directory and a temp dir. */
export const DEFAULT_ALLOWED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TERM',
];

/** Names that must never be forwarded, whatever an allowlist says. */
const CREDENTIAL_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

export interface EnvironmentOptions {
  /** Overrides `DEFAULT_ALLOWED_ENV`; usually `config.env.allow`. */
  allow?: readonly string[];
  /** Extra variables the caller supplies deliberately, e.g. an API key for a harness. */
  extra?: Readonly<Record<string, string>>;
}

/**
 * Build a child environment from the allowlist.
 *
 * `extra` bypasses the credential check by design: a harness may legitimately need
 * `ANTHROPIC_API_KEY`, and that decision belongs to the caller who names it, not to
 * a pattern match. What the check does prevent is a credential arriving *implicitly*
 * because someone widened the allowlist without noticing what it now admits.
 */
export function buildChildEnvironment(options: EnvironmentOptions = {}): Record<string, string> {
  const allow = options.allow ?? DEFAULT_ALLOWED_ENV;
  const env: Record<string, string> = {};

  for (const name of allow) {
    if (CREDENTIAL_PATTERN.test(name)) continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...options.extra };
}

/** Convenience for callers that already hold a parsed config. */
export function environmentFromConfig(
  config: Pick<IssueForgeConfig, 'env'>,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return buildChildEnvironment({
    allow: config.env.allow,
    ...(extra ? { extra } : {}),
  });
}
