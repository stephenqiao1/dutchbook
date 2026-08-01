import { desc } from 'drizzle-orm';

import { closeDatabase, db } from '../db/client.js';
import { violations } from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { runCoherenceCheck } from './check.js';
import { apparentReasons, lifetimeStats, recordViolations } from './violations-store.js';

/**
 * `pnpm coherence:check [--once] [--epsilon=0.005] [--max=25] [--dry-run]`
 *
 * Runs one coherence check by hand and prints the result in a form a person can
 * act on: the trade legs, the sizes, the prices, and the arithmetic that says
 * it is riskless. `--dry-run` skips persistence.
 *
 * `pnpm coherence:report` prints the standing metrics instead of checking.
 */

const log = createLogger('coherence:cli');

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const cents = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(2)}¢`);

function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 90) return `${value.toFixed(1)}s`;
  if (value < 5400) return `${(value / 60).toFixed(1)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

async function report(): Promise<number> {
  const stats = await lifetimeStats(db);
  const reasons = await apparentReasons(db);

  const recent = await db
    .select()
    .from(violations)
    .orderBy(desc(violations.detectedAt))
    .limit(8);

  process.stdout.write(
    [
      '',
      '  ── coherence ─────────────────────────────────────────────────────',
      `  confirmed ever         ${stats.totalConfirmedEver}`,
      `  open episodes          ${stats.openEpisodes} (${stats.openConfirmed} confirmed)`,
      `  closed episodes        ${stats.closedEpisodes} (${stats.closedConfirmed} confirmed)`,
      '',
      `  MEDIAN LIFETIME        ${seconds(stats.medianConfirmedLifetimeSeconds)}   (confirmed violations)`,
      `  p90 lifetime           ${seconds(stats.p90ConfirmedLifetimeSeconds)}`,
      `  median, all episodes   ${seconds(stats.medianAllLifetimeSeconds)}`,
      `  best net profit        ${stats.bestNetProfit === null ? '—' : usd(stats.bestNetProfit)}`,
      '',
      '  why apparent violations were not executable:',
      ...(reasons.length === 0
        ? ['    (none recorded yet)']
        : reasons.map((r) => `    ${String(r.count).padStart(5)}  ${r.reason.slice(0, 88)}`)),
      '',
      '  most recent episodes:',
      ...recent.map(
        (row) =>
          `    ${row.status.padEnd(9)} ${row.kind.padEnd(11)} ${row.constraintKey.padEnd(18)}` +
          ` peak ${row.peakNetProfit === null ? '—' : usd(Number(row.peakNetProfit))}` +
          `  ${row.detectedAt.toISOString()}`,
      ),
      '  ──────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes('--report')) return report();

  const epsilon = Number(arg('epsilon') ?? '0.005');
  const max = Number(arg('max') ?? '25');
  const dryRun = process.argv.includes('--dry-run');

  const result = await runCoherenceCheck(db, {
    epsilon: Number.isFinite(epsilon) ? epsilon : 0.005,
    maxConfirmations: Number.isFinite(max) ? max : 25,
    snapshot: !dryRun,
  });

  const lines: string[] = [
    '',
    '  ── coherence check ───────────────────────────────────────────────',
    `  constraints evaluated  ${result.screened.evaluated}`,
    `  satisfied              ${result.screened.satisfied}`,
    `  unscreenable           ${result.screened.unscreenable}  (no cached quote)`,
    `  SCREENED as violated   ${result.screened.violated}`,
    `  order books fetched    ${result.booksFetched}`,
    '',
    `  CONFIRMED              ${result.confirmed}`,
    `  apparent only          ${result.apparent}`,
    '',
  ];

  for (const c of result.confirmations) {
    const marker = c.status === 'confirmed' ? '✓ CONFIRMED' : '· apparent ';
    lines.push(
      `  ${marker}  ${c.constraint.kind.padEnd(11)} ${c.constraint.key}`,
      `      screen magnitude ${cents(c.evaluation.magnitude)}   live ${cents(c.liveMagnitude)}`,
    );

    if (c.trade === null) {
      lines.push(`      not executable: ${c.reason ?? 'unknown'}`, '');
      continue;
    }

    const t = c.trade;
    lines.push(
      `      ${t.summary}`,
      `      size ${t.size.toFixed(2)} units   guaranteed payout ${usd(t.totalPayout)}`,
      `      cost ${usd(t.totalCost)} (notional ${usd(t.totalNotional)} + fees ${usd(t.totalFees)})`,
      `      NET EDGE ${cents(t.netEdge)}/unit   NET PROFIT ${usd(t.netProfit)}   return ${(t.returnOnCost * 100).toFixed(2)}%`,
      '      legs:',
    );
    for (const leg of t.legs) {
      lines.push(
        `        buy ${leg.size.toFixed(2).padStart(10)} × ${(leg.outcome ?? '?').padEnd(12)}` +
          ` @ avg ${cents(leg.avgPrice)} (touch ${cents(leg.touchPrice)})` +
          `  ${leg.conditionId.slice(0, 12)}…`,
      );
    }
    lines.push('');
  }

  lines.push('  ──────────────────────────────────────────────────────────────────', '');
  process.stdout.write(lines.join('\n'));

  if (!dryRun) {
    const stillViolating = new Set(result.confirmations.map((c) => c.constraint.key));
    const recorded = await recordViolations(result.confirmations, stillViolating, db);
    process.stdout.write(`  persisted: ${JSON.stringify(recorded)}\n\n`);
  }

  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  log.error({ error: describeError(error) }, 'coherence cli failed');
}
await closeDatabase().catch(() => {});
process.exit(code);
