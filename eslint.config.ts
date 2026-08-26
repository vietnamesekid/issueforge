import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting.
 *
 * The value is not the style rules — it is `no-floating-promises` and
 * `no-misused-promises`, which prevent a bug class permanently. Manual review does not
 * scale; a rule does.
 *
 * Every override below disables a rule that fights this repository's own tsconfig or
 * its testing style, and says why. Nothing is disabled merely to make the run pass.
 */
export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/.tsbuild/**',
    '**/node_modules/**',
    '**/*.d.ts',
    '**/tsup.config.ts',
    'eslint.config.ts',
    'vitest.config.ts',
  ]),

  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `noUncheckedIndexedAccess` is on, which makes `process.env.FOO` a possibly-undefined
      // read that TypeScript will not narrow. The codebase uses `process.env['FOO']`
      // deliberately for that reason, so this rule would fight the type system.
      '@typescript-eslint/dot-notation': 'off',

      // Type imports are load-bearing here: `verbatimModuleSyntax` means a value import
      // of a type-only symbol emits a runtime require that fails.
      '@typescript-eslint/consistent-type-imports': 'error',

      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Numbers in template strings are intentional throughout (pids, exit codes,
      // durations). Everything genuinely unsafe — objects, any, never — stays banned.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  {
    // `tests/` and `examples/` sit outside every package tsconfig, so the project
    // service cannot type them. Lint them without type information rather than not at
    // all. Bringing them under a tsconfig would mean making `tests/` a workspace
    // package so `@issueforge/*` resolves — more churn than the lint value justifies.
    files: ['tests/**/*.ts', 'examples/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Tests deliberately construct malformed input to prove it is rejected, and assert
    // on void-returning calls (`expect(() => store.close()).not.toThrow()`).
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      // A test double's `cancel()` is a deliberate no-op — the fake has nothing to
      // cancel — and an empty body says that more plainly than a comment would.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
);
