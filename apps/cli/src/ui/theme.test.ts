import { describe, expect, it } from 'vitest';
import { RunStatus } from '@issueforge/contracts';
import { createTheme, STATUS_GLYPH, STATUS_ROLE, styleStatus, type Theme } from './theme.js';

const ROLES: readonly (keyof Theme)[] = [
  'accent',
  'success',
  'warning',
  'danger',
  'dim',
  'bold',
  'code',
];

describe('createTheme', () => {
  it('makes EVERY role the identity function when colour is off', () => {
    // This is the load-bearing property of the whole UI layer: no renderer branches
    // on isTTY, so a renderer written against the theme emits byte-identical output
    // through a pipe, in CI, and under --json. If one role ever styled unconditionally
    // it would corrupt exactly those paths, and only there.
    const theme = createTheme({ color: false });
    for (const role of ROLES) {
      expect(theme[role]('text')).toBe('text');
    }
  });

  it('styles every role when colour is on', () => {
    const theme = createTheme({ color: true });
    for (const role of ROLES) {
      expect(theme[role]('text')).not.toBe('text');
      expect(theme[role]('text')).toContain('text');
    }
  });

  it('colours when the stream is a TTY and not when it is not', () => {
    expect(createTheme({ stream: { isTTY: true }, env: {} }).accent('x')).not.toBe('x');
    expect(createTheme({ stream: { isTTY: false }, env: {} }).accent('x')).toBe('x');
  });

  it('honours NO_COLOR even on a TTY', () => {
    // A convention users already have set; ignoring it means configuring twice.
    const theme = createTheme({ stream: { isTTY: true }, env: { NO_COLOR: '1' } });
    expect(theme.accent('x')).toBe('x');
  });

  it('honours FORCE_COLOR even when not a TTY', () => {
    const theme = createTheme({ stream: { isTTY: false }, env: { FORCE_COLOR: '1' } });
    expect(theme.accent('x')).not.toBe('x');
  });

  it('does not colour in CI, where escapes are noise a human later greps', () => {
    const theme = createTheme({ stream: { isTTY: true }, env: { CI: 'true' } });
    expect(theme.accent('x')).toBe('x');
  });

  it('lets an explicit choice beat every environment signal', () => {
    // `--no-color` must win over FORCE_COLOR, and `--color` over CI.
    expect(createTheme({ color: false, env: { FORCE_COLOR: '1' } }).accent('x')).toBe('x');
    expect(createTheme({ color: true, env: { CI: 'true' } }).accent('x')).not.toBe('x');
  });
});

describe('status styling', () => {
  it('assigns a glyph and a role to EVERY status — none may render unstyled', () => {
    // Both tables are total Records, so this cannot fail without the compiler failing
    // first. It is here because the compiler only guards the table, not the enum: this
    // asserts the two agree at runtime, which is what a new RunStatus would break.
    for (const status of RunStatus.options) {
      expect(STATUS_GLYPH[status]).toBeDefined();
      expect(STATUS_ROLE[status]).toBeDefined();
    }
  });

  it('does not paint a negative finding red', () => {
    // IssueForge's own rule: a negative finding is not an error. `cannot-reproduce`
    // and `could-not-fix` are conclusions the harness reached and exit 0; showing them
    // in the failure colour would train maintainers to read a working run as broken.
    expect(STATUS_ROLE['cannot-reproduce']).not.toBe('danger');
    expect(STATUS_ROLE['could-not-fix']).not.toBe('danger');
  });

  it('reserves danger for IssueForge itself failing', () => {
    expect(STATUS_ROLE.interrupted).toBe('danger');
  });

  it('renders the status name alongside its glyph, so plain output stays greppable', () => {
    const plain = createTheme({ color: false });
    expect(styleStatus(plain, 'reproduced')).toBe('✓ reproduced');
  });
});
