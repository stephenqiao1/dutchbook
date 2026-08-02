import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';

/**
 * Every read the dashboard performs.
 *
 * Separated from the routes because the routes are the *public* surface and
 * these are the shapes it promises. `/api/violations` and `/api/relations` exist
 * so someone else can build on this, which makes their field names an interface
 * rather than an implementation detail.
 *
 * Two rules run through all of it:
 *
 * - **Nothing here is unbounded.** Every query has a `limit`, because this is
 *   served without authentication and a single request must not be able to ask
 *   Postgres for three hundred thousand rows.
 * - **Numerics come back as strings** from postgres.js — `numeric` has no safe
 *   JavaScript representation, so the driver refuses to guess. They are coerced
 *   here, once, rather than in four different places in the browser.
 */

type Database = PostgresJsDatabase<typeof schema>;

/** `numeric` columns arrive as strings; null stays null rather than becoming 0. */
function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface RelationSourceCount {
  readonly source: string;
  readonly type: string;
  readonly count: number;
}

export interface OpenViolation {
  readonly id: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly status: string;
  readonly detectedAt: string | null;
  readonly ageSeconds: number | null;
  readonly netEdge: number | null;
  readonly netProfit: number | null;
  readonly size: number | null;
  readonly question: string | null;
  readonly slug: string | null;
  readonly members: number;
}

export interface StatusPayload {
  readonly markets: { tracked: number; missing: number; closed: number };
  readonly relations: { edges: number; groups: number; bySource: RelationSourceCount[] };
  readonly violations: {
    openConfirmed: number;
    openApparent: number;
    everConfirmed: number;
    total: number;
    medianLifetimeSeconds: number | null;
  };
  readonly open: OpenViolation[];
  readonly generatedAt: string;
}

export async function readStatus(database: Database = db, openLimit = 50): Promise<StatusPayload> {
  const [markets] = await database.execute<{ tracked: number; missing: number; closed: number }>(sql`
    select
      count(*) filter (where missing_since is null and coalesce(closed, false) = false)::int tracked,
      count(*) filter (where missing_since is not null)::int missing,
      count(*) filter (where coalesce(closed, false))::int closed
    from markets
  `);

  const bySource = await database.execute<{ source: string; type: string; count: number }>(sql`
    select source, type, count(*)::int count from relations group by source, type
    union all
    select source, 'partition-group' as type, count(*)::int from relation_groups group by source
    order by count desc
  `);

  const [groups] = await database.execute<{ n: number }>(
    sql`select count(*)::int n from relation_groups`,
  );

  const [counts] = await database.execute<{
    open_confirmed: number;
    open_apparent: number;
    ever_confirmed: number;
    total: number;
  }>(sql`
    select
      count(*) filter (where resolved_at is null and ever_confirmed)::int open_confirmed,
      count(*) filter (where resolved_at is null and not ever_confirmed)::int open_apparent,
      count(*) filter (where ever_confirmed)::int ever_confirmed,
      count(*)::int total
    from violations
  `);

  // Median over *closed confirmed* episodes only. An open one has no lifetime
  // yet, and including it as "however long so far" would drag the median toward
  // whatever happens to be open at this instant.
  const [median] = await database.execute<{ seconds: number | null }>(sql`
    select percentile_cont(0.5) within group (
      order by extract(epoch from (resolved_at - detected_at))
    ) seconds
    from violations
    where resolved_at is not null and ever_confirmed
  `);

  const open = await readOpenViolations(database, openLimit);

  return {
    markets: {
      tracked: markets?.tracked ?? 0,
      missing: markets?.missing ?? 0,
      closed: markets?.closed ?? 0,
    },
    relations: {
      edges: bySource.filter((r) => r.type !== 'partition-group').reduce((sum, r) => sum + r.count, 0),
      groups: groups?.n ?? 0,
      bySource: bySource.map((r) => ({ source: r.source, type: r.type, count: r.count })),
    },
    violations: {
      openConfirmed: counts?.open_confirmed ?? 0,
      openApparent: counts?.open_apparent ?? 0,
      everConfirmed: counts?.ever_confirmed ?? 0,
      total: counts?.total ?? 0,
      medianLifetimeSeconds: num(median?.seconds ?? null),
    },
    open,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Violations still open, worst edge first.
 *
 * Confirmed ones first regardless of edge: an executable violation matters more
 * than a larger one that nothing can be done about, and sorting purely by edge
 * would bury it under apparent noise.
 */
export async function readOpenViolations(database: Database = db, limit = 50): Promise<OpenViolation[]> {
  const rows = await database.execute<{
    id: number;
    constraint_key: string;
    kind: string;
    status: string;
    detected_at: Date;
    age_seconds: string;
    peak_net_edge: string | null;
    peak_net_profit: string | null;
    peak_size: string | null;
    members: number;
    question: string | null;
    slug: string | null;
  }>(sql`
    select v.id, v.constraint_key, v.kind, v.status, v.detected_at,
           extract(epoch from (now() - v.detected_at)) age_seconds,
           v.peak_net_edge, v.peak_net_profit, v.peak_size,
           jsonb_array_length(v.condition_ids) members,
           m.question, m.slug
    from violations v
    left join markets m on m.condition_id = (v.condition_ids ->> 0)
    where v.resolved_at is null
    order by v.ever_confirmed desc, v.peak_net_edge desc nulls last, v.detected_at desc
    limit ${limit}
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    constraintKey: row.constraint_key,
    kind: row.kind,
    status: row.status,
    detectedAt: iso(row.detected_at),
    ageSeconds: num(row.age_seconds),
    netEdge: num(row.peak_net_edge),
    netProfit: num(row.peak_net_profit),
    size: num(row.peak_size),
    question: row.question,
    slug: row.slug,
    members: Number(row.members ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Violation history
// ---------------------------------------------------------------------------

export interface ViolationRow {
  readonly id: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly status: string;
  readonly everConfirmed: boolean;
  readonly detectedAt: string | null;
  readonly resolvedAt: string | null;
  /** Seconds. For an open episode this is age so far, and `open` says which. */
  readonly lifetimeSeconds: number | null;
  readonly open: boolean;
  readonly peakNetEdge: number | null;
  readonly peakNetProfit: number | null;
  readonly peakSize: number | null;
  readonly peakMagnitude: number | null;
  readonly reason: string | null;
  readonly members: number;
  readonly question: string | null;
  readonly slug: string | null;
}

export interface ViolationQuery {
  readonly limit?: number;
  readonly status?: 'all' | 'open' | 'closed' | 'confirmed' | 'apparent';
}

export const MAX_VIOLATION_ROWS = 500;

export async function readViolations(
  database: Database = db,
  query: ViolationQuery = {},
): Promise<{ violations: ViolationRow[]; total: number }> {
  const limit = Math.min(Math.max(1, query.limit ?? MAX_VIOLATION_ROWS), MAX_VIOLATION_ROWS);
  const status = query.status ?? 'all';

  const filter =
    status === 'open'
      ? sql`where v.resolved_at is null`
      : status === 'closed'
        ? sql`where v.resolved_at is not null`
        : status === 'confirmed'
          ? sql`where v.ever_confirmed`
          : status === 'apparent'
            ? sql`where not v.ever_confirmed`
            : sql``;

  const rows = await database.execute<{
    id: number;
    constraint_key: string;
    kind: string;
    status: string;
    ever_confirmed: boolean;
    detected_at: Date;
    resolved_at: Date | null;
    lifetime_seconds: string | null;
    peak_net_edge: string | null;
    peak_net_profit: string | null;
    peak_size: string | null;
    peak_magnitude: string | null;
    reason: string | null;
    members: number;
    question: string | null;
    slug: string | null;
  }>(sql`
    select v.id, v.constraint_key, v.kind, v.status, v.ever_confirmed,
           v.detected_at, v.resolved_at,
           extract(epoch from (coalesce(v.resolved_at, now()) - v.detected_at)) lifetime_seconds,
           v.peak_net_edge, v.peak_net_profit, v.peak_size, v.peak_magnitude, v.reason,
           jsonb_array_length(v.condition_ids) members,
           m.question, m.slug
    from violations v
    left join markets m on m.condition_id = (v.condition_ids ->> 0)
    ${filter}
    order by v.detected_at desc
    limit ${limit}
  `);

  const [total] = await database.execute<{ n: number }>(sql`select count(*)::int n from violations`);

  return {
    total: total?.n ?? 0,
    violations: rows.map((row) => ({
      id: Number(row.id),
      constraintKey: row.constraint_key,
      kind: row.kind,
      status: row.status,
      everConfirmed: row.ever_confirmed,
      detectedAt: iso(row.detected_at),
      resolvedAt: iso(row.resolved_at),
      lifetimeSeconds: num(row.lifetime_seconds),
      open: row.resolved_at === null,
      peakNetEdge: num(row.peak_net_edge),
      peakNetProfit: num(row.peak_net_profit),
      peakSize: num(row.peak_size),
      peakMagnitude: num(row.peak_magnitude),
      reason: row.reason,
      members: Number(row.members ?? 0),
      question: row.question,
      slug: row.slug,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lifetime distribution
// ---------------------------------------------------------------------------

export interface LifetimeBucket {
  readonly label: string;
  readonly fromSeconds: number;
  readonly toSeconds: number | null;
  readonly count: number;
  readonly confirmed: number;
}

/**
 * Fixed log-ish buckets rather than an even split.
 *
 * Lifetimes span seconds to days, so equal-width buckets put everything in the
 * first one and say nothing. These boundaries are chosen to make the question
 * the chart exists to answer legible: how much of the distribution is short
 * enough that a human could never have acted on it.
 */
const LIFETIME_BUCKETS: readonly { label: string; from: number; to: number | null }[] = [
  { label: '<30s', from: 0, to: 30 },
  { label: '30s–1m', from: 30, to: 60 },
  { label: '1–5m', from: 60, to: 300 },
  { label: '5–15m', from: 300, to: 900 },
  { label: '15–60m', from: 900, to: 3_600 },
  { label: '1–6h', from: 3_600, to: 21_600 },
  { label: '6–24h', from: 21_600, to: 86_400 },
  { label: '>24h', from: 86_400, to: null },
];

export interface LifetimePayload {
  readonly buckets: LifetimeBucket[];
  readonly closed: number;
  readonly medianSeconds: number | null;
  readonly p90Seconds: number | null;
  readonly confirmedMedianSeconds: number | null;
}

export async function readLifetimes(database: Database = db): Promise<LifetimePayload> {
  const rows = await database.execute<{ seconds: string; ever_confirmed: boolean }>(sql`
    select extract(epoch from (resolved_at - detected_at)) seconds, ever_confirmed
    from violations
    where resolved_at is not null
    order by detected_at desc
    limit 20000
  `);

  const values: { seconds: number; confirmed: boolean }[] = [];
  for (const row of rows) {
    const seconds = num(row.seconds);
    if (seconds === null || seconds < 0) continue;
    values.push({ seconds, confirmed: row.ever_confirmed });
  }

  const buckets = LIFETIME_BUCKETS.map((bucket) => {
    const inside = values.filter(
      (v) => v.seconds >= bucket.from && (bucket.to === null || v.seconds < bucket.to),
    );
    return {
      label: bucket.label,
      fromSeconds: bucket.from,
      toSeconds: bucket.to,
      count: inside.length,
      confirmed: inside.filter((v) => v.confirmed).length,
    };
  });

  const all = values.map((v) => v.seconds).toSorted((a, b) => a - b);
  const confirmed = values.filter((v) => v.confirmed).map((v) => v.seconds).toSorted((a, b) => a - b);

  return {
    buckets,
    closed: values.length,
    medianSeconds: quantile(all, 0.5),
    p90Seconds: quantile(all, 0.9),
    confirmedMedianSeconds: quantile(confirmed, 0.5),
  };
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[index] ?? null;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export interface RelationEdge {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly source: string;
  readonly confidence: number | null;
  readonly rationale: string | null;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly fromQuestion: string | null;
  readonly toQuestion: string | null;
}

export interface RelationQuery {
  readonly limit?: number;
  readonly source?: string;
  readonly type?: string;
}

export const MAX_RELATION_ROWS = 2_000;

export async function readRelations(
  database: Database = db,
  query: RelationQuery = {},
): Promise<{ relations: RelationEdge[]; total: number; limit: number }> {
  const limit = Math.min(Math.max(1, query.limit ?? 200), MAX_RELATION_ROWS);

  const bySource = query.source === undefined ? sql`` : sql`and r.source = ${query.source}`;
  const byType = query.type === undefined ? sql`` : sql`and r.type = ${query.type}`;

  const rows = await database.execute<{
    id: number;
    from_condition_id: string;
    to_condition_id: string;
    type: string;
    source: string;
    confidence: string | null;
    rationale: string | null;
    first_seen_at: Date | null;
    last_seen_at: Date | null;
    from_question: string | null;
    to_question: string | null;
  }>(sql`
    select r.id, r.from_condition_id, r.to_condition_id, r.type, r.source,
           r.confidence, r.rationale, r.first_seen_at, r.last_seen_at,
           f.question from_question, t.question to_question
    from relations r
    left join markets f on f.condition_id = r.from_condition_id
    left join markets t on t.condition_id = r.to_condition_id
    where true ${bySource} ${byType}
    order by r.id desc
    limit ${limit}
  `);

  const [total] = await database.execute<{ n: number }>(sql`
    select count(*)::int n from relations r where true ${bySource} ${byType}
  `);

  return {
    limit,
    total: total?.n ?? 0,
    relations: rows.map((row) => ({
      id: Number(row.id),
      from: row.from_condition_id,
      to: row.to_condition_id,
      type: row.type,
      source: row.source,
      confidence: num(row.confidence),
      rationale: row.rationale,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      fromQuestion: row.from_question,
      toQuestion: row.to_question,
    })),
  };
}

// ---------------------------------------------------------------------------
// Market families
// ---------------------------------------------------------------------------

export interface FamilySummary {
  readonly key: string;
  readonly kind: 'partition' | 'ladder';
  readonly label: string;
  readonly members: number;
}

/**
 * The families worth drawing.
 *
 * Two shapes, because the graph has two: a `partition` is an explicit group, and
 * a `ladder` is a connected run of `implies` edges. Ladders are keyed by event
 * rather than by connected component — every ladder the extractor produces lives
 * inside one event, and grouping by event is a `group by` where components would
 * be a recursive CTE for the same answer.
 */
export async function readFamilies(database: Database = db, limit = 300): Promise<FamilySummary[]> {
  const partitions = await database.execute<{ id: string; key: string; members: number }>(sql`
    select g.id::text id, g.key, count(*)::int members
    from relation_groups g
    join relation_group_members m on m.group_id = g.id
    join markets mk on mk.condition_id = m.condition_id
    where g.type = 'partition' and mk.missing_since is null and coalesce(mk.closed, false) = false
    group by g.id, g.key
    having count(*) > 1
    order by count(*) desc
    limit ${limit}
  `);

  const ladders = await database.execute<{ event_id: string; label: string; members: number }>(sql`
    select e.event_id, min(e.question) label, count(distinct e.condition_id)::int members
    from (
      select f.event_id, f.condition_id, f.question from relations r
        join markets f on f.condition_id = r.from_condition_id
        where r.type = 'implies' and f.event_id is not null
          and f.missing_since is null and coalesce(f.closed, false) = false
      union
      select t.event_id, t.condition_id, t.question from relations r
        join markets t on t.condition_id = r.to_condition_id
        where r.type = 'implies' and t.event_id is not null
          and t.missing_since is null and coalesce(t.closed, false) = false
    ) e
    group by e.event_id
    having count(distinct e.condition_id) > 1
    order by count(distinct e.condition_id) desc
    limit ${limit}
  `);

  return [
    ...partitions.map(
      (row): FamilySummary => ({
        key: `group:${row.id}`,
        kind: 'partition',
        label: row.key,
        members: row.members,
      }),
    ),
    ...ladders.map(
      (row): FamilySummary => ({
        key: `event:${row.event_id}`,
        kind: 'ladder',
        label: row.label ?? row.event_id,
        members: row.members,
      }),
    ),
  ];
}

export interface FamilyMember {
  readonly conditionId: string;
  readonly question: string | null;
  readonly slug: string | null;
  readonly price: number | null;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly quotedAt: string | null;
}

export interface FamilyEdge {
  readonly from: string;
  readonly to: string;
  readonly source: string;
  /** P(from) − P(to). Positive breaks the entailment. */
  readonly slack: number | null;
  readonly satisfied: boolean | null;
}

export interface FamilyDetail {
  readonly key: string;
  readonly kind: 'partition' | 'ladder';
  readonly label: string;
  readonly members: FamilyMember[];
  readonly edges: FamilyEdge[];
  /** Partitions only: the member prices summed. The constraint is `= 1`. */
  readonly sum: number | null;
  /** How far from satisfied, in probability. Null when nothing can be priced. */
  readonly magnitude: number | null;
  readonly violated: boolean;
  readonly pricedMembers: number;
}

export async function readFamily(
  key: string,
  database: Database = db,
): Promise<FamilyDetail | null> {
  const [prefix, ...rest] = key.split(':');
  const id = rest.join(':');
  if (id === '') return null;

  if (prefix === 'group') return readPartitionFamily(id, database);
  if (prefix === 'event') return readLadderFamily(id, database);
  return null;
}

/** One `select`, so a family is one round trip rather than one per member. */
const MEMBER_COLUMNS = sql`
  mk.condition_id, mk.question, mk.slug,
  q.yes_price, q.best_bid, q.best_ask, q.quoted_at
`;

function toMember(row: {
  condition_id: string;
  question: string | null;
  slug: string | null;
  yes_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  quoted_at: Date | null;
}): FamilyMember {
  return {
    conditionId: row.condition_id,
    question: row.question,
    slug: row.slug,
    price: num(row.yes_price),
    bestBid: num(row.best_bid),
    bestAsk: num(row.best_ask),
    quotedAt: iso(row.quoted_at),
  };
}

async function readPartitionFamily(id: string, database: Database): Promise<FamilyDetail | null> {
  const [group] = await database.execute<{ key: string }>(sql`
    select key from relation_groups where id = ${id}::bigint and type = 'partition'
  `);
  if (group === undefined) return null;

  const rows = await database.execute<Parameters<typeof toMember>[0]>(sql`
    select ${MEMBER_COLUMNS}
    from relation_group_members m
    join markets mk on mk.condition_id = m.condition_id
    left join market_quotes q on q.condition_id = mk.condition_id
    where m.group_id = ${id}::bigint
      and mk.missing_since is null and coalesce(mk.closed, false) = false
    order by q.yes_price desc nulls last
  `);

  const members = rows.map(toMember);
  const priced = members.filter((m) => m.price !== null);
  const sum = priced.length === 0 ? null : priced.reduce((total, m) => total + (m.price ?? 0), 0);

  // Only meaningful with every leg priced: a partial sum is always below 1 and
  // would read as a violation on every family with one missing quote.
  const complete = priced.length === members.length && members.length > 1;
  const magnitude = complete && sum !== null ? sum - 1 : null;

  return {
    key: `group:${id}`,
    kind: 'partition',
    label: group.key,
    members,
    edges: [],
    sum,
    magnitude,
    violated: magnitude !== null && Math.abs(magnitude) > 0.005,
    pricedMembers: priced.length,
  };
}

async function readLadderFamily(eventId: string, database: Database): Promise<FamilyDetail | null> {
  const rows = await database.execute<Parameters<typeof toMember>[0]>(sql`
    select distinct ${MEMBER_COLUMNS}
    from markets mk
    left join market_quotes q on q.condition_id = mk.condition_id
    where mk.event_id = ${eventId}
      and mk.missing_since is null and coalesce(mk.closed, false) = false
      and exists (
        select 1 from relations r
        where r.type = 'implies'
          and (r.from_condition_id = mk.condition_id or r.to_condition_id = mk.condition_id)
      )
    order by q.yes_price desc nulls last
  `);
  if (rows.length === 0) return null;

  const members = rows.map(toMember);
  const priced = new Map(members.filter((m) => m.price !== null).map((m) => [m.conditionId, m.price!]));

  const edgeRows = await database.execute<{
    from_condition_id: string;
    to_condition_id: string;
    source: string;
  }>(sql`
    select distinct r.from_condition_id, r.to_condition_id, r.source
    from relations r
    join markets f on f.condition_id = r.from_condition_id
    join markets t on t.condition_id = r.to_condition_id
    where r.type = 'implies' and f.event_id = ${eventId} and t.event_id = ${eventId}
  `);

  const edges: FamilyEdge[] = edgeRows.map((row) => {
    const from = priced.get(row.from_condition_id);
    const to = priced.get(row.to_condition_id);
    const slack = from === undefined || to === undefined ? null : from - to;
    return {
      from: row.from_condition_id,
      to: row.to_condition_id,
      source: row.source,
      slack,
      // P(A) <= P(B). The sign is the violation: positive means the antecedent
      // is priced above what it entails.
      satisfied: slack === null ? null : slack <= 0.005,
    };
  });

  const worst = edges.reduce<number | null>(
    (max, edge) => (edge.slack === null ? max : max === null || edge.slack > max ? edge.slack : max),
    null,
  );

  return {
    key: `event:${eventId}`,
    kind: 'ladder',
    label: members[0]?.question ?? eventId,
    members,
    edges,
    sum: null,
    magnitude: worst,
    violated: worst !== null && worst > 0.005,
    pricedMembers: priced.size,
  };
}
