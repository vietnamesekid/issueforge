import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  clean: true,
  // Required: package.json "bin" points here, so the built file must be executable
  // by the shell directly. tsup does not expose --banner on the CLI.
  banner: { js: '#!/usr/bin/env node' },
});
