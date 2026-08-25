import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Root-level tests are not inside any workspace package, so pnpm's node_modules
     * links do not reach them. Pointing the aliases at source also means these tests
     * exercise the code as written rather than a possibly-stale `dist/`.
     */
    alias: {
      '@issueforge/contracts': src('./packages/contracts/src/index.ts'),
      '@issueforge/core': src('./packages/core/src/index.ts'),
      '@issueforge/adapters': src('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
