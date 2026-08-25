/**
 * Decides whether a run stayed inside the paths it was allowed to write.
 *
 * Pure, so the policy can be reasoned about without a filesystem — and because a
 * security check that can only be tested end to end tends not to be tested at all.
 *
 * A violation is a statement about the RUN, never about the bug. A harness that
 * rewrote `.github/` has misbehaved; reporting that as `cannot-reproduce` would tell
 * a maintainer something false about their code.
 */

/**
 * Paths blocked no matter what a configuration says.
 *
 * `.github/**` is how a run would rewrite the workflow that runs it. `.git/**` is how
 * it would rewrite the history the verifier depends on. Neither is a legitimate
 * target for a reproduce task, so neither is negotiable.
 */
export const ALWAYS_FORBIDDEN: readonly string[] = [
  '.github/**',
  '.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
];

export interface WriteBoundary {
  allowedPaths: readonly string[];
  forbiddenPaths?: readonly string[];
}

export interface BoundaryViolation {
  path: string;
  reason: 'forbidden' | 'not-allowed' | 'escapes-workspace';
}

/**
 * Check a change set against the boundary.
 *
 * Order matters: forbidden wins over allowed, so a configuration cannot accidentally
 * permit `.github/**` by listing a broad pattern like `**`.
 */
export function checkWriteBoundary(
  changedFiles: readonly string[],
  boundary: WriteBoundary,
): BoundaryViolation[] {
  const forbidden = [...ALWAYS_FORBIDDEN, ...(boundary.forbiddenPaths ?? [])];
  const violations: BoundaryViolation[] = [];

  for (const file of changedFiles) {
    const path = normalise(file);

    // A path that climbs out of the workspace is refused before any pattern is
    // consulted: no allow-list entry can make `../` legitimate.
    if (path.startsWith('../') || path.startsWith('/')) {
      violations.push({ path: file, reason: 'escapes-workspace' });
      continue;
    }

    if (forbidden.some((pattern) => matchesGlob(path, pattern))) {
      violations.push({ path: file, reason: 'forbidden' });
      continue;
    }

    if (!boundary.allowedPaths.some((pattern) => matchesGlob(path, pattern))) {
      violations.push({ path: file, reason: 'not-allowed' });
    }
  }

  return violations;
}

export function describeViolations(violations: readonly BoundaryViolation[]): string {
  const reason = {
    forbidden: 'writes to a forbidden path',
    'not-allowed': 'writes outside the allowed paths',
    'escapes-workspace': 'writes outside the workspace',
  } as const;

  return violations.map((v) => `${v.path} (${reason[v.reason]})`).join(', ');
}

/**
 * Match a path against a glob.
 *
 * Written explicitly rather than by converting the pattern into a regex with string
 * replacement. That conversion is where subtle holes live: a `.` or `+` in a path
 * silently becomes a metacharacter, and `*` matching a `/` turns `src/*` into a
 * boundary that does not hold. Supported: `**` (any depth, including none), `*` (one
 * segment), and literals.
 */
function matchesGlob(path: string, pattern: string): boolean {
  return matchSegments(path.split('/'), pattern.split('/'));
}

function matchSegments(path: readonly string[], pattern: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0;

  const [head, ...rest] = pattern;

  if (head === '**') {
    // `**` matches zero or more segments, so try every split point.
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(path.slice(i), rest)) return true;
    }
    return false;
  }

  if (path.length === 0) return false;

  const segment = path[0] as string;
  return matchSegment(segment, head as string) && matchSegments(path.slice(1), rest);
}

/** Match one path segment. `*` matches any run of characters within the segment. */
function matchSegment(segment: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return segment === pattern;

  const parts = pattern.split('*');
  let index = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part.length === 0) continue;

    if (i === 0) {
      if (!segment.startsWith(part)) return false;
      index = part.length;
      continue;
    }

    const found = segment.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }

  // A pattern not ending in `*` must consume the rest of the segment.
  const last = parts[parts.length - 1] as string;
  return last.length === 0 || segment.endsWith(last);
}

/** Strip `./` and collapse redundant separators, without resolving `..`. */
function normalise(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}
