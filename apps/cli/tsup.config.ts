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
   * Third-party packages stay external.
   *
   * pino is CommonJS; bundling it into an ESM output rewrites its internal require()
   * calls into a stub that throws at runtime — a failure that appears only once the
   * CLI is installed, never during development. npm can fetch these, so it should.
   */
  external: ['pino', 'execa', 'zod', 'commander'],
  // Required: package.json "bin" points here, so the built file must be executable
  // by the shell directly. tsup does not expose --banner on the CLI.
  banner: { js: '#!/usr/bin/env node' },
});
