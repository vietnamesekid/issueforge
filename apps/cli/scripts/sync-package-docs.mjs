/**
 * Copies the root README and LICENSE into the package directory at pack time.
 *
 * npm reads both from the TARBALL, never from the git repository, and `files`
 * cannot reach above the package root — so without this step the published page
 * renders no README and shows no licence, even though both sit in the repo.
 *
 * They are copies, so they are gitignored inside apps/cli: the root files stay the
 * single source of truth and cannot drift.
 */
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(pkgDir, '..', '..');

for (const file of ['README.md', 'LICENSE']) {
  copyFileSync(join(repoRoot, file), join(pkgDir, file));
  process.stdout.write(`prepack: copied ${file}\n`);
}
