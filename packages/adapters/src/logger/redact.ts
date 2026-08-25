export const REDACTED = '[REDACTED]';

/**
 * Redaction for anything written to a log, a JSONL event or a GitHub comment.
 *
 * IssueForge streams harness output that has touched a developer's machine, and it
 * echoes some of that back to GitHub. A token appearing in a status comment would be
 * an irreversible leak, so redaction runs on the way out rather than being trusted to
 * never be necessary.
 *
 * This is defence in depth, NOT the primary control: the primary control is that
 * credentials are never in the harness environment in the first place (a 7-variable
 * allowlist). Treat a redaction hit as a signal that something upstream is wrong.
 */

/**
 * One credential shape to catch.
 *
 * `replace` lets a pattern decide what survives redaction. Most shapes are replaced
 * wholesale; an assignment keeps its key, because `GITHUB_TOKEN=[REDACTED]` still
 * tells a reader which credential was involved while leaking none of it. Carrying
 * that with the pattern avoids a name check inside the replace loop, which would
 * grow a branch for every future pattern that needs different handling.
 */
interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
  readonly replace?: (...groups: string[]) => string;
}

/** Credential shapes worth catching. Ordered longest-first where they overlap. */
const PATTERNS: readonly SecretPattern[] = [
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_/ghs_/ghr_ (app tokens)
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'github-pat-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer-header', re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/g },
  // JSON Web Tokens — three base64url segments.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  // KEY=value / KEY: value in env dumps and config echoes.
  // Case-INSENSITIVE: .env files conventionally use lowercase, and an agent echoing
  // `token=...` from a config file leaks exactly as badly as `TOKEN=...`.
  {
    name: 'assigned-secret',
    re: /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|apikey|api_key|auth)[A-Za-z0-9_]*)\s*[:=]\s*("?)([^\s"']{6,})\2/gi,
    // Keep the key and the quoting; redact only the value.
    replace: (_match, key, quote) => `${key}=${quote}${REDACTED}${quote}`,
  },
];

/** Replace credential-shaped substrings. Returns the text unchanged when nothing matches. */
export function redact(input: string): string {
  return PATTERNS.reduce((text, { re, replace }) => {
    // Patterns are module-level and /g, so lastIndex survives between calls.
    re.lastIndex = 0;
    return replace ? text.replace(re, replace) : text.replace(re, REDACTED);
  }, input);
}

/** True when redaction would change the text — useful as a policy signal. */
export function containsSecret(input: string): boolean {
  return redact(input) !== input;
}

/** Anything that survives `JSON.stringify` — what a log record or JSONL event is. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Redact recursively through a JSON-serialisable value.
 *
 * Object KEYS are preserved and only string values are rewritten, so a redacted
 * record keeps its shape and stays machine-readable.
 *
 * Takes `unknown` and returns `JsonValue`. A generic `<T>(value: T) => T` would claim
 * the result has the caller's exact type, which is false — this builds a new value —
 * and buying that false claim costs a cast at every branch. Callers serialise the
 * result, so `JsonValue` is both honest and what they need.
 */
export function redactValue(value: unknown): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, redactValue(v)]),
    );
  }
  // Numbers, booleans and null pass through. Anything else (undefined, a function,
  // a symbol) is not representable in a log record, and JSON.stringify would drop it
  // anyway — so it becomes null rather than silently vanishing mid-object.
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}
