import { inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { marketQuotes } from '../db/schema.js';
import { createLogger } from '../logger.js';
import { GammaClient } from '../polymarket/gamma.js';
import type { Constraint, ConstraintMember } from './constraints.js';

/**
 * Building the constraint set, and keeping the screen's price cache warm.
 *
 * Two responsibilities that look separate but share a scan: the constraints
 * come from `relations` and `relation_groups`, and the screen needs one price
 * per market that appears in them. Loading both together means the refresh
 * touches exactly the markets under constraint and nothing else — the catalog
 * has 300k markets and only a fraction are in the graph.
 */

const log = createLogger('coherence:load');

type Database = PostgresJsDatabase<typeof schema>;

/** Gamma accepts repeated `condition_ids`; this many per request. */
const QUOTE_BATCH = 100;

export interface LoadedConstraints {
  readonly constraints: readonly Constraint[];
  /** Every market appearing in any constraint. */
  readonly conditionIds: readonly string[];
}

/**
 * Every pairwise relation and every partition, as constraints.
 *
 * Closed and missing markets are excluded: a resolved market's price is 0 or 1
 * by definition, and a constraint over one is either trivially satisfied or
 * "violated" in a way no trade can correct. Including them would fill the
 * violation table with unactionable noise that never resolves.
 */
export async function loadConstraints(database: Database = db): Promise<LoadedConstraints> {
  const edges = await database.execute<{
    id: number;
    from_condition_id: string;
    to_condition_id: string;
    type: string;
    rationale: string | null;
  }>(sql`
    select r.id, r.from_condition_id, r.to_condition_id, r.type, r.rationale
    from relations r
    join markets fm on fm.condition_id = r.from_condition_id
    join markets tm on tm.condition_id = r.to_condition_id
    where fm.missing_since is null and tm.missing_since is null
      and coalesce(fm.closed, false) = false and coalesce(tm.closed, false) = false
  `);

  const groups = await database.execute<{
    id: string;
    key: string;
    members: string[];
    rationale: string | null;
  }>(sql`
    select g.id::text as id, g.key, g.rationale,
           array_agg(m.condition_id order by m.condition_id) as members
    from relation_groups g
    join relation_group_members m on m.group_id = g.id
    join markets mk on mk.condition_id = m.condition_id
    where g.type = 'partition'
      and mk.missing_since is null and coalesce(mk.closed, false) = false
    group by g.id, g.key, g.rationale
    having count(*) > 1
  `);

  const constraints: Constraint[] = [];

  for (const edge of edges) {
    const kind = edge.type === 'complement' ? 'complement' : 'implies';
    constraints.push({
      key: `${kind}:${edge.id}`,
      kind,
      relationIds: [edge.id],
      groupId: null,
      // Order carries the direction of entailment — never sort these.
      members: [
        { conditionId: edge.from_condition_id, price: null },
        { conditionId: edge.to_condition_id, price: null },
      ],
      ...(edge.rationale === null ? {} : { rationale: edge.rationale }),
    });
  }

  for (const group of groups) {
    constraints.push({
      key: `partition:${group.id}`,
      kind: 'partition',
      relationIds: [],
      groupId: group.id,
      members: group.members.map((conditionId) => ({ conditionId, price: null })),
      ...(group.rationale === null ? {} : { rationale: group.rationale }),
    });
  }

  const conditionIds = [
    ...new Set(constraints.flatMap((c) => c.members.map((m) => m.conditionId))),
  ];

  log.info(
    { constraints: constraints.length, edges: edges.length, partitions: groups.length, markets: conditionIds.length },
    'constraints loaded',
  );

  return { constraints, conditionIds };
}

/**
 * Refreshes cached Gamma midpoints for the markets under constraint.
 *
 * This is the cheap half of the two-stage design. One Gamma request covers 100
 * markets; the equivalent coverage on the CLOB is one order book per *token*,
 * so two per market. Screening on these first is what keeps the order-book
 * budget for the handful of constraints that might actually be violated.
 *
 * The prices are stale by construction — Gamma lags the book by seconds and
 * describes no size at all. That is acceptable here and nowhere else: a stale
 * screen produces false positives, which stage 2 rejects, and false negatives,
 * which cost a missed opportunity rather than a wrong trade.
 */
export async function refreshQuotes(
  conditionIds: readonly string[],
  database: Database = db,
  client: GammaClient = new GammaClient(),
  signal?: AbortSignal,
): Promise<{ requested: number; updated: number; missing: number }> {
  if (conditionIds.length === 0) return { requested: 0, updated: 0, missing: 0 };

  const now = new Date();
  let updated = 0;
  const seen = new Set<string>();

  for (let i = 0; i < conditionIds.length; i += QUOTE_BATCH) {
    const batch = conditionIds.slice(i, i + QUOTE_BATCH);

    const markets = await client.fetchMarketsByConditionIds(batch, signal);

    const rows: (typeof marketQuotes.$inferInsert)[] = [];
    for (const market of markets) {
      if (market.conditionId === null || seen.has(market.conditionId)) continue;
      seen.add(market.conditionId);

      // outcomePrices[0] is the probability of the first outcome, which is what
      // every relation is written about.
      const yes = market.outcomePrices?.[0] ?? null;
      rows.push({
        conditionId: market.conditionId,
        yesPrice: yes === null ? null : String(yes),
        bestBid: market.bestBid === null ? null : String(market.bestBid),
        bestAsk: market.bestAsk === null ? null : String(market.bestAsk),
        quotedAt: market.updatedAt ?? null,
        fetchedAt: now,
        source: 'gamma-market',
      });
    }

    if (rows.length === 0) continue;

    await database
      .insert(marketQuotes)
      .values(rows)
      .onConflictDoUpdate({
        target: marketQuotes.conditionId,
        set: {
          yesPrice: sql`excluded.yes_price`,
          bestBid: sql`excluded.best_bid`,
          bestAsk: sql`excluded.best_ask`,
          quotedAt: sql`excluded.quoted_at`,
          fetchedAt: sql`excluded.fetched_at`,
          source: sql`excluded.source`,
        },
      });
    updated += rows.length;
  }

  const missing = conditionIds.length - seen.size;
  log.info({ requested: conditionIds.length, updated, missing }, 'gamma quotes refreshed');
  return { requested: conditionIds.length, updated, missing };
}

/** Cached prices for the screen, keyed by condition id. */
export async function loadQuotes(
  conditionIds: readonly string[],
  database: Database = db,
): Promise<Map<string, number>> {
  if (conditionIds.length === 0) return new Map();

  const rows = await database
    .select({ conditionId: marketQuotes.conditionId, yesPrice: marketQuotes.yesPrice })
    .from(marketQuotes)
    .where(inArray(marketQuotes.conditionId, [...conditionIds]));

  const prices = new Map<string, number>();
  for (const row of rows) {
    if (row.yesPrice === null) continue;
    const price = Number(row.yesPrice);
    if (Number.isFinite(price)) prices.set(row.conditionId, price);
  }
  return prices;
}

/** Attaches cached prices to a constraint's members. */
export function priced(constraint: Constraint, prices: ReadonlyMap<string, number>): Constraint {
  const members: ConstraintMember[] = constraint.members.map((member) => ({
    conditionId: member.conditionId,
    price: prices.get(member.conditionId) ?? null,
  }));
  return { ...constraint, members };
}
