/**
 * Fails when line coverage falls below a floor.
 *
 * A coverage badge on its own is decorative — it reports a number nobody is
 * obliged to keep. The floor is the part with teeth, so it lives in CI next to
 * the other gates rather than in a dashboard.
 *
 * The floor is deliberately a few points below the current number: it exists to
 * catch a real regression, not to fail the build on a one-line refactor.
 */
import { readFileSync } from 'node:fs';

const floor = Number(process.argv[2]);
if (!Number.isFinite(floor)) {
  console.error('usage: check-coverage.mjs <minimum-line-percentage>');
  process.exit(2);
}

const summaryPath = new URL('../coverage/coverage-summary.json', import.meta.url);

let total;
try {
  total = JSON.parse(readFileSync(summaryPath, 'utf8')).total;
} catch {
  // Failure here means the coverage run did not happen, which must not pass as
  // "coverage is fine".
  console.error(`::error::no coverage summary at ${summaryPath.pathname} — did the coverage run fail?`);
  process.exit(1);
}

const pct = total.lines.pct;
const ok = pct >= floor;

console.log(`lines ${pct}% (floor ${floor}%)`);
console.log(`statements ${total.statements.pct}% | functions ${total.functions.pct}% | branches ${total.branches.pct}%`);

if (!ok) {
  console.error(`::error::line coverage ${pct}% is below the ${floor}% floor`);
  process.exit(1);
}
