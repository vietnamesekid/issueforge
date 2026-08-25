import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IssueKey } from '@issueforge/contracts';
import { ALL_STATUS_LABELS, COMMENT_MARKER, type GitHubWriter } from '@issueforge/core';
import { gh, ghSucceeds, type GhOptions } from './gh.js';

/** Colour for generated status labels — one shade, so they read as a set. */
const LABEL_COLOUR = '0E8A16';

interface CommentSummary {
  id: string;
  body: string;
}

/**
 * Writes status to GitHub through the `gh` CLI.
 *
 * Two properties matter more than the mechanics.
 *
 * **Status labels are outputs, never triggers.** GitHub does not create workflow runs
 * from events triggered by `GITHUB_TOKEN`, so a label written here can never start the
 * next stage — every transition is driven by a maintainer applying an intent label.
 * That is a deliberate constraint, not a limitation to work around.
 *
 * **One comment, updated in place.** A maintainer reading the issue should see the
 * current state, not a transcript of every attempt.
 */
export class GhWriter implements GitHubWriter {
  readonly #repo: string;
  readonly #options: GhOptions;

  constructor(repo: string, options: GhOptions = {}) {
    this.#repo = repo;
    this.#options = options;
  }

  async ensureLabels(_issue: IssueKey, labels: readonly string[]): Promise<void> {
    for (const label of labels) {
      // --force makes this idempotent: creating an existing label updates it rather
      // than failing, so a first run and a hundredth behave identically.
      await ghSucceeds(
        ['label', 'create', label, '-R', this.#repo, '-c', LABEL_COLOUR, '--force'],
        this.#options,
      );
    }
  }

  async setStatusLabel(issue: IssueKey, label: string): Promise<void> {
    const stale = ALL_STATUS_LABELS.filter((name) => name !== label);

    // One call: gh applies removals and additions together, so the issue never passes
    // through a state with no status label at all.
    const args = ['issue', 'edit', String(issue.issueNumber), '-R', this.#repo, '--add-label', label];
    for (const name of stale) args.push('--remove-label', name);

    await gh(args, this.#options);
  }

  async upsertComment(issue: IssueKey, body: string): Promise<void> {
    const existing = await this.#findOwnComment(issue);

    // The body goes through a file, never argv: it contains rendered issue content,
    // and a comment is the one place a leak would be permanent and public.
    const dir = mkdtempSync(join(tmpdir(), 'issueforge-comment-'));
    const file = join(dir, 'body.md');

    try {
      writeFileSync(file, body);

      if (existing === undefined) {
        await gh(
          ['issue', 'comment', String(issue.issueNumber), '-R', this.#repo, '--body-file', file],
          this.#options,
        );
      } else {
        await gh(
          [
            'api',
            `repos/${this.#repo}/issues/comments/${existing.id}`,
            '-X',
            'PATCH',
            '-F',
            `body=@${file}`,
          ],
          this.#options,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Find IssueForge's own comment by its marker.
   *
   * Matching on a marker rather than on the author means a repository using a shared
   * account still gets one comment updated, instead of one per run.
   */
  async #findOwnComment(issue: IssueKey): Promise<CommentSummary | undefined> {
    const raw = await gh(
      [
        'api',
        `repos/${this.#repo}/issues/${issue.issueNumber}/comments`,
        '--paginate',
        '--jq',
        '.[] | {id: .id, body: .body}',
      ],
      this.#options,
    );

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const comment = JSON.parse(line) as CommentSummary;
        if (comment.body.includes(COMMENT_MARKER)) return comment;
      } catch {
        // A line that does not parse is not our comment; keep looking.
      }
    }

    return undefined;
  }
}
