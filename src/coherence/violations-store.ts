import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { violations } from '../db/schema.js';
import { createLogger } from '../logger.js';
import type { Confirmation } from './check.js';

/**
 * Violation episodes, and the lifetime they imply.
 *
 * The record is an *episode*: one row spanning the interval a constraint was
 * violated, opened when it starts and closed when it stops. Not one row per
 * observation. The distinction is the whole reason lifetime is measurable —
 * with per-tick rows you would have to reconstruct episodes afterwards by
 * stitching together gaps, and every judgement call in that stitching (how long
 * a gap before it counts as two episodes?) silently changes the headline
 * number.
 *
 * Peaks rather than latest values: the question asked of this table later is
 * "was this ever worth taking, and for how much", and a violation that was
 * briefly worth $40 and is now worth $2 should answer $40.
 */

const log = createLogger('coherence:violations');

type Database = PostgresJsDatabase<typeof schema>;

export interface RecordResult {
  readonly opened: number;
  readonly updated: number;
  readonly upgraded: number;
  readonly resolved: number;
}

function numeric(value: number | null | undefined): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : String(value);
}

/**
 * Writes one check's worth of confirmations, then closes anything that stopped.
 *
 * `stillViolating` is every constraint key the check found violated *this run*,
 * screened or confirmed. Any open episode whose key is absent from it has
 * stopped violating and gets `resolved_at`. That set must come from the caller
 * rather than be inferred here: a run that examined only part of the graph — a
 * truncated stage 2, a partial screen — would otherwise resolve every episode
 * it simply did not look at.
 */
export async function recordViolations(
  confirmations: readonly Confirmation[],
  stillViolating: ReadonlySet<string>,
  database: Database = db,
  now: Date = new Date(),
): Promise<RecordResult> {
  let opened = 0;
  let updated = 0;
  let upgraded = 0;

  for (const confirmation of confirmations) {
    const key = confirmation.constraint.key;
    const trade = confirmation.trade;
    const netEdge = trade?.netEdge ?? null;
    const size = trade?.size ?? null;
    const profit = trade?.netProfit ?? null;

    const [existing] = await database
      .select()
      .from(violations)
      .where(and(eq(violations.constraintKey, key), isNull(violations.resolvedAt)))
      .limit(1);

    if (existing === undefined) {
      await database.insert(violations).values({
        constraintKey: key,
        kind: confirmation.constraint.kind,
        relationIds: [...confirmation.constraint.relationIds],
        groupId: confirmation.constraint.groupId,
        conditionIds: confirmation.constraint.members.map((m) => m.conditionId),
        status: confirmation.status,
        reason: confirmation.reason,
        detectedAt: now,
        lastCheckedAt: now,
        everConfirmed: confirmation.status === 'confirmed',
        screenMagnitude: numeric(confirmation.evaluation.magnitude),
        peakMagnitude: numeric(confirmation.evaluation.magnitude),
        peakNetEdge: numeric(netEdge),
        peakSize: numeric(size),
        peakNetProfit: numeric(profit),
        trade: trade === null ? null : (trade as unknown),
        checks: 1,
      });
      opened += 1;
      if (confirmation.status === 'confirmed') {
        log.info(
          { key, kind: confirmation.constraint.kind, netEdge, size, profit },
          'CONFIRMED violation opened',
        );
      }
      continue;
    }

    const wasConfirmed = existing.everConfirmed;
    const previousPeak = existing.peakNetProfit === null ? null : Number(existing.peakNetProfit);
    // Peak is on total profit, not per-unit edge: a thin trade with a huge
    // per-unit edge is worth less than a deep one with a small edge, and it is
    // the dollars that decide whether an episode mattered.
    const improved = profit !== null && (previousPeak === null || profit > previousPeak);

    await database
      .update(violations)
      .set({
        status: confirmation.status === 'confirmed' ? 'confirmed' : existing.status,
        // A reason only makes sense while unconfirmed; clear it on upgrade.
        reason: confirmation.status === 'confirmed' ? null : confirmation.reason,
        lastCheckedAt: now,
        everConfirmed: wasConfirmed || confirmation.status === 'confirmed',
        peakMagnitude: numeric(
          Math.max(
            existing.peakMagnitude === null ? Number.NEGATIVE_INFINITY : Number(existing.peakMagnitude),
            confirmation.evaluation.magnitude,
          ),
        ),
        ...(improved
          ? {
              peakNetEdge: numeric(netEdge),
              peakSize: numeric(size),
              peakNetProfit: numeric(profit),
              trade: trade as unknown,
            }
          : {}),
        checks: sql`${violations.checks} + 1`,
      })
      .where(eq(violations.id, existing.id));

    updated += 1;
    if (!wasConfirmed && confirmation.status === 'confirmed') {
      upgraded += 1;
      log.info({ key, netEdge, size, profit }, 'apparent violation upgraded to CONFIRMED');
    }
  }

  const resolved = await resolveDisappeared(stillViolating, database, now);

  return { opened, updated, upgraded, resolved };
}

/**
 * Closes every open episode whose constraint is no longer violated.
 *
 * This is where lifetime is actually recorded. `resolved_at - detected_at` is
 * the episode's duration, and the median of that over confirmed episodes is the
 * headline number the whole service exists to produce: how long a real
 * mispricing survives on this venue.
 */
export async function resolveDisappeared(
  stillViolating: ReadonlySet<string>,
  database: Database = db,
  now: Date = new Date(),
): Promise<number> {
  const open = await database
    .select({ id: violations.id, key: violations.constraintKey, everConfirmed: violations.everConfirmed, detectedAt: violations.detectedAt })
    .from(violations)
    .where(isNull(violations.resolvedAt));

  const gone = open.filter((row) => !stillViolating.has(row.key));
  if (gone.length === 0) return 0;

  for (const row of gone) {
    await database
      .update(violations)
      .set({ resolvedAt: now, status: 'closed', lastCheckedAt: now })
      .where(eq(violations.id, row.id));

    if (row.everConfirmed) {
      log.info(
        { key: row.key, lifetimeSeconds: (now.getTime() - row.detectedAt.getTime()) / 1000 },
        'confirmed violation resolved',
      );
    }
  }

  return gone.length;
}

export interface LifetimeStats {
  readonly closedEpisodes: number;
  readonly closedConfirmed: number;
  /** Seconds. Null until at least one confirmed episode has closed. */
  readonly medianConfirmedLifetimeSeconds: number | null;
  readonly medianAllLifetimeSeconds: number | null;
  readonly p90ConfirmedLifetimeSeconds: number | null;
  readonly openEpisodes: number;
  readonly openConfirmed: number;
  readonly totalConfirmedEver: number;
  readonly bestNetProfit: number | null;
}

/**
 * The headline metrics.
 *
 * Median rather than mean, because the distribution is heavily skewed: most
 * violations close on the next tick, a few persist for hours, and a mean over
 * that is dominated by the tail and describes nothing anyone experiences.
 */
export async function lifetimeStats(database: Database = db): Promise<LifetimeStats> {
  const [row] = await database.execute<{
    closed_episodes: number;
    closed_confirmed: number;
    median_confirmed: number | null;
    median_all: number | null;
    p90_confirmed: number | null;
    open_episodes: number;
    open_confirmed: number;
    total_confirmed_ever: number;
    best_net_profit: string | null;
  }>(sql`
    select
      count(*) filter (where resolved_at is not null)::int as closed_episodes,
      count(*) filter (where resolved_at is not null and ever_confirmed)::int as closed_confirmed,
      percentile_cont(0.5) within group (
        order by extract(epoch from (resolved_at - detected_at))
      ) filter (where resolved_at is not null and ever_confirmed) as median_confirmed,
      percentile_cont(0.5) within group (
        order by extract(epoch from (resolved_at - detected_at))
      ) filter (where resolved_at is not null) as median_all,
      percentile_cont(0.9) within group (
        order by extract(epoch from (resolved_at - detected_at))
      ) filter (where resolved_at is not null and ever_confirmed) as p90_confirmed,
      count(*) filter (where resolved_at is null)::int as open_episodes,
      count(*) filter (where resolved_at is null and ever_confirmed)::int as open_confirmed,
      count(*) filter (where ever_confirmed)::int as total_confirmed_ever,
      max(peak_net_profit) as best_net_profit
    from violations
  `);

  return {
    closedEpisodes: Number(row?.closed_episodes ?? 0),
    closedConfirmed: Number(row?.closed_confirmed ?? 0),
    medianConfirmedLifetimeSeconds: row?.median_confirmed === null || row?.median_confirmed === undefined ? null : Number(row.median_confirmed),
    medianAllLifetimeSeconds: row?.median_all === null || row?.median_all === undefined ? null : Number(row.median_all),
    p90ConfirmedLifetimeSeconds: row?.p90_confirmed === null || row?.p90_confirmed === undefined ? null : Number(row.p90_confirmed),
    openEpisodes: Number(row?.open_episodes ?? 0),
    openConfirmed: Number(row?.open_confirmed ?? 0),
    totalConfirmedEver: Number(row?.total_confirmed_ever ?? 0),
    bestNetProfit: row?.best_net_profit === null || row?.best_net_profit === undefined ? null : Number(row.best_net_profit),
  };
}

/** Why apparent violations failed, most common first. */
export async function apparentReasons(
  database: Database = db,
  limit = 10,
): Promise<ReadonlyArray<{ reason: string; count: number }>> {
  const rows = await database.execute<{ reason: string | null; n: number }>(sql`
    select reason, count(*)::int as n
    from violations
    where not ever_confirmed and reason is not null
    group by reason order by n desc limit ${limit}
  `);
  return rows.map((row) => ({ reason: row.reason ?? '(none)', count: Number(row.n) }));
}
