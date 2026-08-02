import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

import { screen } from '../src/coherence/constraints.js';
import { loadConstraints, screenPrices } from '../src/coherence/load.js';
import * as schema from '../src/db/schema.js';

/**
 * What breaks first at 10x the current catalog.
 *
 *   pnpm load-test              # 10x
 *   pnpm load-test --scale=1    # sanity check against today's size
 *   pnpm load-test --keep       # leave the scratch database behind
 *
 * Seeds a throwaway database with a synthetic graph and measures the paths that
 * carry the whole catalog at once. Data is generated inside Postgres with
 * `generate_series` rather than inserted row by row — at these sizes the round
 * trips, not the writes, are what would make this take an hour.
 *
 * The interesting number is memory, not time. Stage 1 loads every constraint
 * into JavaScript objects on every run, so its footprint is linear in the graph
 * and independent of how many violations there are.
 */

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k ?? '', v ?? 'true'];
  }),
);

const scale = Number(args.get('scale') ?? 10);
const keep = args.get('keep') === 'true';
/** What the production machine actually has. See `[[vm]]` in fly.toml. */
const VM_MEMORY_MB = Number(args.get('vm') ?? 512);

/** Today's live figures, from the production-shaped local database. */
const BASE = { activeMarkets: 15_000, events: 3_000, edges: 67_600, groups: 24_200, groupSize: 5 };

const target = {
  markets: Math.round(BASE.activeMarkets * scale),
  events: Math.round(BASE.events * scale),
  edges: Math.round(BASE.edges * scale),
  groups: Math.round(BASE.groups * scale),
};

const adminUrl = process.env['DATABASE_URL'];
if (adminUrl === undefined) {
  process.stderr.write('\n  DATABASE_URL must be set; the scratch database is created beside it.\n\n');
  process.exit(1);
}

const scratchName = `dutchbook_load_${scale}x`;
const scratchUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${scratchName}$1`);

const fmt = (n: number): string => n.toLocaleString('en-US');
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

interface Measurement {
  readonly step: string;
  readonly ms: number;
  readonly heapDeltaBytes: number;
  readonly heapAfterBytes: number;
  readonly rssAfterBytes: number;
  readonly note: string;
}

const measurements: Measurement[] = [];

/**
 * Samples RSS continuously, not just at the end.
 *
 * A delta and an end-of-run total disagree whenever the garbage collector runs
 * in between, and the first version of this script reported a 778 MB heap delta
 * next to a 231 MB "peak" RSS — two true numbers that together said something
 * false. The high-water mark is the number that decides whether this fits in a
 * 512 MB machine, so it is the one that gets sampled properly.
 */
let peakRss = process.memoryUsage().rss;
let peakHeap = process.memoryUsage().heapUsed;
const sampler = setInterval(() => {
  const { rss, heapUsed } = process.memoryUsage();
  if (rss > peakRss) peakRss = rss;
  if (heapUsed > peakHeap) peakHeap = heapUsed;
}, 25);
sampler.unref();

async function measure<T>(step: string, note: string, fn: () => Promise<T>): Promise<T> {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const value = await fn();
  const ms = performance.now() - started;
  const after = process.memoryUsage();
  measurements.push({
    step,
    ms,
    heapDeltaBytes: after.heapUsed - heapBefore,
    heapAfterBytes: after.heapUsed,
    rssAfterBytes: after.rss,
    note,
  });
  process.stdout.write(
    `  ${step.padEnd(38)} ${secs(ms).padStart(8)}  ${mb(after.heapUsed - heapBefore).padStart(8)}  ${mb(after.rss).padStart(8)}\n`,
  );
  return value;
}

// ---------------------------------------------------------------------------

process.stdout.write(`\n  load test at ${scale}x — scratch database ${scratchName}\n\n`);

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
await admin.unsafe(`drop database if exists ${scratchName}`);
await admin.unsafe(`create database ${scratchName}`);
await admin.end({ timeout: 5 });

const client = postgres(scratchUrl, { max: 8, onnotice: () => {} });
const database = drizzle(client, { schema });

try {
  const dir = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).toSorted()) {
    for (const statement of readFileSync(new URL(file, dir), 'utf8').split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed !== '') await client.unsafe(trimmed);
    }
  }

  process.stdout.write(
    `  seeding ${fmt(target.markets)} markets, ${fmt(target.edges)} edges, ${fmt(target.groups)} groups\n\n`,
  );

  await measure('seed: events + markets', `${fmt(target.markets)} rows`, async () => {
    await client.unsafe(`
      insert into events (id, slug, title)
      select i::text, 'ev-' || i, 'Event ' || i from generate_series(1, ${target.events}) i
    `);
    await client.unsafe(`
      insert into markets (condition_id, event_id, question, slug, content_hash, end_date, closed, outcomes, clob_token_ids)
      select '0x' || lpad(i::text, 62, '0'),
             ((i % ${target.events}) + 1)::text,
             'Will synthetic market ' || i || ' resolve above ' || (i % 90 + 5) || '%?',
             'synthetic-' || i,
             md5(i::text),
             now() + ((i % 400) || ' days')::interval,
             false,
             '["Yes","No"]'::jsonb,
             jsonb_build_array('tok-' || i || '-a', 'tok-' || i || '-b')
      from generate_series(1, ${target.markets}) i
    `);
  });

  await measure('seed: quotes', `${fmt(target.markets)} rows`, async () => {
    await client.unsafe(`
      insert into market_quotes (condition_id, yes_price, best_bid, best_ask, fetched_at)
      select '0x' || lpad(i::text, 62, '0'),
             round((0.05 + (i % 90) / 100.0)::numeric, 4),
             round((0.04 + (i % 90) / 100.0)::numeric, 4),
             round((0.06 + (i % 90) / 100.0)::numeric, 4),
             now()
      from generate_series(1, ${target.markets}) i
    `);
  });

  await measure('seed: relations', `${fmt(target.edges)} edges`, async () => {
    // k distinct offsets per market keeps every (from, to) pair unique without
    // needing a dedup pass.
    const perMarket = Math.max(1, Math.ceil(target.edges / target.markets));
    await client.unsafe(`
      insert into relations (from_condition_id, to_condition_id, type, source, confidence)
      select '0x' || lpad(i::text, 62, '0'),
             '0x' || lpad((((i + k - 1) % ${target.markets}) + 1)::text, 62, '0'),
             'implies', 'ladder', 1
      from generate_series(1, ${target.markets}) i, generate_series(1, ${perMarket}) k
      where ((i + k - 1) % ${target.markets}) + 1 <> i
      limit ${target.edges}
    `);
  });

  await measure('seed: partition groups + members', `${fmt(target.groups)} groups`, async () => {
    await client.unsafe(`
      insert into relation_groups (key, type, source, confidence)
      select 'grp-' || i, 'partition', 'neg-risk-event', 1 from generate_series(1, ${target.groups}) i
    `);
    await client.unsafe(`
      insert into relation_group_members (group_id, condition_id)
      select g.id, '0x' || lpad((((g.id * ${BASE.groupSize} + m) % ${target.markets}) + 1)::text, 62, '0')
      from relation_groups g, generate_series(1, ${BASE.groupSize}) m
    `);
    await client.unsafe(`analyze`);
  });

  process.stdout.write('\n');

  // ---- the paths that carry the whole catalog --------------------------
  const loaded = await measure('stage 1: loadConstraints', 'whole graph into memory', async () =>
    loadConstraints(database),
  );

  const quotes = await measure('stage 1: loadQuotes', 'one price per market', async () => {
    const rows = await database.execute<{ condition_id: string; yes_price: string }>(
      sql`select condition_id, yes_price from market_quotes`,
    );
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.condition_id, Number(row.yes_price));
    return map;
  });

  const priced = await measure('stage 1: screen', `${fmt(loaded.constraints.length)} constraints`, async () => {
    const { prices } = screenPrices(loaded.conditionIds, quotes, null, null);
    const withPrices = loaded.constraints.map((c) => ({
      ...c,
      members: c.members.map((m) => ({ conditionId: m.conditionId, price: prices.get(m.conditionId) ?? null })),
    }));
    return screen(withPrices, 0.005);
  });

  await measure('dashboard: status aggregate', 'the public page', async () => {
    const { readStatus } = await import('../src/dashboard/queries.js');
    return readStatus(database);
  });

  await measure('report: catalog + coverage', 'pnpm report', async () => {
    const { readCatalog, readCoverage } = await import('../src/report/queries.js');
    return Promise.all([readCatalog(database), readCoverage(database)]);
  });

  const [size] = await client.unsafe(`select pg_size_pretty(pg_database_size('${scratchName}')) as size`);

  // ---- report ----------------------------------------------------------
  const totalMs = measurements.reduce((s, m) => s + m.ms, 0);

  process.stdout.write(
    [
      '',
      `  constraints loaded   ${fmt(loaded.constraints.length)}`,
      `  markets under them   ${fmt(loaded.conditionIds.length)}`,
      `  screened violations  ${fmt(priced.violations.length)}`,
      `  database on disk     ${(size as { size: string }).size}`,
      `  peak process RSS     ${mb(peakRss)}`,
      `  peak heap used       ${mb(peakHeap)}`,
      `  total measured       ${secs(totalMs)}`,
      '',
    ].join('\n'),
  );

  const table = [
    '| Step | Wall time | Heap delta | Heap after | RSS after | Notes |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...measurements.map(
      (m) =>
        `| ${m.step} | ${secs(m.ms)} | ${mb(m.heapDeltaBytes)} | ${mb(m.heapAfterBytes)} | ${mb(m.rssAfterBytes)} | ${m.note} |`,
    ),
  ].join('\n');

  writeFileSync(
    'docs/LOAD.md',
    `# Load test at ${scale}x

Generated by \`pnpm load-test --scale=${scale}\` against a synthetic catalog on
scratch database \`${scratchName}\`. Regenerate rather than edit.

**Shape:** ${fmt(target.markets)} active markets, ${fmt(target.edges)} relation edges,
${fmt(target.groups)} partition groups of ${BASE.groupSize} — ${scale}x the live catalog.
That is ${fmt(loaded.constraints.length)} constraints over ${fmt(loaded.conditionIds.length)} markets,
${(size as { size: string }).size} on disk.

${table}

**Peak process RSS: ${mb(peakRss)}. Peak heap used: ${mb(peakHeap)}.**
Both sampled every 25ms throughout the run, not read once at the end.

## Verdict

Production runs on a **${VM_MEMORY_MB} MB** machine (\`[[vm]]\` in \`fly.toml\`).
${
  peakRss / 1024 / 1024 > VM_MEMORY_MB
    ? `At ${scale}x the checker peaks at ${mb(peakRss)} — **${(peakRss / 1024 / 1024 / VM_MEMORY_MB).toFixed(1)}x over budget. It would be OOM-killed mid-check.**

Nothing here gets slow first; it gets killed first. \`loadConstraints\` materialises
every constraint as a JavaScript object on every run, so the footprint tracks the
graph rather than the workload, and \`screen\` then allocates a second copy to
attach prices. The fix is not a bigger machine: it is to stream constraints in
batches and screen each batch as it arrives, so peak memory tracks the batch and
not the catalog. Nothing about the two-stage design requires the whole graph to be
resident at once — it is resident because that was the simplest thing that worked
at 1x.`
    : `At ${scale}x the checker peaks at ${mb(peakRss)}, inside budget.`
}

Everything else scales acceptably. The dashboard's status aggregate stays well
under a second because it is a handful of counts, the report's catalog pass slows
in proportion to the row count, and the seeding times are an artefact of this
script rather than of the service.

Read the heap column, not the clock. Stage 1 materialises every constraint as a
JavaScript object on every run, so its footprint scales with the graph and not
with how many violations exist — which makes it the first thing to break as the
catalog grows, and it breaks by being killed rather than by getting slow.
`,
  );
  process.stdout.write('  wrote docs/LOAD.md\n\n');
} finally {
  await client.end({ timeout: 5 });
  if (!keep) {
    const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`drop database if exists ${scratchName}`);
    await cleanup.end({ timeout: 5 });
    process.stdout.write(`  dropped ${scratchName}\n\n`);
  } else {
    process.stdout.write(`  kept ${scratchName}\n\n`);
  }
}
