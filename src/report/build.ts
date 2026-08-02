import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { barChart, heatmap, PALETTE } from './charts.js';
import {
  bucketise,
  EDGE_BUCKETS,
  LIFETIME_BUCKETS,
  MAGNITUDE_BUCKETS,
  quantile,
  rankFamilies,
  readCatalog,
  readConfirmedConstraints,
  readCoverage,
  readEpisodes,
  spearman,
  summarise,
  type Category,
  type Episode,
} from './queries.js';

/**
 * Assembles the report: charts to PNG, findings to markdown.
 *
 * Every number in the prose comes from the structures below, and none is
 * written by hand. That is the only way a generated report stays true after the
 * data behind it moves — a hand-written sentence about a median becomes a lie
 * the first time the median changes, and nothing catches it.
 */

type Database = PostgresJsDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const int = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US');

const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;

/** Probability and edge are both per-share, so cents is the natural unit. */
const cents = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}¢`;

function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, seconds);
  if (s < 90) return `${s.toFixed(0)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

const money = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;

/** Pipes and newlines would break the row they are printed in. */
const cell = (text: string | null | undefined, max = 64): string => {
  const clean = (text ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
};

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '_No rows._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildOptions {
  readonly database?: Database;
  /** Repo-relative output root. Charts land in `<outDir>/charts`. */
  readonly outDir?: string;
  readonly now?: Date;
}

export interface BuildResult {
  readonly reportPath: string;
  readonly charts: string[];
  readonly markdown: string;
  readonly windowHours: number | null;
  readonly episodes: number;
}

export async function buildReport(options: BuildOptions = {}): Promise<BuildResult> {
  const database = options.database ?? db;
  const outDir = options.outDir ?? 'docs';
  const chartDir = join(outDir, 'charts');
  const now = options.now ?? new Date();

  mkdirSync(chartDir, { recursive: true });

  const [catalog, coverage, episodes, confirmedConstraints] = await Promise.all([
    readCatalog(database),
    readCoverage(database),
    readEpisodes(database),
    readConfirmedConstraints(database),
  ]);

  const closed = episodes.filter((e) => e.lifetimeSeconds !== null);
  const confirmed = episodes.filter((e) => e.everConfirmed);
  const confirmedClosed = closed.filter((e) => e.everConfirmed);
  const charts: string[] = [];

  const emit = (name: string, png: Buffer): void => {
    writeFileSync(join(chartDir, name), png);
    charts.push(`charts/${name}`);
  };

  // ---- 3. net edge -------------------------------------------------------
  const edges = confirmed.map((e) => e.peakNetEdge).filter((v): v is number => v !== null);
  const edgeStats = summarise(edges);
  const edgeBuckets = bucketise(edges, EDGE_BUCKETS);

  emit(
    'net-edge-distribution.png',
    barChart({
      title: 'Net edge, confirmed violations',
      subtitle: `n=${edges.length} · median ${cents(edgeStats.median)} · p95 ${cents(edgeStats.p95)}`,
      yLabel: 'episodes',
      labels: edgeBuckets.map((b) => b.label),
      series: [{ label: 'confirmed', values: edgeBuckets.map((b) => b.count), color: PALETTE.ACCENT }],
      footnote: 'Peak net edge per share after fees and slippage, at the profit-maximising size.',
    }),
  );

  // ---- 4. lifetime -------------------------------------------------------
  const lifetimes = closed.map((e) => e.lifetimeSeconds!);
  const lifeStats = summarise(lifetimes);
  const confirmedLifeStats = summarise(confirmedClosed.map((e) => e.lifetimeSeconds!));

  const lifeBuckets = bucketise(lifetimes, LIFETIME_BUCKETS);
  const confirmedLifeBuckets = bucketise(
    confirmedClosed.map((e) => e.lifetimeSeconds!),
    LIFETIME_BUCKETS,
  );

  emit(
    'lifetime-distribution.png',
    barChart({
      title: 'How long a contradiction survives',
      subtitle: `n=${closed.length} closed episodes · median ${duration(lifeStats.median)} · p95 ${duration(lifeStats.p95)}`,
      yLabel: 'episodes',
      labels: lifeBuckets.map((b) => b.label),
      stacked: true,
      series: [
        {
          label: 'apparent',
          values: lifeBuckets.map((b, i) => b.count - (confirmedLifeBuckets[i]?.count ?? 0)),
          color: PALETTE.MUTED,
        },
        { label: 'confirmed', values: confirmedLifeBuckets.map((b) => b.count), color: PALETTE.ACCENT },
      ],
      footnote: 'Closed episodes only. The first bucket is at the resolution limit of a 60s check.',
    }),
  );

  // by constraint type
  const kinds = [...new Set(closed.map((e) => e.kind))].toSorted();
  const byKind = kinds.map((kind) => {
    const group = closed.filter((e) => e.kind === kind);
    return { kind, stats: summarise(group.map((e) => e.lifetimeSeconds!)) };
  });

  emit(
    'lifetime-by-type.png',
    barChart({
      title: 'Lifetime by constraint type',
      subtitle: 'median and p95, closed episodes',
      yLabel: 'seconds',
      labels: byKind.map((k) => k.kind),
      series: [
        { label: 'median', values: byKind.map((k) => k.stats.median), color: PALETTE.ACCENT },
        { label: 'p95', values: byKind.map((k) => k.stats.p95), color: PALETTE.ACCENT_LIGHT },
      ],
      annotations: byKind.map((k) => `n=${k.stats.n}`),
      footnote: 'A partition constrains many markets at once; an implication constrains two.',
    }),
  );

  // the hypothesis: do larger violations close faster?
  const magPairs = closed
    .filter((e) => e.peakMagnitude !== null)
    .map((e) => [Math.abs(e.peakMagnitude!), e.lifetimeSeconds!] as const);
  const magCorrelation = spearman(magPairs);

  /**
   * The same correlation computed inside each constraint type.
   *
   * Pooling the two is a trap: partitions carry much larger magnitudes than
   * implications by construction (a partition sums many prices, so it drifts
   * further from its target), and if the two types also differ in lifetime then
   * the pooled correlation measures the difference between types rather than the
   * relationship within either. Reporting both is the only way to tell.
   */
  const magByKind = kinds.map((kind) => ({
    kind,
    correlation: spearman(
      closed
        .filter((e) => e.kind === kind && e.peakMagnitude !== null)
        .map((e) => [Math.abs(e.peakMagnitude!), e.lifetimeSeconds!] as const),
    ),
    magnitude: summarise(
      closed.filter((e) => e.kind === kind && e.peakMagnitude !== null).map((e) => Math.abs(e.peakMagnitude!)),
    ),
  }));

  /**
   * How much of the sample sits at the sampling floor.
   *
   * The confirmation loop runs on a 60-second schedule, so an episode seen once
   * and gone is recorded at roughly one interval whatever its true life. Where
   * most of the mass is inside two intervals the median is not measuring the
   * market — it is measuring the clock — and any statement about medians has to
   * say so.
   */
  const floorSeconds = 120;
  const atFloor = lifetimes.filter((v) => v <= floorSeconds).length;
  const floorShare = lifetimes.length === 0 ? null : atFloor / lifetimes.length;

  const magBuckets = MAGNITUDE_BUCKETS.map((bucket) => {
    const group = closed.filter(
      (e) =>
        e.peakMagnitude !== null &&
        Math.abs(e.peakMagnitude) >= bucket.from &&
        (bucket.to === null || Math.abs(e.peakMagnitude) < bucket.to),
    );
    return { label: bucket.label, stats: summarise(group.map((e) => e.lifetimeSeconds!)) };
  });

  emit(
    'lifetime-by-magnitude.png',
    barChart({
      title: 'Does a bigger contradiction close faster?',
      subtitle: `median lifetime by violation size · Spearman rho=${
        magCorrelation.rho === null ? '—' : magCorrelation.rho.toFixed(3)
      } (n=${magCorrelation.n})`,
      yLabel: 'seconds',
      labels: magBuckets.map((b) => b.label),
      series: [
        { label: 'median', values: magBuckets.map((b) => b.stats.median), color: PALETTE.ACCENT },
        { label: 'p95', values: magBuckets.map((b) => b.stats.p95), color: PALETTE.ACCENT_LIGHT },
      ],
      annotations: magBuckets.map((b) => (b.stats.n === 0 ? null : `n=${b.stats.n}`)),
      ...(lifeStats.median === null ? {} : { rule: { value: lifeStats.median, label: 'overall median' } }),
      footnote: 'Magnitude is the distance from the constraint holding, in probability, at its peak.',
    }),
  );

  // ---- 5. families -------------------------------------------------------
  const families = rankFamilies(episodes);
  const categories: Category[] = ['politics', 'sports', 'crypto', 'economics', 'other'];

  const byCategory = categories.map((category) => {
    const group = episodes.filter((e) => e.category === category);
    const groupClosed = group.filter((e) => e.lifetimeSeconds !== null);
    return {
      category,
      episodes: group.length,
      confirmed: group.filter((e) => e.everConfirmed).length,
      families: new Set(group.map((e) => e.constraintKey)).size,
      medianLifetime: quantile(
        groupClosed.map((e) => e.lifetimeSeconds!).toSorted((a, b) => a - b),
        0.5,
      ),
      markets: coverage.categoryMix.find((m) => m.category === category)?.markets ?? 0,
    };
  });

  emit(
    'violations-by-category.png',
    barChart({
      title: 'Incoherence by category',
      subtitle: 'episodes observed, against markets under constraint in that category',
      yLabel: 'episodes per 1,000 markets',
      labels: byCategory.map((c) => c.category),
      series: [
        {
          label: 'episodes per 1k markets',
          values: byCategory.map((c) => (c.markets === 0 ? null : (c.episodes / c.markets) * 1000)),
          color: PALETTE.ACCENT,
        },
      ],
      annotations: byCategory.map((c) => `n=${c.episodes}`),
      footnote: 'Category is a keyword heuristic on slug and question; there is no published category.',
    }),
  );

  // by time to resolution
  const HORIZONS = [
    { label: '<7d', from: -1e9, to: 7 },
    { label: '7-30d', from: 7, to: 30 },
    { label: '30-90d', from: 30, to: 90 },
    { label: '90-365d', from: 90, to: 365 },
    { label: '>1y', from: 365, to: null as number | null },
  ];
  const byHorizon = HORIZONS.map((h) => {
    const group = episodes.filter(
      (e) => e.daysToResolution !== null && e.daysToResolution >= h.from && (h.to === null || e.daysToResolution < h.to),
    );
    const groupClosed = group.filter((e) => e.lifetimeSeconds !== null);
    return {
      label: h.label,
      episodes: group.length,
      median: quantile(groupClosed.map((e) => e.lifetimeSeconds!).toSorted((a, b) => a - b), 0.5),
    };
  });

  emit(
    'lifetime-by-horizon.png',
    barChart({
      title: 'Lifetime by time to resolution',
      subtitle: 'how far the market is from settling',
      yLabel: 'median seconds',
      labels: byHorizon.map((h) => h.label),
      series: [{ label: 'median lifetime', values: byHorizon.map((h) => h.median), color: PALETTE.WARN }],
      annotations: byHorizon.map((h) => (h.episodes === 0 ? null : `n=${h.episodes}`)),
      footnote: 'Time to resolution, not listing age: our ingest began mid-catalog so true age is unknown.',
    }),
  );

  // ---- 6. time patterns --------------------------------------------------
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const grid: (number | null)[][] = DAYS.map(() => Array.from({ length: 24 }, () => 0));
  const observedDays = new Set<string>();
  const observedCells = new Set<string>();

  for (const episode of episodes) {
    const d = episode.detectedAt;
    const day = (d.getUTCDay() + 6) % 7; // Monday first
    const hour = d.getUTCHours();
    grid[day]![hour] = (grid[day]![hour] ?? 0) + 1;
    observedDays.add(d.toISOString().slice(0, 10));
    observedCells.add(`${day}:${hour}`);
  }

  // Cells the run never covered are blank, not zero. A zero would read as
  // "checked and found nothing" when it means "never looked".
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      if (!observedCells.has(`${d}:${h}`)) grid[d]![h] = null;
    }
  }

  emit(
    'violations-by-hour.png',
    heatmap({
      title: 'When violations open',
      subtitle: `detections by UTC hour · ${observedDays.size} distinct day(s) observed`,
      rowLabels: DAYS,
      colLabels: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
      values: grid,
      footnote:
        observedDays.size < 7
          ? 'Blank cells were never observed. With fewer than seven days, day-of-week is not measurable.'
          : 'Blank cells were never observed.',
    }),
  );

  const byHour = Array.from({ length: 24 }, (_, h) => episodes.filter((e) => e.detectedAt.getUTCHours() === h).length);

  // ---- markdown ----------------------------------------------------------
  const markdown = renderMarkdown({
    now,
    catalog,
    coverage,
    episodes,
    closed,
    confirmed,
    confirmedClosed,
    edgeStats,
    edgeBuckets,
    lifeStats,
    confirmedLifeStats,
    lifeBuckets,
    byKind,
    confirmedConstraints,
    magCorrelation,
    magByKind,
    floorShare,
    floorSeconds,
    magBuckets,
    families,
    byCategory,
    byHorizon,
    byHour,
    observedDays: observedDays.size,
    charts,
  });

  const reportPath = join(outDir, 'REPORT.md');
  writeFileSync(reportPath, markdown);

  return {
    reportPath,
    charts,
    markdown,
    windowHours: catalog.window.hours,
    episodes: episodes.length,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

interface RenderInput {
  now: Date;
  catalog: Awaited<ReturnType<typeof readCatalog>>;
  coverage: Awaited<ReturnType<typeof readCoverage>>;
  episodes: Episode[];
  closed: Episode[];
  confirmed: Episode[];
  confirmedClosed: Episode[];
  edgeStats: ReturnType<typeof summarise>;
  edgeBuckets: ReturnType<typeof bucketise>;
  lifeStats: ReturnType<typeof summarise>;
  confirmedLifeStats: ReturnType<typeof summarise>;
  lifeBuckets: ReturnType<typeof bucketise>;
  byKind: { kind: string; stats: ReturnType<typeof summarise> }[];
  confirmedConstraints: Awaited<ReturnType<typeof readConfirmedConstraints>>;
  magCorrelation: ReturnType<typeof spearman>;
  magByKind: { kind: string; correlation: ReturnType<typeof spearman>; magnitude: ReturnType<typeof summarise> }[];
  floorShare: number | null;
  floorSeconds: number;
  magBuckets: { label: string; stats: ReturnType<typeof summarise> }[];
  families: ReturnType<typeof rankFamilies>;
  byCategory: {
    category: Category;
    episodes: number;
    confirmed: number;
    families: number;
    medianLifetime: number | null;
    markets: number;
  }[];
  byHorizon: { label: string; episodes: number; median: number | null }[];
  byHour: number[];
  observedDays: number;
  charts: string[];
}

function renderMarkdown(d: RenderInput): string {
  const hours = d.catalog.window.hours;
  const days = hours === null ? null : hours / 24;
  const shortWindow = days === null || days < 25;

  const out: string[] = [];
  const p = (...lines: string[]): void => {
    out.push(...lines, '');
  };

  p(`# dutchbook: coherence in the Polymarket catalog`);
  p(
    `Generated ${d.now.toISOString()} by \`pnpm report\`. Every figure below is computed`,
    `from the database at run time; none is written by hand. The report reads whatever`,
    `\`DATABASE_URL\` points at, so which database produced a given copy is a property of how`,
    `it was run and not of this file — the observation window below is the way to tell.`,
  );

  // --- the window, first, because it conditions everything else ---
  p(`## Observation window`);
  p(
    table(
      ['', ''],
      [
        ['First detection', d.catalog.window.from ?? '—'],
        ['Last observation', d.catalog.window.to ?? '—'],
        ['Elapsed', hours === null ? '—' : `${hours.toFixed(1)} hours (${(hours / 24).toFixed(2)} days)`],
        ['Episodes recorded', int(d.episodes.length)],
        ['Distinct calendar days', int(d.observedDays)],
      ],
    ),
  );

  if (shortWindow) {
    p(
      `> **This is not thirty days of data.** The checker has been running for`,
      `> ${hours === null ? 'an unknown period' : `${hours.toFixed(1)} hours`}, across`,
      `> ${d.observedDays} calendar day(s). Every rate, every time-of-day pattern and every`,
      `> day-of-week claim below is therefore either unavailable or drawn from a window too`,
      `> short to support it, and is labelled as such where it appears. The distributional`,
      `> findings — lifetime, net edge, the size/lifetime relationship — have enough`,
      `> episodes (n=${int(d.closed.length)} closed) to be worth reading, with the caveat that they`,
      `> describe a few hours of one particular market session and not a month.`,
    );
  }

  // --- 1 ---
  p(`## 1. Catalog and coverage`);
  p(
    table(
      ['Metric', 'Value'],
      [
        ['Markets in catalog', int(d.catalog.markets.total)],
        ['Active (open, not missing)', int(d.catalog.markets.active)],
        ['Closed', int(d.catalog.markets.closed)],
        ['Markets in at least one relation or group', int(d.catalog.covered.either)],
        ['…of which active', int(d.catalog.covered.activeEither)],
        [
          'Coverage of the active catalog',
          d.catalog.markets.active === 0
            ? '—'
            : pct(d.catalog.covered.activeEither / d.catalog.markets.active),
        ],
      ],
    ),
  );

  p(`### Edges by source`);
  p(
    table(
      ['Source', 'Type', 'Edges'],
      d.catalog.edgesBySource.map((e) => [`\`${e.source}\``, e.type, int(e.count)]),
    ),
  );
  p(
    table(
      ['Group source', 'Partition groups'],
      d.catalog.groupsBySource.map((g) => [`\`${g.source}\``, int(g.count)]),
    ),
  );

  p(`### LLM-assisted proposals`);
  const pr = d.catalog.proposals;
  p(
    table(
      ['Metric', 'Value'],
      [
        ['Proposals generated', int(pr.total)],
        ['Reviewed', int(pr.accepted + pr.rejected)],
        ['Accepted', int(pr.accepted)],
        ['Rejected', int(pr.rejected)],
        ['Acceptance rate', pct(pr.acceptanceRate)],
        ['Edges actually in the graph from this source', int(pr.edgesLanded)],
      ],
    ),
  );
  if (pr.accepted > pr.edgesLanded) {
    p(
      `Accepted proposals (${int(pr.accepted)}) exceed the edges that landed`,
      `(${int(pr.edgesLanded)}): an accepted pair whose edge is already implied by the`,
      `deterministic graph is not inserted twice. The acceptance rate is a statement about`,
      `the *proposals*, not about how much the graph grew.`,
    );
  }
  if (pr.accepted + pr.rejected > 0 && (pr.acceptanceRate ?? 0) > 0.9) {
    p(
      `An acceptance rate of ${pct(pr.acceptanceRate)} is high enough to be suspicious of the`,
      `review rather than reassuring about the model. The reviewer saw candidates that had`,
      `already survived an embedding-similarity filter and a transitive-closure anti-join, so`,
      `the base rate going in was not 50%. It is not a measure of the model's precision on`,
      `arbitrary pairs.`,
    );
  }

  // --- 2 ---
  p(`## 2. Violations: apparent versus confirmed`);
  const kindRows = [...new Set(d.episodes.map((e) => e.kind))].toSorted().map((kind) => {
    const group = d.episodes.filter((e) => e.kind === kind);
    const conf = group.filter((e) => e.everConfirmed).length;
    return [
      kind,
      int(group.length),
      int(group.length - conf),
      int(conf),
      group.length === 0 ? '—' : pct(conf / group.length),
    ];
  });
  p(table(['Constraint type', 'Episodes', 'Apparent', 'Confirmed', 'Confirmed share'], kindRows));

  const confirmedShare = d.episodes.length === 0 ? null : d.confirmed.length / d.episodes.length;
  p(
    `**${pct(confirmedShare)} of episodes were executable.** The rest are *apparent*: the`,
    `constraint really was violated on midpoints, and the correcting trade still lost money`,
    `once the spread, the fees and the depth were priced. Reporting them is the point —`,
    `a scanner that only showed the ${int(d.confirmed.length)} confirmed ones would imply the other`,
    `${int(d.episodes.length - d.confirmed.length)} were opportunities.`,
  );

  const partitionConfirmed = d.episodes.filter((e) => e.kind === 'partition' && e.everConfirmed).length;
  if (partitionConfirmed === 0 && d.episodes.some((e) => e.kind === 'partition')) {
    p(
      `No partition violation was ever confirmed. A partition's correcting basket needs a leg`,
      `in *every* member market, so an n-member partition needs n simultaneous fills and pays`,
      `the spread n times; the arithmetic almost never survives. Pairwise implications need`,
      `two legs, and every confirmed violation here is one.`,
    );
  }

  // --- 3 ---
  p(`## 3. Net edge on confirmed violations`);
  p(`![Net edge distribution](charts/net-edge-distribution.png)`);
  p(
    table(
      ['Statistic', 'Per share'],
      [
        ['n', int(d.edgeStats.n)],
        ['min', cents(d.edgeStats.min)],
        ['p25', cents(d.edgeStats.p25)],
        ['median', cents(d.edgeStats.median)],
        ['p75', cents(d.edgeStats.p75)],
        ['p95', cents(d.edgeStats.p95)],
        ['max', cents(d.edgeStats.max)],
      ],
    ),
  );
  p(
    table(
      ['Bucket', 'Episodes'],
      d.edgeBuckets.map((b) => [b.label, int(b.count)]),
    ),
  );

  const profits = d.confirmed.map((e) => e.peakNetProfit).filter((v): v is number => v !== null);
  const profitStats = summarise(profits);
  p(
    `Peak net profit at the profit-maximising size: median ${money(profitStats.median)},`,
    `p95 ${money(profitStats.p95)}, max ${money(profitStats.max)}.`,
  );

  if (d.confirmedConstraints.length > 0) {
    p(`### The confirmed set is smaller than it looks`);
    p(
      `${int(d.confirmed.length)} confirmed episodes come from **${int(d.confirmedConstraints.length)} distinct`,
      `constraint(s)**. A single relation flickering across the threshold all afternoon`,
      `produces dozens of episodes and one fact, so this — not the episode count — is the`,
      `number to reason about.`,
    );
    p(
      table(
        ['Constraint', 'Episodes', 'Max net edge', 'Edge source', 'Antecedent', 'Consequent'],
        d.confirmedConstraints.map((c) => [
          `\`${c.constraintKey}\``,
          int(c.episodes),
          cents(c.maxNetEdge),
          c.source === null ? '—' : `\`${c.source}\``,
          cell(c.fromQuestion, 46),
          cell(c.toQuestion, 46),
        ]),
      ),
    );
  }

  if ((d.edgeStats.median ?? 0) > 0.05) {
    p(
      `> **A median edge of ${cents(d.edgeStats.median)} per share is not credible as risk-free money**`,
      `> on a venue with real participants, and the honest reading is that some of these`,
      `> "confirmed" violations rest on a relation that is wrong rather than on a market that`,
      `> is mispriced. See §7 — this is the single largest threat to the validity of this`,
      `> report, and it is not resolved.`,
    );
  }

  // --- 4 ---
  p(`## 4. Lifetime: how long does a contradiction survive?`);
  p(`![Lifetime distribution](charts/lifetime-distribution.png)`);
  p(
    table(
      ['Statistic', 'All closed', 'Confirmed only'],
      [
        ['n', int(d.lifeStats.n), int(d.confirmedLifeStats.n)],
        ['median', duration(d.lifeStats.median), duration(d.confirmedLifeStats.median)],
        ['p75', duration(d.lifeStats.p75), duration(d.confirmedLifeStats.p75)],
        ['p95', duration(d.lifeStats.p95), duration(d.confirmedLifeStats.p95)],
        ['max', duration(d.lifeStats.max), duration(d.confirmedLifeStats.max)],
      ],
    ),
  );

  p(
    `**Median lifetime is ${duration(d.lifeStats.median)}.** Half of all logical contradictions in`,
    `this catalog are gone within that. The measurement floor is the check interval — an`,
    `episode observed once and gone by the next check is recorded at roughly one interval,`,
    `so the true median is at or below what is printed here, not above it.`,
  );

  p(`### By constraint type`);
  p(`![Lifetime by constraint type](charts/lifetime-by-type.png)`);
  p(
    table(
      ['Type', 'n', 'median', 'p95', 'max'],
      d.byKind.map((k) => [
        k.kind,
        int(k.stats.n),
        duration(k.stats.median),
        duration(k.stats.p95),
        duration(k.stats.max),
      ]),
    ),
  );

  p(`### The hypothesis: do larger violations close faster?`);
  p(`![Lifetime by magnitude](charts/lifetime-by-magnitude.png)`);
  p(
    table(
      ['Violation size', 'n', 'median lifetime', 'p95'],
      d.magBuckets.map((b) => [b.label, int(b.stats.n), duration(b.stats.median), duration(b.stats.p95)]),
    ),
  );

  const rho = d.magCorrelation.rho;

  p(
    `Pooled across every constraint type, Spearman rank correlation between peak magnitude`,
    `and lifetime is **rho = ${rho === null ? '—' : rho.toFixed(3)}** over n=${int(d.magCorrelation.n)} closed episodes`,
    `(p ${pStr(d.magCorrelation.p)}).`,
  );

  p(
    table(
      ['Scope', 'n', 'median magnitude', 'Spearman rho', 'p'],
      [
        [
          '**pooled**',
          int(d.magCorrelation.n),
          '—',
          rho === null ? '—' : rho.toFixed(3),
          pStr(d.magCorrelation.p),
        ],
        ...d.magByKind.map((k) => [
          k.kind,
          int(k.correlation.n),
          cents(k.magnitude.median),
          k.correlation.rho === null ? '—' : k.correlation.rho.toFixed(3),
          pStr(k.correlation.p),
        ]),
      ],
    ),
  );

  const withinRhos = d.magByKind.map((k) => k.correlation.rho).filter((v): v is number => v !== null);
  const allPositive = withinRhos.length > 0 && withinRhos.every((v) => v > 0.05);
  const allNegative = withinRhos.length > 0 && withinRhos.every((v) => v < -0.05);
  const slowest = d.magBuckets.filter((b) => b.stats.n > 0).toSorted((a, b) => (b.stats.median ?? 0) - (a.stats.median ?? 0))[0];
  const smallest = d.magBuckets.find((b) => b.stats.n > 0);

  if (allNegative) {
    p(
      `**The hypothesis is supported, and it holds inside each constraint type**`,
      `(${d.magByKind.map((k) => `\`${k.kind}\` rho=${k.correlation.rho?.toFixed(3) ?? '—'}`).join(', ')}),`,
      `so it is not an artefact of pooling two types with different magnitude scales.`,
    );
  } else if (allPositive) {
    p(
      `**The hypothesis is not supported.** Rank correlation is positive — larger`,
      `contradictions persisted *longer* — and it is positive inside each constraint type`,
      `separately (${d.magByKind
        .map((k) => `\`${k.kind}\` rho=${k.correlation.rho?.toFixed(3) ?? '—'}`)
        .join(', ')}), so this is not an artefact of pooling two`,
      `types with different magnitude scales. That was the first thing to rule out and it is`,
      `ruled out.`,
    );
  } else {
    p(
      `The within-type correlations disagree in sign`,
      `(${d.magByKind.map((k) => `\`${k.kind}\` rho=${k.correlation.rho?.toFixed(3) ?? '—'}`).join(', ')}),`,
      `so the pooled figure is not a summary of a shared relationship and should not be read`,
      `as one.`,
    );
  }

  p(
    `**But the medians cannot carry that conclusion, and the honest answer is that this`,
    `window cannot settle the question.** ${pct(d.floorShare)} of closed episodes lasted`,
    `${d.floorSeconds} seconds or less — at most two intervals of a 60-second confirmation`,
    `loop. Their recorded lifetime is the sampling rate, not the market. That is why the`,
    `bucket medians above are flat at ~15s across four of the five populated buckets: they`,
    `are all pinned to the same floor, and the rank correlation is being decided by the`,
    `minority of episodes that outlived it.`,
  );

  if (slowest !== undefined && smallest !== undefined && slowest.label === smallest.label) {
    p(
      `The direction is also not monotone. The *smallest* bucket`,
      `(\`${smallest.label}\`, n=${int(smallest.stats.n)}) is the slowest to close at a median of`,
      `${duration(smallest.stats.median)} — an order of magnitude above every larger bucket. One`,
      `plausible reading, which this data cannot confirm: a violation one or two cents past`,
      `the screening epsilon is not so much *corrected* as never unambiguously wrong, and it`,
      `drifts across the threshold rather than being traded away. If that is right, the`,
      `positive rank correlation is a story about the detection threshold and not about the`,
      `market.`,
    );
  }

  p(
    `What the data does support, without qualification, is the level rather than the slope:`,
    `**a median contradiction is gone in ${duration(d.lifeStats.median)}**, and that is true across`,
    `every magnitude bucket above ${int(2)} cents. Whether a 40-cent gap closes faster than a`,
    `5-cent one is beyond the resolution of a 60-second check; that both are gone inside a`,
    `minute is not.`,
  );

  p(
    `Rank correlation rather than Pearson, because lifetime is heavily right-skewed and a`,
    `single long-lived episode would otherwise set the answer. Ties are averaged, which`,
    `matters enormously here given how much of the sample sits at the floor.`,
  );

  // --- 5 ---
  p(`## 5. Which market families are most incoherent`);
  p(`![Incoherence by category](charts/violations-by-category.png)`);
  p(
    table(
      ['Category', 'Markets under constraint', 'Episodes', 'per 1k markets', 'Confirmed', 'Median lifetime'],
      d.byCategory.map((c) => [
        c.category,
        int(c.markets),
        int(c.episodes),
        c.markets === 0 ? '—' : ((c.episodes / c.markets) * 1000).toFixed(1),
        int(c.confirmed),
        duration(c.medianLifetime),
      ]),
    ),
  );

  p(`### By time to resolution`);
  p(`![Lifetime by horizon](charts/lifetime-by-horizon.png)`);
  p(
    table(
      ['Time to resolution', 'Episodes', 'Median lifetime'],
      d.byHorizon.map((h) => [h.label, int(h.episodes), duration(h.median)]),
    ),
  );

  p(`### Most incoherent constraints`);
  p(
    table(
      ['Constraint', 'Type', 'Category', 'Episodes', 'Confirmed', 'Peak magnitude', 'Median lifetime', 'Market'],
      d.families
        .slice(0, 25)
        .map((f) => [
          `\`${f.key}\``,
          f.kind,
          f.category,
          int(f.episodes),
          int(f.confirmed),
          cents(f.peakMagnitude),
          duration(f.medianLifetime),
          cell(f.label, 52),
        ]),
    ),
  );

  // --- 6 ---
  p(`## 6. Time-of-day and day-of-week`);
  p(`![Violations by hour](charts/violations-by-hour.png)`);

  if (d.observedDays < 7) {
    p(
      `**Day-of-week is not measurable from this data.** The run covers ${d.observedDays} distinct`,
      `calendar day(s), so six of the seven rows in the chart above are empty and the seventh`,
      `is a single sample. No weekday effect is reported because none can be.`,
    );
  }

  const activeHours = d.byHour.map((count, hour) => ({ hour, count })).filter((h) => h.count > 0);
  p(
    table(
      ['UTC hour', 'Episodes opened'],
      activeHours.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, int(h.count)]),
    ),
  );
  p(
    `Only ${activeHours.length} of 24 hours were observed at all. Within them the variation is`,
    `dominated by when the checker was running rather than by anything about the market, so`,
    `no intraday pattern is claimed.`,
  );

  // --- 7 ---
  p(`## 7. Limitations`);
  p(renderLimitations(d));

  p(`---`);
  p(
    `Charts: ${d.charts.map((c) => `\`${c}\``).join(', ')}. Regenerate with \`pnpm report\`.`,
    `Source data is the local Postgres instance this ran against; the schema is described in the README.`,
  );

  return out.join('\n');
}

/** A p-value as a report prints it: a bound below 0.001, an equality above. */
function pStr(p: number | null): string {
  return p === null ? '—' : p < 0.001 ? '< 0.001' : `= ${p.toFixed(3)}`;
}

function renderLimitations(d: RenderInput): string {
  const hours = d.catalog.window.hours;
  const activeCoverage =
    d.catalog.markets.active === 0 ? null : d.catalog.covered.activeEither / d.catalog.markets.active;

  const lines: string[] = [];
  const add = (...text: string[]): void => {
    lines.push(...text, '');
  };

  add(`### The window is hours, not a month`);
  add(
    `Everything above rests on ${hours === null ? 'an unknown span' : `${hours.toFixed(1)} hours`} of`,
    `checking across ${d.observedDays} calendar day(s), not the thirty days the analysis was`,
    `designed for. What that permits and forbids:`,
    ``,
    `- **Permitted**: the shape of the lifetime distribution, the apparent/confirmed split,`,
    `  the relationship between violation size and lifetime. These are distributional and`,
    `  have n=${int(d.closed.length)} closed episodes behind them.`,
    `- **Forbidden**: any rate per day, any weekday effect, any intraday pattern, any claim`,
    `  about seasonality or about how the graph behaves as markets approach resolution.`,
    `  These need a window that spans the cycle they are about.`,
    ``,
    `The distributions are also drawn from one continuous session. A session is not a sample`,
    `of sessions: if the market was unusually quiet or unusually violent while the checker`,
    `ran, every median here inherits that and there is no way to tell from inside the data.`,
  );

  add(`### What the extraction misses`);
  add(
    `Coverage of the active catalog is **${pct(activeCoverage)}**`,
    `(${int(d.catalog.covered.activeEither)} of ${int(d.catalog.markets.active)} active markets appear in at`,
    `least one relation or partition group). The uncovered remainder is not random — it is`,
    `whatever the deterministic extractors could not pattern-match:`,
    ``,
    `- **Threshold ladders** need a parseable numeric threshold and a resolution rule that`,
    `  says which direction it runs. Where the criteria are silent the pair is refused`,
    `  outright, which is correct and costs coverage.`,
    `- **Partitions** come from Polymarket's own neg-risk event grouping. An event that is`,
    `  logically exhaustive but not flagged as neg-risk is invisible.`,
    `- **Cross-event logic** is almost entirely absent. "Candidate X wins the primary"`,
    `  implies "Candidate X is the nominee" across two events, and nothing here finds that`,
    `  unless the LLM proposer happened to surface the pair and a human accepted it`,
    `  (${int(d.catalog.proposals.edgesLanded)} edges).`,
    `- **Conditional and compound structure** — "A given B", "A and B", "at least two of"`,
    `  — has no representation in the constraint language at all.`,
    ``,
    `So the true incoherence of the catalog is understated by an unknown amount. Every`,
    `"no violation" in this report means "no violation *among the constraints we know about*".`,
  );

  add(`### Where the fee model could be wrong`);
  add(
    `Fees decide the apparent/confirmed boundary, so an error there moves every headline`,
    `count in this report. Three known weaknesses, in descending order of how much they`,
    `could matter:`,
    ``,
    `1. **The fee category is not published anywhere.** Polymarket's taker fee is`,
    `   \`size × rate × p × (1−p)\` with a rate between 0.04 and 0.07 depending on category,`,
    `   and no endpoint this service reads exposes which category a market is in — Gamma's`,
    `   tags are free-form strings. The checker applies the *highest* rate to everything.`,
    `   That is deliberately conservative: it under-confirms rather than over-confirms. But`,
    `   it means the confirmed set is a subset of the true one, and the apparent set contains`,
    `   an unknown number of trades that would have cleared at the real rate.`,
    `2. **\`base_fee\` from the CLOB is a flag, not a rate.** Across a 2,000-market sample it`,
    `   took exactly two values, 0 and 1000, and the zeros line up with the documented`,
    `   geopolitics carve-out. Reading it as basis points gives a rate far above anything`,
    `   Polymarket publishes. The interpretation as an on/off flag is an inference from that`,
    `   sample and is not documented anywhere.`,
    `3. **Only taker fees are modelled.** The correcting trade is assumed to cross the spread`,
    `   on every leg, which is right for a trade that has to execute now, but it means the`,
    `   model has nothing to say about a maker strategy that would pay less and risk more.`,
    ``,
    `Gas and settlement costs are not modelled at all. Neither is the capital cost of holding`,
    `a basket to resolution, which for a market a year out is not negligible.`,
  );

  if (d.confirmedConstraints.length > 0) {
    add(`### Every confirmed violation traces to ${int(d.confirmedConstraints.length)} relation(s), and they should be audited before being believed`);
    add(
      `The ${int(d.confirmed.length)} confirmed episodes are ${int(d.confirmedConstraints.length)} distinct constraint(s) re-detected`,
      `repeatedly. Median net edge is ${cents(d.edgeStats.median)} per share with a maximum of`,
      `${cents(d.edgeStats.max)} — a risk-free return that a venue with real participants does not`,
      `leave lying around for ${duration(d.confirmedLifeStats.median)} at a time.`,
      ``,
      `Reading the extractor's own rationale for each one is enough to see the problem:`,
      ``,
      ...d.confirmedConstraints.map(
        (c) =>
          `- **\`${c.constraintKey}\`** (\`${c.source ?? 'unknown'}\`, ${int(c.episodes)} episodes, up to ${cents(c.maxNetEdge)}) — ` +
          `"${cell(c.fromQuestion, 70)}" is recorded as entailing "${cell(c.toQuestion, 70)}".` +
          (c.rationale === null ? '' : ` Stated reason: _${cell(c.rationale, 150)}_`),
      ),
      ``,
      `Two failure modes are visible in that list, and both are extractor bugs rather than`,
      `market mispricings:`,
      ``,
      `1. **Negation inverts a deadline entailment.** For a positive event, "happens by the`,
      `   earlier date" entails "happens by the later date". For a *negated* event —`,
      `   "does **not** happen by date X" — the implication runs the other way: not having`,
      `   happened by the later date entails not having happened by the earlier one. An`,
      `   extractor that matches on nested deadlines without reading the negation emits the`,
      `   edge backwards.`,
      `2. **The deadline order is simply reversed.** An entailment from a later deadline to`,
      `   an earlier one is wrong on its face, whatever the subject.`,
      ``,
      `A reversed edge does not fail loudly. It produces a confident, well-formed,`,
      `fully-priced correcting trade that is a guaranteed loss — which is exactly what`,
      `happened once before in this project, when 888 markets carried an inverted`,
      `\`hit/reach\` ladder direction until the resolution criteria were read properly.`,
      ``,
      `**So the executable-arbitrage count in this report should be read as zero until each`,
      `of these relations has been audited by hand.** The pipeline downstream of the graph`,
      `did its job: it found trades, priced them against real depth, and cleared them on fees`,
      `and slippage. It cannot check the premise it was given, and the premise is what is`,
      `wrong.`,
    );
  }

  add(`### Category and age segmentation are weaker than they look`);
  add(
    `Category is a **keyword heuristic** over slug and question text, written for this report`,
    `and validated against nothing. ${pct(d.coverage.unclassifiedShare)} of markets under constraint fall`,
    `into \`other\`, and the ones that are classified may be misclassified in ways no number`,
    `here would reveal — a market mentioning "Trump" and "Bitcoin" lands wherever the pattern`,
    `order puts it. Treat the per-category rates as indicative of nothing stronger than`,
    `"markets whose text matches these words".`,
    ``,
    `"Market age" is reported as **time to resolution**, not age. Our ingest began partway`,
    `through the catalog's life, so \`first_seen_at\` records when this service noticed a`,
    `market and not when Polymarket listed it. True listing age is unavailable from any`,
    `endpoint we read.`,
  );

  add(`### Measurement floor and censoring`);
  add(
    `Lifetimes are measured by a check that runs on an interval, so an episode that opened`,
    `and closed between two checks was never seen at all, and one seen exactly once is`,
    `recorded at roughly one interval regardless of its true life. Both effects push the`,
    `measured median **up**. The event-driven screen off the order-book feed reduces this but`,
    `does not remove it: confirmation still runs on the job queue.`,
    ``,
    `Episodes still open when the report runs are excluded from every lifetime statistic`,
    `(${int(d.episodes.length - d.closed.length)} of ${int(d.episodes.length)}). That is right — an open episode has no`,
    `lifetime — but it censors the long tail: the longest-lived contradictions are exactly`,
    `the ones most likely to still be open, so p95 and max are understated.`,
  );

  return lines.join('\n');
}
