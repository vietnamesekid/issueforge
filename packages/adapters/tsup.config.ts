import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  /**
   * tsup defaults `removeNodeProtocol` to true, which rewrites `node:x` to a bare `x`
   * on the way out. That is harmless for long-standing builtins, but `sqlite` is not
   * in `module.builtinModules` yet (node:sqlite is still a release candidate), so the
   * bare specifier resolves as a package, finds nothing, and the built file throws
   * ERR_MODULE_NOT_FOUND at import time while the TypeScript source runs fine.
   *
   * Keeping the prefix is also simply correct: `node:` is unambiguous and cannot be
   * shadowed by a package of the same name.
   */
  removeNodeProtocol: false,
});
