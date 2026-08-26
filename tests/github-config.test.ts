/**
 * Parses everything under `.github/`.
 *
 * These files are executed by GitHub, never by this repository, so a syntax error in
 * one is invisible locally: a broken workflow simply does not run, and a broken issue
 * template is silently ignored rather than reported. `pnpm check` cannot otherwise
 * see them at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname;
const GITHUB = join(ROOT, '.github');

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p));
    else if (entry.endsWith('.yml') || entry.endsWith('.yaml')) out.push(p);
  }
  return out;
}

describe('.github configuration', () => {
  const files = yamlFiles(GITHUB);

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(ROOT.length), f]))('%s parses', (_label, file) => {
    expect(() => parse(readFileSync(file as string, 'utf8'))).not.toThrow();
  });

  it('gives every workflow a name and a trigger', () => {
    // A workflow missing `on` never fires, and GitHub reports that as the workflow
    // simply not existing rather than as an error.
    for (const file of files.filter((f) => f.includes('/workflows/'))) {
      const doc = parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(doc['name'], `${file} has no name`).toBeDefined();
      // `on` is the YAML 1.1 boolean `true` once parsed — that is the trigger key.
      expect(doc['on'] ?? doc[true as unknown as string], `${file} has no trigger`).toBeDefined();
    }
  });

  it('routes vulnerability reports away from public issues', () => {
    // This project runs untrusted issue text through a coding agent on the
    // maintainer's machine; a vulnerability disclosed in a public issue is a
    // disclosure to everyone at once.
    const config = parse(
      readFileSync(join(GITHUB, 'ISSUE_TEMPLATE/config.yml'), 'utf8'),
    ) as { contact_links?: { url?: string }[] };
    const urls = (config.contact_links ?? []).map((l) => l.url ?? '');
    expect(urls.some((u) => u.includes('security/advisories'))).toBe(true);
  });
});
