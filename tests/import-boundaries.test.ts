/**
 * Enforces the dependency direction from project_brief.md §13:
 *
 *   contracts  ->  core  ->  adapters  ->  apps/cli
 *    (no deps)    (pure)     (io only)     (wiring)
 *
 * This is the one piece of architecture worth enforcing mechanically: it is what
 * stops IssueForge drifting into a coding-agent framework. A violation must fail CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(p);
      } else if (entry.endsWith('.ts')) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** Module specifiers of every static/dynamic import and re-export in a file. */
function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) specs.push(m[1]);
  }
  return specs;
}

describe('dependency direction', () => {
  it('contracts depends on nothing in the workspace', () => {
    const bad: string[] = [];
    for (const f of sourceFiles(join(ROOT, 'packages/contracts/src'))) {
      for (const spec of imports(f)) {
        if (spec.startsWith('@issueforge/')) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad, `contracts must be dependency-free:\n${bad.join('\n')}`).toEqual([]);
  });

  it('core imports ONLY contracts — no io, no adapters, no cli', () => {
    // core must stay pure so the domain is testable without a filesystem, a database,
    // a network, or a child process.
    const forbidden = [
      '@issueforge/adapters',
      'issueforge',
      'execa',
      'node:sqlite',
      'node:fs',
      'node:child_process',
      'node:net',
      'node:http',
      'fs',
      'child_process',
    ];
    const bad: string[] = [];
    for (const f of sourceFiles(join(ROOT, 'packages/core/src'))) {
      for (const spec of imports(f)) {
        if (forbidden.includes(spec) || spec.startsWith('node:fs/')) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad, `core must stay pure:\n${bad.join('\n')}`).toEqual([]);
  });

  it('nothing imports the CLI', () => {
    const bad: string[] = [];
    for (const dir of ['packages/contracts/src', 'packages/core/src', 'packages/adapters/src']) {
      for (const f of sourceFiles(join(ROOT, dir))) {
        for (const spec of imports(f)) {
          if (spec === 'issueforge' || spec.includes('apps/cli')) bad.push(`${f}: ${spec}`);
        }
      }
    }
    expect(bad, `the CLI is a composition root; nothing may import it:\n${bad.join('\n')}`).toEqual([]);
  });

  it('harness adapters do not import the GitHub adapter, and vice versa', () => {
    // Keeps GitHub integration ignorant of harness details and harnesses ignorant
    // that GitHub exists. Both directories are created later (IF-008 / IF-011).
    const bad: string[] = [];
    const pairs: Array<[string, string]> = [
      ['packages/adapters/src/harness-claude-code', 'github'],
      ['packages/adapters/src/harness-codex', 'github'],
      ['packages/adapters/src/github', 'harness-'],
    ];
    for (const [dir, forbidden] of pairs) {
      let files: string[] = [];
      try {
        files = sourceFiles(join(ROOT, dir));
      } catch {
        continue; // directory does not exist yet
      }
      for (const f of files) {
        for (const spec of imports(f)) {
          if (spec.includes(forbidden)) bad.push(`${f}: ${spec}`);
        }
      }
    }
    expect(bad, `harness and GitHub layers must not know about each other:\n${bad.join('\n')}`).toEqual([]);
  });
});
