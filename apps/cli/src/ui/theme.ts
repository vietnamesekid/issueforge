import type { RunStatus } from '@issueforge/contracts';

/**
 * Semantic colour roles, resolved once from whether the stream is a terminal.
 *
 * Two properties matter more than the palette:
 *
 *  - Call sites name a ROLE, never a colour. `theme.danger(text)`, not `red(text)`.
 *    That is what makes a palette change one edit rather than forty, and it is the
 *    same discipline `doctor.ts` already applies with its `Record<CheckLevel, string>`
 *    symbol table.
 *  - When colour is off every role is the identity function, so no renderer anywhere
 *    branches on `isTTY`. A renderer written against this theme emits byte-identical
 *    output under `--json`, in CI, and through a pipe.
 *
 * Written by hand rather than pulled from `picocolors`: it is eight escape wrappers,
 * and the CLI already keeps its runtime dependencies to four deliberately (see the
 * external list in tsup.config.ts).
 */

export type Style = (text: string) => string;

/**
 * The roles a renderer may use.
 *
 * Deliberately small. A role earns its place by meaning something a reader must act
 * on differently — not by being a colour someone wanted.
 */
export interface Theme {
  /** IssueForge's own voice: headings, the wordmark. */
  accent: Style;
  /** A conclusion that went well, or a check that passed. */
  success: Style;
  /** Something that needs attention but does not stop a run. */
  warning: Style;
  /** A blocking problem, or a run that failed. */
  danger: Style;
  /** Secondary text: paths, ids, timings, anything supporting. */
  dim: Style;
  /** Emphasis inside a sentence. */
  bold: Style;
  /** A value the user typed or must type — a command, a flag, a path. */
  code: Style;
}

const ESC = '\u001b';
const wrap =
  (open: string, close = '39'): Style =>
  (text) =>
    `${ESC}[${open}m${text}${ESC}[${close}m`;

const identity: Style = (text) => text;

/**
 * 256-colour codes, not the 16 basic ones.
 *
 * The basic palette is remapped by every terminal theme, so `31` is whatever red the
 * user's colour scheme decided on — including, on some popular themes, one that is
 * illegible on their background. These are fixed hues chosen to stay readable on both
 * light and dark grounds.
 */
const COLOURED: Theme = {
  accent: wrap('38;5;39'),
  success: wrap('38;5;71'),
  warning: wrap('38;5;179'),
  danger: wrap('38;5;167'),
  dim: wrap('2', '22'),
  bold: wrap('1', '22'),
  code: wrap('38;5;180'),
};

const PLAIN: Theme = {
  accent: identity,
  success: identity,
  warning: identity,
  danger: identity,
  dim: identity,
  bold: identity,
  code: identity,
};

export interface ThemeOptions {
  /** Overrides detection. `--no-color` and tests set this. */
  color?: boolean;
  /** The stream that will be written to. Defaults to stdout. */
  stream?: { isTTY?: boolean | undefined };
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide whether to colour, then build the theme.
 *
 * `NO_COLOR` and `FORCE_COLOR` are honoured because they are the conventions users
 * already have set — a tool that ignores them is a tool they have to configure twice.
 */
export function createTheme(options: ThemeOptions = {}): Theme {
  return useColor(options) ? COLOURED : PLAIN;
}

function useColor(options: ThemeOptions): boolean {
  if (options.color !== undefined) return options.color;

  const env = options.env ?? process.env;
  // Presence is the signal, per the NO_COLOR convention — any value means "no".
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true;
  // A CI log is not a terminal, and escape codes in it are noise a human later greps.
  if (env['CI'] !== undefined && env['CI'] !== '') return false;

  const stream = options.stream ?? process.stdout;
  return stream.isTTY === true;
}

/**
 * The glyph and colour a run status is shown with.
 *
 * A total `Record`, so a new `RunStatus` fails to compile rather than rendering
 * unstyled — the same reason `doctor.ts` keys its symbol table by `CheckLevel`.
 *
 * The groupings encode IssueForge's own rule that a negative finding is not an error:
 * `cannot-reproduce` and `could-not-fix` are conclusions the harness reached, so they
 * are neutral, not red. Red is reserved for IssueForge itself failing.
 */
export const STATUS_GLYPH: Record<RunStatus, string> = {
  queued: '·',
  running: '▶',
  reproduced: '✓',
  fixed: '✓',
  'cannot-reproduce': '○',
  'could-not-fix': '○',
  'needs-info': '?',
  interrupted: '✗',
  blocked: '■',
  cancelled: '─',
};

type Role = keyof Theme;

export const STATUS_ROLE: Record<RunStatus, Role> = {
  queued: 'dim',
  running: 'accent',
  reproduced: 'success',
  fixed: 'success',
  // A conclusion, not a failure — see the note above.
  'cannot-reproduce': 'dim',
  'could-not-fix': 'dim',
  'needs-info': 'warning',
  interrupted: 'danger',
  blocked: 'warning',
  cancelled: 'dim',
};

/** A status rendered as its glyph and name, in the colour its meaning earns. */
export function styleStatus(theme: Theme, status: RunStatus): string {
  return theme[STATUS_ROLE[status]](`${STATUS_GLYPH[status]} ${status}`);
}
