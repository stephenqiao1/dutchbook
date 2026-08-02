import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';

/**
 * Every measurement the report makes.
 *
 * Kept apart from the prose so the numbers can be checked without reading the
 * narrative, and so the narrative cannot quietly disagree with them: the
 * markdown is generated from these structures and never restates a figure it
 * did not receive.
 *
 * Two conventions throughout:
 *
 * - **Lifetime means closed episodes only.** An open violation has no lifetime,
 *   and counting its age so far pulls every median toward whatever happens to
 *   be open at the moment the report runs.
 * - **Magnitude and net edge are different quantities.** Magnitude is how far
 *   the constraint is from holding, in probability, and exists for every
 *   violation. Net edge is what a correcting trade actually earns per share
 *   after fees and slippage, and exists only for confirmed ones.
 */

type Database = PostgresJsDatabase<typeof schema>;

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const iso = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined ? null : new Date(v).toISOString();

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export interface Summary {
  readonly n: number;
  readonly min: number | null;
  readonly p25: number | null;
  readonly median: number | null;
  readonly p75: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export function summarise(values: readonly number[]): Summary {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
    mean: sorted.length === 0 ? null : sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

/** 1-based ranks, averaged across ties. */
function rankOf(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).toSorted((a, b) => a[0] - b[0]);
  const ranks = Array.from({ length: values.length }, () => 0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k]![1]] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation, with average ranks for ties.
 *
 * Rank rather than Pearson because neither lifetime nor magnitude is remotely
 * normal — lifetimes span seconds to hours with a heavy right tail, and one
 * long-lived outlier would otherwise set the answer. Ties matter here too: a
 * great many violations close in exactly one check interval.
 */
export function spearman(pairs: readonly (readonly [number, number])[]): {
  rho: number | null;
  n: number;
  /** Two-sided, from the large-sample normal approximation. Meaningless below ~10 pairs. */
  p: number | null;
} {
  const n = pairs.length;
  if (n < 3) return { rho: null, n, p: null };

  const xr = rankOf(pairs.map((p) => p[0]));
  const yr = rankOf(pairs.map((p) => p[1]));
  const mx = xr.reduce((s, v) => s + v, 0) / n;
  const my = yr.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xr[i] ?? 0) - mx;
    const dy = (yr[i] ?? 0) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return { rho: null, n, p: null };

  const rho = cov / Math.sqrt(vx * vy);
  // t = rho * sqrt((n-2)/(1-rho^2)), then a normal approximation to its tail.
  const t = Math.abs(rho) * Math.sqrt((n - 2) / Math.max(1e-12, 1 - rho * rho));
  return { rho, n, p: 2 * (1 - normalCdf(t)) };
}

/** Abramowitz & Stegun 7.1.26, good to ~1e-7 — far tighter than these data warrant. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.327_591_1 * x);
  const y =
    1 -
    ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736) * t +
      0.254_829_592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

/**
 * Category, inferred from the market slug and question.
 *
 * Polymarket publishes no category on any endpoint this service reads — Gamma's
 * tags are free-form strings like `Fed`, `Economic Policy`, `Jerome Powell` —
 * so this is a keyword heuristic with no ground truth behind it and no
 * validation set. It is reported as such. The `other` share is the honest
 * measure of how much it fails to place.
 *
 * Order matters: a market can match several patterns, and the first wins.
 * Sports leads because "Lakers vs. Celtics" contains no politics keyword but
 * election markets frequently mention a state whose name is also a team's.
 */
const CATEGORY_PATTERNS: readonly (readonly [string, RegExp])[] = [
  [
    'sports',
    /\b(nba|nfl|mlb|nhl|ncaa|epl|uefa|fifa|ufc|atp|wta|f1|formula 1|premier league|la liga|serie a|bundesliga|super bowl|world cup|stanley cup|world series|moneyline|spread|vs\.?|game|match|tournament|playoff|championship|soccer|football|basketball|baseball|hockey|tennis|golf|boxing|cricket)\b/i,
  ],
  [
    'crypto',
    /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|crypto|altcoin|stablecoin|defi|nft|binance|coinbase|satoshi|halving|memecoin)\b/i,
  ],
  [
    'economics',
    /\b(fed|fomc|federal reserve|powell|interest rate|rate cut|rate hike|inflation|cpi|pce|gdp|unemployment|jobs report|payroll|recession|treasury|yield|ecb|boe|boj|tariff|debt ceiling|s&p|nasdaq|dow)\b/i,
  ],
  [
    'politics',
    /\b(election|president|presidential|senate|senator|congress|house|parliament|prime minister|chancellor|governor|mayor|nominee|nomination|primary|caucus|ballot|impeach|cabinet|secretary of|supreme court|referendum|coalition|party leader|approval rating|resign|ceasefire|sanction|nato|un security)\b/i,
  ],
];

export type Category = 'sports' | 'crypto' | 'economics' | 'politics' | 'other';

export function classify(question: string | null, slug: string | null): Category {
  const text = `${slug ?? ''} ${question ?? ''}`;
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category as Category;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// 1. Catalog
// ---------------------------------------------------------------------------

export interface CatalogStats {
  readonly markets: { total: number; active: number; closed: number; missing: number };
  readonly covered: { inRelation: number; inGroup: number; either: number; activeEither: number };
  readonly edgesBySource: { source: string; type: string; count: number }[];
  readonly groupsBySource: { source: string; count: number }[];
  readonly proposals: {
    total: number;
    accepted: number;
    rejected: number;
    pending: number;
    acceptanceRate: number | null;
    edgesLanded: number;
  };
  readonly window: { from: string | null; to: string | null; hours: number | null };
}

export async function readCatalog(database: Database = db): Promise<CatalogStats> {
  const [markets] = await database.execute<{
    total: number;
    active: number;
    closed: number;
    missing: number;
  }>(sql`
    select count(*)::int total,
           count(*) filter (where missing_since is null and coalesce(closed,false)=false)::int active,
           count(*) filter (where coalesce(closed,false))::int closed,
           count(*) filter (where missing_since is not null)::int missing
    from markets
  `);

  const [covered] = await database.execute<{
    in_relation: number;
    in_group: number;
    either: number;
    active_either: number;
  }>(sql`
    with r as (select from_condition_id c from relations union select to_condition_id from relations),
         g as (select condition_id c from relation_group_members),
         u as (select c from r union select c from g)
    select (select count(*)::int from r) in_relation,
           (select count(*)::int from g) in_group,
           (select count(*)::int from u) either,
           (select count(*)::int from u join markets m on m.condition_id = u.c
              where m.missing_since is null and coalesce(m.closed,false)=false) active_either
  `);

  const edges = await database.execute<{ source: string; type: string; count: number }>(sql`
    select source, type, count(*)::int count from relations group by 1, 2 order by count desc
  `);

  const groups = await database.execute<{ source: string; count: number }>(sql`
    select source, count(*)::int count from relation_groups group by 1 order by count desc
  `);

  const [proposals] = await database.execute<{
    total: number;
    accepted: number;
    rejected: number;
    pending: number;
  }>(sql`
    select count(*)::int total,
           count(*) filter (where status = 'accepted')::int accepted,
           count(*) filter (where status = 'rejected')::int rejected,
           count(*) filter (where status not in ('accepted','rejected'))::int pending
    from relation_proposals
  `);

  const [landed] = await database.execute<{ n: number }>(sql`
    select count(*)::int n from relations where source = 'llm_reviewed'
  `);

  const [window] = await database.execute<{ lo: Date | null; hi: Date | null }>(sql`
    select min(detected_at) lo, max(coalesce(resolved_at, last_checked_at)) hi from violations
  `);

  const reviewed = (proposals?.accepted ?? 0) + (proposals?.rejected ?? 0);
  const hours =
    window?.lo && window?.hi
      ? (new Date(window.hi).getTime() - new Date(window.lo).getTime()) / 3_600_000
      : null;

  return {
    markets: {
      total: markets?.total ?? 0,
      active: markets?.active ?? 0,
      closed: markets?.closed ?? 0,
      missing: markets?.missing ?? 0,
    },
    covered: {
      inRelation: covered?.in_relation ?? 0,
      inGroup: covered?.in_group ?? 0,
      either: covered?.either ?? 0,
      activeEither: covered?.active_either ?? 0,
    },
    edgesBySource: edges.map((r) => ({ source: r.source, type: r.type, count: r.count })),
    groupsBySource: groups.map((r) => ({ source: r.source, count: r.count })),
    proposals: {
      total: proposals?.total ?? 0,
      accepted: proposals?.accepted ?? 0,
      rejected: proposals?.rejected ?? 0,
      pending: proposals?.pending ?? 0,
      acceptanceRate: reviewed === 0 ? null : (proposals?.accepted ?? 0) / reviewed,
      edgesLanded: landed?.n ?? 0,
    },
    window: { from: iso(window?.lo), to: iso(window?.hi), hours },
  };
}

// ---------------------------------------------------------------------------
// 2-4, 6. Violations
// ---------------------------------------------------------------------------

/** One episode, flattened. Everything downstream works from this array. */
export interface Episode {
  readonly id: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly everConfirmed: boolean;
  readonly detectedAt: Date;
  readonly resolvedAt: Date | null;
  readonly lifetimeSeconds: number | null;
  readonly peakMagnitude: number | null;
  readonly peakNetEdge: number | null;
  readonly peakNetProfit: number | null;
  readonly peakSize: number | null;
  readonly conditionIds: string[];
  readonly question: string | null;
  readonly slug: string | null;
  readonly category: Category;
  /** Days from the report run to the market's resolution date. Null when unknown. */
  readonly daysToResolution: number | null;
}

export async function readEpisodes(database: Database = db, limit = 200_000): Promise<Episode[]> {
  const rows = await database.execute<{
    id: number;
    constraint_key: string;
    kind: string;
    ever_confirmed: boolean;
    detected_at: Date;
    resolved_at: Date | null;
    lifetime_seconds: string | null;
    peak_magnitude: string | null;
    peak_net_edge: string | null;
    peak_net_profit: string | null;
    peak_size: string | null;
    condition_ids: string[];
    question: string | null;
    slug: string | null;
    days_to_resolution: string | null;
  }>(sql`
    select v.id, v.constraint_key, v.kind, v.ever_confirmed, v.detected_at, v.resolved_at,
           extract(epoch from (v.resolved_at - v.detected_at)) lifetime_seconds,
           v.peak_magnitude, v.peak_net_edge, v.peak_net_profit, v.peak_size, v.condition_ids,
           m.question, m.slug,
           extract(epoch from (m.end_date - now())) / 86400 days_to_resolution
    from violations v
    left join markets m on m.condition_id = (v.condition_ids ->> 0)
    order by v.detected_at
    limit ${limit}
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    constraintKey: r.constraint_key,
    kind: r.kind,
    everConfirmed: r.ever_confirmed,
    detectedAt: new Date(r.detected_at),
    resolvedAt: r.resolved_at === null ? null : new Date(r.resolved_at),
    lifetimeSeconds: num(r.lifetime_seconds),
    peakMagnitude: num(r.peak_magnitude),
    peakNetEdge: num(r.peak_net_edge),
    peakNetProfit: num(r.peak_net_profit),
    peakSize: num(r.peak_size),
    conditionIds: r.condition_ids ?? [],
    question: r.question,
    slug: r.slug,
    category: classify(r.question, r.slug),
    daysToResolution: num(r.days_to_resolution),
  }));
}

export interface Bucket {
  readonly label: string;
  readonly from: number;
  readonly to: number | null;
  readonly count: number;
}

export function bucketise(
  values: readonly number[],
  edges: readonly { label: string; from: number; to: number | null }[],
): Bucket[] {
  return edges.map((edge) => ({
    label: edge.label,
    from: edge.from,
    to: edge.to,
    count: values.filter((v) => v >= edge.from && (edge.to === null || v < edge.to)).length,
  }));
}

/**
 * Lifetime buckets spanning seconds to a day.
 *
 * The first boundary is deliberately the check interval. Anything below it was
 * observed exactly once, so its lifetime is an artefact of the sampling rate
 * rather than a measurement — a distinction the report has to make out loud.
 */
export const LIFETIME_BUCKETS = [
  { label: '<60s', from: 0, to: 60 },
  { label: '1-5m', from: 60, to: 300 },
  { label: '5-15m', from: 300, to: 900 },
  { label: '15-60m', from: 900, to: 3_600 },
  { label: '1-6h', from: 3_600, to: 21_600 },
  { label: '6-24h', from: 21_600, to: 86_400 },
  { label: '>24h', from: 86_400, to: null },
] as const;

export const EDGE_BUCKETS = [
  { label: '0-2c', from: 0, to: 0.02 },
  { label: '2-5c', from: 0.02, to: 0.05 },
  { label: '5-10c', from: 0.05, to: 0.1 },
  { label: '10-20c', from: 0.1, to: 0.2 },
  { label: '20-40c', from: 0.2, to: 0.4 },
  { label: '>40c', from: 0.4, to: null },
] as const;

export const MAGNITUDE_BUCKETS = [
  { label: '0.5-1c', from: 0.005, to: 0.01 },
  { label: '1-2c', from: 0.01, to: 0.02 },
  { label: '2-5c', from: 0.02, to: 0.05 },
  { label: '5-10c', from: 0.05, to: 0.1 },
  { label: '10-25c', from: 0.1, to: 0.25 },
  { label: '>25c', from: 0.25, to: null },
] as const;

// ---------------------------------------------------------------------------
// 5. Families
// ---------------------------------------------------------------------------

export interface FamilyRow {
  readonly key: string;
  readonly kind: string;
  readonly label: string | null;
  readonly slug: string | null;
  readonly category: Category;
  readonly episodes: number;
  readonly confirmed: number;
  readonly medianLifetime: number | null;
  readonly peakMagnitude: number | null;
  readonly daysToResolution: number | null;
}

/**
 * Families ranked by how often they broke.
 *
 * Counted per constraint, not per episode of the same constraint reopening:
 * a single relation flickering across epsilon a hundred times is one incoherent
 * pair observed a hundred times, and ranking on the raw episode count would put
 * whatever is noisiest at the top rather than whatever is most broken.
 */
export function rankFamilies(episodes: readonly Episode[]): FamilyRow[] {
  const byKey = new Map<string, Episode[]>();
  for (const episode of episodes) {
    const list = byKey.get(episode.constraintKey);
    if (list === undefined) byKey.set(episode.constraintKey, [episode]);
    else list.push(episode);
  }

  const rows: FamilyRow[] = [];
  for (const [key, group] of byKey) {
    const first = group[0]!;
    const lifetimes = group
      .map((e) => e.lifetimeSeconds)
      .filter((v): v is number => v !== null)
      .toSorted((a, b) => a - b);

    rows.push({
      key,
      kind: first.kind,
      label: first.question,
      slug: first.slug,
      category: first.category,
      episodes: group.length,
      confirmed: group.filter((e) => e.everConfirmed).length,
      medianLifetime: quantile(lifetimes, 0.5),
      peakMagnitude: group.reduce<number | null>(
        (max, e) =>
          e.peakMagnitude === null ? max : max === null || e.peakMagnitude > max ? e.peakMagnitude : max,
        null,
      ),
      daysToResolution: first.daysToResolution,
    });
  }

  return rows.toSorted((a, b) => b.episodes - a.episodes || (b.peakMagnitude ?? 0) - (a.peakMagnitude ?? 0));
}

/**
 * The distinct constraints behind the confirmed set, with their provenance.
 *
 * The count of confirmed *episodes* flatters itself: one constraint flickering
 * across the threshold all afternoon produces dozens of episodes and one fact.
 * This is the denominator that matters, and it is the first thing to look at
 * before believing any executable-arbitrage number.
 */
export interface ConfirmedConstraint {
  readonly constraintKey: string;
  readonly episodes: number;
  readonly maxNetEdge: number | null;
  readonly source: string | null;
  readonly rationale: string | null;
  readonly fromQuestion: string | null;
  readonly toQuestion: string | null;
}

export async function readConfirmedConstraints(database: Database = db): Promise<ConfirmedConstraint[]> {
  const rows = await database.execute<{
    constraint_key: string;
    episodes: number;
    max_net_edge: string | null;
    source: string | null;
    rationale: string | null;
    from_question: string | null;
    to_question: string | null;
  }>(sql`
    with c as (
      select v.constraint_key,
             count(*)::int episodes,
             max(v.peak_net_edge) max_net_edge,
             -- implies:1234 and complement:1234 both name a relations.id.
             nullif(split_part(v.constraint_key, ':', 2), '')::bigint rel_id
      from violations v
      where v.ever_confirmed and v.kind <> 'partition'
      group by v.constraint_key
    )
    select c.constraint_key, c.episodes, c.max_net_edge,
           r.source, r.rationale, f.question from_question, t.question to_question
    from c
    left join relations r on r.id = c.rel_id
    left join markets f on f.condition_id = r.from_condition_id
    left join markets t on t.condition_id = r.to_condition_id
    order by c.episodes desc, c.max_net_edge desc nulls last
  `);

  return rows.map((r) => ({
    constraintKey: r.constraint_key,
    episodes: r.episodes,
    maxNetEdge: num(r.max_net_edge),
    source: r.source,
    rationale: r.rationale,
    fromQuestion: r.from_question,
    toQuestion: r.to_question,
  }));
}

// ---------------------------------------------------------------------------
// 7. Coverage, for the limitations section
// ---------------------------------------------------------------------------

export interface CoverageStats {
  readonly activeMarkets: number;
  readonly activeCovered: number;
  readonly screenable: number;
  readonly quoted: number;
  readonly constraintsLoaded: number;
  readonly categoryMix: { category: Category; markets: number }[];
  readonly unclassifiedShare: number | null;
}

export async function readCoverage(database: Database = db): Promise<CoverageStats> {
  const [counts] = await database.execute<{
    active: number;
    covered: number;
    quoted: number;
  }>(sql`
    with u as (
      select from_condition_id c from relations union select to_condition_id from relations
      union select condition_id from relation_group_members
    )
    select (select count(*)::int from markets where missing_since is null and coalesce(closed,false)=false) active,
           (select count(*)::int from u join markets m on m.condition_id = u.c
              where m.missing_since is null and coalesce(m.closed,false)=false) covered,
           (select count(*)::int from market_quotes q join markets m on m.condition_id = q.condition_id
              where m.missing_since is null and coalesce(m.closed,false)=false and q.yes_price is not null) quoted
  `);

  const [constraints] = await database.execute<{ n: number }>(sql`
    select (
      (select count(*)::int from relations r
         join markets f on f.condition_id = r.from_condition_id
         join markets t on t.condition_id = r.to_condition_id
        where f.missing_since is null and t.missing_since is null
          and coalesce(f.closed,false)=false and coalesce(t.closed,false)=false)
      +
      (select count(*)::int from relation_groups where type = 'partition')
    ) n
  `);

  // Classified in the database would mean shipping the regexes to SQL; the
  // sample is pulled and classified in one place instead, so the report and the
  // episodes agree by construction.
  const sample = await database.execute<{ question: string | null; slug: string | null }>(sql`
    with u as (
      select from_condition_id c from relations union select to_condition_id from relations
      union select condition_id from relation_group_members
    )
    select m.question, m.slug from u join markets m on m.condition_id = u.c
    where m.missing_since is null and coalesce(m.closed,false)=false
  `);

  const mix = new Map<Category, number>();
  for (const row of sample) {
    const category = classify(row.question, row.slug);
    mix.set(category, (mix.get(category) ?? 0) + 1);
  }

  return {
    activeMarkets: counts?.active ?? 0,
    activeCovered: counts?.covered ?? 0,
    screenable: constraints?.n ?? 0,
    quoted: counts?.quoted ?? 0,
    constraintsLoaded: constraints?.n ?? 0,
    categoryMix: [...mix.entries()]
      .map(([category, markets]) => ({ category, markets }))
      .toSorted((a, b) => b.markets - a.markets),
    unclassifiedShare: sample.length === 0 ? null : (mix.get('other') ?? 0) / sample.length,
  };
}
