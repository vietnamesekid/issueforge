/**
 * Composition root. Wires concrete adapters into core's ports and parses argv.
 * Nothing imports this package.
 */
import { Command } from 'commander';
import { isTerminal } from '@issueforge/core';
import type { RunStatus } from '@issueforge/contracts';

const VERSION = '0.0.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('issueforge')
    .description('Local-first GitHub IssueOps supervisor for coding-agent harnesses')
    .version(VERSION);

  program
    .command('status')
    .description('Show local run state')
    .action(() => {
      // Placeholder until IF-004/IF-012. Proves the wiring, nothing more.
      const example: RunStatus = 'queued';
      console.log(`no runs yet (example status "${example}" terminal=${isTerminal(example)})`);
    });

  return program;
}

buildProgram().parse();
