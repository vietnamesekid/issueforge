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

/** Patterns for credential shapes worth catching. Ordered longest-first where they overlap. */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_/ghs_/ghr_ (app tokens)
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'github-pat-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer-header', re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/g },
  // KEY=value / SECRET: value in env dumps and config echoes
  { name: 'assigned-secret', re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY)[A-Z0-9_]*)\s*[:=]\s*("?)([^\s"']{6,})\2/g },
];

export const REDACTED = '[REDACTED]';

/** Replace credential-shaped substrings. Returns the text unchanged when nothing matches. */
export function redact(input: string): string {
  let out = input;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    out =
      name === 'assigned-secret'
        ? out.replace(re, (_m, key: string, quote: string) => `${key}=${quote}${REDACTED}${quote}`)
        : out.replace(re, REDACTED);
  }
  return out;
}

/** True when redaction would change the text — useful as a policy signal. */
export function containsSecret(input: string): boolean {
  return redact(input) !== input;
}

/**
 * Redact recursively through a JSON-serialisable value.
 * Object KEYS are preserved; only string values are rewritten, so a redacted record
 * stays the same shape and remains machine-readable.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
