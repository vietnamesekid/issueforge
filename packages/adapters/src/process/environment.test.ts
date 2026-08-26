import { describe, it, expect, afterEach } from 'vitest';
import {
  buildChildEnvironment,
  environmentFromConfig,
  DEFAULT_ALLOWED_ENV,
} from './environment.js';

/**
 * The allowlist is a security invariant, not a convenience: "the child env is an
 * allowlist (~7 vars), never a denylist". A naively spawned child inherits 82
 * variables on the validation machine, and issue text reaches a harness that runs
 * with whatever this function returns.
 */
const injected: string[] = [];

function setEnv(name: string, value: string): void {
  process.env[name] = value;
  injected.push(name);
}

afterEach(() => {
  // Reflect.deleteProperty rather than `delete process.env[name]`: no-dynamic-delete
  // is on. Assigning undefined is NOT equivalent — it leaves the literal string
  // "undefined" in the environment, which would leak into the next test and make
  // "this variable is unset" untestable.
  for (const name of injected.splice(0)) Reflect.deleteProperty(process.env, name);
});

describe('buildChildEnvironment', () => {
  it('passes through only what the allowlist names', () => {
    setEnv('GITHUB_TOKEN', 'ghp_secret');
    setEnv('AWS_SECRET_ACCESS_KEY', 'aws_secret');
    setEnv('SOME_UNRELATED_VAR', 'noise');

    const env = buildChildEnvironment();

    for (const name of Object.keys(env)) {
      expect(DEFAULT_ALLOWED_ENV).toContain(name);
    }
  });

  it('does not forward a credential the ambient environment happens to hold', () => {
    // The primary control behind "no GITHUB_TOKEN in the harness environment": the
    // token is not withheld from the child, it is never there to begin with.
    setEnv('GITHUB_TOKEN', 'ghp_secret');
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');

    const env = buildChildEnvironment();

    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(Object.values(env)).not.toContain('ghp_secret');
  });

  it('refuses a credential-shaped name even when the allowlist asks for it', () => {
    // The case this exists for: someone widens `env.allow` in config without
    // noticing what it now admits. An allowlist entry is not consent to leak a
    // token — the caller must name it through `extra` instead.
    setEnv('GITHUB_TOKEN', 'ghp_secret');
    setEnv('MY_PASSWORD', 'hunter2');
    setEnv('SESSION_SECRET', 'shh');
    setEnv('SSH_KEY', 'private');
    setEnv('DB_CREDENTIAL', 'creds');

    const env = buildChildEnvironment({
      allow: ['GITHUB_TOKEN', 'MY_PASSWORD', 'SESSION_SECRET', 'SSH_KEY', 'DB_CREDENTIAL', 'PATH'],
    });

    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('matches credential names case-insensitively', () => {
    setEnv('github_token', 'lowercase_secret');
    setEnv('Api_Key', 'mixed_secret');

    const env = buildChildEnvironment({ allow: ['github_token', 'Api_Key'] });

    expect(env).toEqual({});
  });

  it('omits an allowlisted variable that is not set, rather than passing undefined', () => {
    // `Record<string, string>` is a lie if an unset variable becomes the string
    // "undefined" in the child.
    const env = buildChildEnvironment({ allow: ['DEFINITELY_NOT_SET_12345'] });

    expect(env).toEqual({});
    expect(Object.keys(env)).not.toContain('DEFINITELY_NOT_SET_12345');
  });

  it('lets the caller pass a credential DELIBERATELY through extra', () => {
    // By design: a harness may legitimately need ANTHROPIC_API_KEY, and that
    // decision belongs to the caller who names it, not to a pattern match.
    const env = buildChildEnvironment({ extra: { ANTHROPIC_API_KEY: 'sk-ant-explicit' } });

    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-explicit');
  });

  it('lets extra win over an allowlisted variable of the same name', () => {
    setEnv('TMPDIR', '/ambient/tmp');

    const env = buildChildEnvironment({ extra: { TMPDIR: '/run/workspace' } });

    expect(env['TMPDIR']).toBe('/run/workspace');
  });

  it('returns an empty environment for an empty allowlist', () => {
    // Not a fallback to `process.env`: an empty allowlist means exactly nothing.
    setEnv('GITHUB_TOKEN', 'ghp_secret');

    expect(buildChildEnvironment({ allow: [] })).toEqual({});
  });

  it('does not mutate process.env', () => {
    const before = { ...process.env };
    buildChildEnvironment({ extra: { INJECTED_BY_TEST: 'x' } });

    expect(process.env['INJECTED_BY_TEST']).toBeUndefined();
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
  });
});

describe('environmentFromConfig', () => {
  it('uses the allowlist from config rather than the default', () => {
    setEnv('CONFIG_ONLY_VAR', 'from-config');
    setEnv('HOME_SHOULD_NOT_LEAK', 'x');

    const env = environmentFromConfig({ env: { allow: ['CONFIG_ONLY_VAR'] } });

    expect(env).toEqual({ CONFIG_ONLY_VAR: 'from-config' });
  });

  it('still refuses credentials named by a config allowlist', () => {
    // Config is a file a repository can carry; it must not be able to widen its way
    // into the harness environment.
    setEnv('CONFIG_TOKEN', 'leaked');

    expect(environmentFromConfig({ env: { allow: ['CONFIG_TOKEN'] } })).toEqual({});
  });

  it('forwards extra when given', () => {
    const env = environmentFromConfig({ env: { allow: [] } }, { ANTHROPIC_API_KEY: 'sk-ant' });

    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant');
  });
});
