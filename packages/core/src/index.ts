/**
 * Pure domain logic: state transitions, evidence validation, policy.
 *
 * Dependency rule: this package may import ONLY @issueforge/contracts.
 * No execa, no node:sqlite, no gh, no node:fs. I/O lives behind ports that
 * adapters implement. Enforced by the import-boundary test.
 */
import type { RunStatus } from '@issueforge/contracts';

/** Terminal states hold no lock and will not advance without new maintainer intent. */
const TERMINAL: readonly RunStatus[] = [
  'reproduced',
  'cannot-reproduce',
  'needs-info',
  'blocked',
  'cancelled',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}
