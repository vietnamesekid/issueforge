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
    coverage: {
      provider: 'v8',
      // `json-summary` is what the badge step reads; `text` keeps the number
      // visible in CI logs, and `lcov` is what external tools consume.
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/cli/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        // Barrel files re-export; covering them measures nothing.
        '**/index.ts',
        // Type-only modules erase to nothing at runtime, so v8 reports them as
        // 0% covered no matter how thoroughly the types are used.
        '**/*.d.ts',
      ],
    },
  },
});
