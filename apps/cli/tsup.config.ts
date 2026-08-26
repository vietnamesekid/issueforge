import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  clean: true,
  // Declarations come from `tsc --build`; this pass only produces the runnable
  // bundle, so the two do not duplicate work or disagree.
  dts: false,
  /**
   * Bundle the workspace packages into the CLI.
   *
   * They are linked with `workspace:*`, which npm cannot resolve outside this
   * monorepo — a global install would fetch nothing and fail at first import. Third
   * party dependencies stay external so npm dedupes them and users can audit them.
   */
  noExternal: [/^@issueforge\//],
  /**
   * Third-party packages stay external. Measured, not assumed — do not "optimise"
   * this into a single-file bundle without re-running the numbers.
   *
   * commander and pino are CommonJS. Bundling them into an ESM output rewrites their
   * internal require() calls into a stub that throws `Dynamic require of "events" is
   * not supported` at first run — observed, and invisible during development because
   * `node src/main.ts` never takes the bundled path.
   *
   * A `createRequire` banner silences that, and bundled pino then logs correctly — but
   * only because logger.ts deliberately uses no worker transports. Adding one fails
   * with `__dirname is not defined`, because thread-stream resolves its worker as a
   * separate file on disk that no bundler can inline. Bundling would trade a visible
   * config constraint for a trap that fires on someone else's future change.
   *
   * What it would buy is small: the four externals install in ~0.5s, and gzipped the
   * whole difference is tens of KB. Minifying is likewise declined — it shrinks the
   * bundle ~42% but renames every frame in a stack trace, and this CLI reports its own
   * failures to users. tsup, vitest and prisma all ship unminified for that reason.
   */
  external: ['pino', 'execa', 'zod', 'commander'],
  // Required: package.json "bin" points here, so the built file must be executable
  // by the shell directly. tsup does not expose --banner on the CLI.
  banner: { js: '#!/usr/bin/env node' },
});
