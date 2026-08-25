import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DefectToggle } from '@issueforge/core';

/**
 * Removes a defect by overwriting files, then puts them back.
 *
 * The differential check needs to observe the reproduction passing once the bug is
 * gone. That means someone must supply the fix — the validator cannot invent it — so
 * this takes the fixed contents from the caller.
 *
 * Restoring is not optional: leaving a patched workspace behind would make every
 * later inspection of the evidence misleading, and the workspace *is* the evidence.
 */
export class FileDefectToggle implements DefectToggle {
  readonly #fixed: ReadonlyMap<string, string>;
  #original = new Map<string, string>();

  /** @param fixed repo-relative path → contents with the defect removed */
  constructor(fixed: ReadonlyMap<string, string>) {
    this.#fixed = fixed;
  }

  async applyFix(cwd: string): Promise<void> {
    const original = new Map<string, string>();

    for (const [relative, contents] of this.#fixed) {
      const path = join(cwd, relative);
      original.set(relative, await readFile(path, 'utf8'));
      await writeFile(path, contents);
    }

    this.#original = original;
  }

  async revertFix(cwd: string): Promise<void> {
    for (const [relative, contents] of this.#original) {
      await writeFile(join(cwd, relative), contents);
    }
    this.#original = new Map();
  }
}
