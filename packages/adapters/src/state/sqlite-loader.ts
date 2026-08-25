import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import { suppressSqliteExperimentalWarning } from '../logger/index.js';

/**
 * Loads `node:sqlite` on first use, with its release-candidate notice silenced.
 *
 * The notice fires when the module is LOADED, not when it is first used, so the
 * suppression has to run first. A static import cannot be sequenced after anything —
 * ESM hoists imports, and bundling flattens file order away — so a lazy require is
 * the only placement where the suppression is guaranteed to already be installed.
 */
export type SqliteModule = typeof NodeSqlite;
export type Database = InstanceType<SqliteModule['DatabaseSync']>;

let cached: SqliteModule | undefined;

export function loadSqlite(): SqliteModule {
  if (cached === undefined) {
    suppressSqliteExperimentalWarning();
    cached = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  }
  return cached;
}
