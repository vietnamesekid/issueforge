import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  JsonlWriter,
  createLogger,
  redact,
  redactValue,
  containsSecret,
  suppressSqliteExperimentalWarning,
} from './index.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-log-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('redaction', () => {
  it('catches the credential shapes that would actually leak', () => {
    const cases: [string, string][] = [
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'github-token'],
      ['key sk-ant-api03-abcdefghijklmnop', 'anthropic'],
      ['aws AKIAIOSFODNN7EXAMPLE here', 'aws'],
      ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'bearer'],
      ['xoxb-1234567890-abcdefghij', 'slack'],
    ];
    for (const [input] of cases) {
      expect(redact(input), input).toContain('[REDACTED]');
      expect(containsSecret(input)).toBe(true);
    }
  });

  it('is case-insensitive for assigned secrets', () => {
    // .env files conventionally use lowercase. An agent echoing `token=...` from a
    // config file leaks exactly as badly as `TOKEN=...`, so casing must not matter.
    for (const input of [
      'TOKEN=abcdef123456',
      'token=abcdef123456',
      'api_key=abcdef123456',
      'Token: abcdef123456',
      'password=hunter2000',
    ]) {
      expect(redact(input), input).toContain('[REDACTED]');
    }
  });

  it('catches npm, GitLab and JWT shapes', () => {
    for (const input of [
      'npm_abcdefghijklmnopqrstuvwxyz',
      'glpat-abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
    ]) {
      expect(redact(input), input).toContain('[REDACTED]');
    }
  });

  it('does not false-positive on ordinary prose containing hex', () => {
    const text = 'reproduced the bug in src/math.js at commit a1b2c3d';
    expect(redact(text)).toBe(text);
  });

  it('redacts assigned secrets but keeps the key visible for debugging', () => {
    const out = redact('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01');
    expect(out).toContain('GITHUB_TOKEN=');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz01');
  });

  it('redacts a private key block entirely', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(pem)).toBe('[REDACTED]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'reproduced the bug in src/math.js at commit a1b2c3d';
    expect(redact(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it('turns values JSON cannot represent into null instead of dropping them', () => {
    // JSON.stringify silently omits undefined/function/symbol properties. In a log
    // record that reads as "the field was never set" rather than "the value was not
    // loggable", so they become null and stay visible.
    const out = redactValue({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 }) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ a: null, b: null, c: null, d: 1 });
  });

  it('walks nested structures and preserves shape', () => {
    const out = redactValue({
      runId: 'run_abc123',
      env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz01' },
      events: ['ok', 'AKIAIOSFODNN7EXAMPLE'],
      count: 3,
      nested: null,
    });
    // Narrow once: redactValue returns JsonValue, because it builds a new value
    // rather than echoing the caller's type.
    const record = out as Record<string, unknown>;
    expect(record['runId']).toBe('run_abc123');      // keys and safe values intact
    expect(record['count']).toBe(3);                 // non-strings untouched
    expect(record['nested']).toBe(null);
    expect(JSON.stringify(out)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghij');
  });
});

describe('JsonlWriter', () => {
  it('appends records in order, one JSON object per line', () => {
    const p = join(dir, 'events.jsonl');
    const w = new JsonlWriter(p);
    for (let i = 0; i < 5; i++) w.write({ type: 'event', i });
    w.close();

    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);
  });

  it('writes nothing until flushed, so a crash cannot half-write a record', () => {
    const p = join(dir, 'events.jsonl');
    const w = new JsonlWriter(p);
    w.write({ a: 1 });
    expect(w.pending).toBe(1);
    expect(existsSync(p)).toBe(false); // file is not even created yet
    w.flush();
    expect(w.pending).toBe(0);
    expect(readFileSync(p, 'utf8')).toContain('"a":1');
  });

  it('flushes 1k buffered events well under the 100ms interrupt budget', () => {
    // The cancellation handler has ~7.5s total and must not gamble on I/O speed.
    const p = join(dir, 'events.jsonl');
    const w = new JsonlWriter(p, { flushAtBytes: Number.MAX_SAFE_INTEGER }); // force full buffering
    for (let i = 0; i < 1000; i++) w.write({ type: 'tool_started', i, name: 'Bash' });
    expect(w.pending).toBe(1000);

    const started = performance.now();
    w.flush();
    const elapsed = performance.now() - started;

    expect(readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(1000);
    expect(elapsed, `flush took ${elapsed.toFixed(1)}ms`).toBeLessThan(100);
    w.close();
  });

  it('redacts on the way in — an unredacted event on disk is already a leak', () => {
    const p = join(dir, 'events.jsonl');
    const w = new JsonlWriter(p);
    w.write({ type: 'text', text: 'here is ghp_abcdefghijklmnopqrstuvwxyz01' });
    w.close();
    const contents = readFileSync(p, 'utf8');
    expect(contents).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz01');
    expect(contents).toContain('[REDACTED]');
  });

  it('appends across writer instances rather than truncating', () => {
    // A resumed or retried run must not destroy the earlier transcript.
    const p = join(dir, 'events.jsonl');
    const a = new JsonlWriter(p); a.write({ n: 1 }); a.close();
    const b = new JsonlWriter(p); b.write({ n: 2 }); b.close();
    expect(readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('createLogger', () => {
  it('writes structured records to the given destination', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const log = createLogger({ destination: sink, base: { runId: 'run_abc123' } });

    log.info({ issue: 7 }, 'run started');

    const record = JSON.parse(chunks.join('')) as Record<string, unknown>;
    expect(record['msg']).toBe('run started');
    expect(record['runId']).toBe('run_abc123');
    expect(record['issue']).toBe(7);
  });

  it('redacts secrets in log records', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const log = createLogger({ destination: sink });

    log.info({ token: 'ghp_abcdefghijklmnopqrstuvwxyz01' }, 'auth');

    const out = chunks.join('');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz01');
    expect(out).toContain('[REDACTED]');
  });
});

describe('suppressSqliteExperimentalWarning', () => {
  it('silences only the SQLite notice and lets every other warning through', () => {
    // node:sqlite is a release candidate and warns on first use. A CLI must keep
    // stderr clean, but must not become deaf to warnings in general.
    const seen: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      seen.push(typeof w === 'string' ? w : w.message);
      void rest;
    });

    try {
      suppressSqliteExperimentalWarning();
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('Something else entirely', 'ExperimentalWarning');
      process.emitWarning('A plain warning');
    } finally {
      process.emitWarning = original;
    }

    expect(seen.some((m) => m.includes('SQLite'))).toBe(false);
    expect(seen).toContain('Something else entirely');
    expect(seen).toContain('A plain warning');
  });

  it('is idempotent — repeated calls do not chain wrappers', () => {
    // Called from the lazy sqlite loader, so it can run more than once. Each patch
    // would otherwise wrap the previous one, and every unrelated warning would be
    // forwarded through a growing chain.
    const seen: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((w: string | Error) => {
      seen.push(typeof w === 'string' ? w : w.message);
    });

    try {
      suppressSqliteExperimentalWarning();
      const afterFirst = process.emitWarning;
      suppressSqliteExperimentalWarning();
      suppressSqliteExperimentalWarning();
      expect(process.emitWarning).toBe(afterFirst);

      process.emitWarning('still delivered once');
      expect(seen.filter((m) => m === 'still delivered once')).toHaveLength(1);
    } finally {
      process.emitWarning = original;
    }
  });
});
