import { closeDatabase } from '../db/client.js';
import { describeError } from '../errors.js';
import { buildReport } from './build.js';

/**
 * `pnpm report` — regenerates docs/REPORT.md and its charts.
 *
 * Deliberately does not take a database argument. It reads whatever
 * `DATABASE_URL` points at, so the same command produces the local report and
 * the production one, and there is no flag to get that wrong.
 */
const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? 'docs';

try {
  const result = await buildReport({ outDir });

  process.stdout.write(
    [
      '',
      `  wrote ${result.reportPath}`,
      `  ${result.charts.length} charts in ${outDir}/charts`,
      `  ${result.episodes.toLocaleString('en-US')} episodes over ${
        result.windowHours === null ? 'an unknown window' : `${result.windowHours.toFixed(1)} hours`
      }`,
      '',
    ].join('\n'),
  );
} catch (error) {
  process.stderr.write(`\n  report failed: ${describeError(error)}\n\n`);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
}

await closeDatabase();
process.exit(0);
