import { readFileSync } from 'node:fs';
import type { TaskIntent } from '@issueforge/contracts';
import { GitHubIssueEvent, INTENT_LABELS } from '@issueforge/contracts';

/**
 * Reads the workflow event at `$GITHUB_EVENT_PATH`.
 *
 * The payload is the full `issues.labeled` webhook body — the same JSON an HTTP
 * receiver would get — which is what makes a local process viable with no inbound
 * endpoint at all.
 *
 * The issue title and body are attacker-authored on any public repository. They are
 * carried through verbatim as data; nothing here interprets them, and nothing
 * downstream puts them on a command line.
 */

export interface ParsedEvent {
  repo: string;
  issueNumber: number;
  issue: { number: number; title: string; body: string };
  intent: TaskIntent;
  actor: string;
  defaultBranch: string;
}

/** The label applied was not one of ours. */
export class NotOurLabelError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`label "${label}" is not an IssueForge intent label`);
    this.name = 'NotOurLabelError';
    this.label = label;
  }
}

export function parseEventFile(path: string): ParsedEvent {
  const event = GitHubIssueEvent.parse(JSON.parse(readFileSync(path, 'utf8')));
  const label = event.label.name;

  const intent = (INTENT_LABELS as Record<string, TaskIntent | undefined>)[label];
  if (intent === undefined) {
    // Repositories have labels for all sorts of reasons; being triggered is not the
    // same as being addressed.
    throw new NotOurLabelError(label);
  }

  return {
    repo: event.repository.full_name,
    issueNumber: event.issue.number,
    issue: {
      number: event.issue.number,
      title: event.issue.title,
      body: event.issue.body ?? '',
    },
    intent,
    actor: event.sender.login,
    defaultBranch: event.repository.default_branch,
  };
}
