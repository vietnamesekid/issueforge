import type { IssueForgeConfig } from '@issueforge/contracts';
import {
  ClaudeCodeAdapter,
  GitWorkspaceManager,
  SqliteRunStore,
  createLogger,
  defaultRoot,
  statePath,
  type Logger,
} from '@issueforge/adapters';
import type { HarnessAdapter, RunStore, WorkspaceManager } from '@issueforge/core';
import { loadConfig } from './config.js';

/**
 * The composition root.
 *
 * This is the only place that knows which implementation satisfies which port. Every
 * other package depends on interfaces, which is what keeps `core` free of I/O and
 * makes the domain testable without a database, a network or a subprocess.
 */
export interface AppContext {
  store: RunStore;
  workspaces: WorkspaceManager;
  harness: HarnessAdapter;
  config: IssueForgeConfig;
  logger: Logger;
  root: string;
}

export interface ContextOptions {
  /** Overrides `~/.issueforge`; used by tests and by `ISSUEFORGE_HOME`. */
  root?: string;
  cwd?: string;
  verbose?: boolean;
}

export function createContext(options: ContextOptions = {}): AppContext {
  const root = options.root ?? defaultRoot();
  const config = loadConfig(options.cwd);

  const store = new SqliteRunStore(statePath(root));
  store.migrate();

  return {
    store,
    workspaces: new GitWorkspaceManager(root),
    harness: new ClaudeCodeAdapter(),
    config,
    // stderr, so stdout stays clean for `--json` output.
    logger: createLogger({ level: options.verbose === true ? 'debug' : 'info' }),
    root,
  };
}
