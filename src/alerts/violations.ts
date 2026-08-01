import { inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { CorrectingTrade } from '../coherence/trade.js';
import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { events, marketQuotes, markets } from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { decide, meetsThreshold, type DedupeOptions } from './dedupe.js';
import type { AlertTransport } from './discord.js';
import {
  formatResolution,
  formatViolationAlert,
  type AlertMarket,
  type ViolationAlertInput,
} from './format.js';
import { claim, claimResolution, loadDeliveries, recordMessageId, recordResend } from './store.js';

/**
 * Violation alerting: decide, claim, send, remember.
 *
 * The order matters and is the same every time — decide from persisted state,
 * claim the right to speak in the database, only then talk to Discord. Sending
 * first and recording afterwards is the shape that produces duplicate alerts,
 * because every failure between the two ends in a retry that sends again.
 */

const log = createLogger('alerts:violations');

type Database = PostgresJsDatabase<typeof schema>;

export interface ViolationAlertOptions extends DedupeOptions {
  readonly minNetEdge: number;
  readonly minNetProfit: number;
}

/** A confirmed violation as the alerter needs it. */
export interface AlertableViolation {
  readonly violationId: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly conditionIds: readonly string[];
  readonly trade: CorrectingTrade | null;
  readonly screenMagnitude: number | null;
  readonly detectedAt: Date;
}

export interface ResolvedViolation {
  readonly violationId: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly detectedAt: Date;
  readonly resolvedAt: Date;
  readonly peakNetEdge: number | null;
  readonly peakNetProfit: number | null;
  readonly everConfirmed: boolean;
}

export interface AlertOutcome {
  readonly sent: number;
  readonly escalated: number;
  readonly resolved: number;
  readonly suppressed: number;
  readonly belowThreshold: number;
  readonly failed: number;
}

/** `violation:{episode id}` — the episode, never the constraint. See the schema note. */
export function violationKey(violationId: number): string {
  return `violation:${violationId}`;
}

/** Market questions, slugs, and prices for the markets an alert names. */
export async function loadAlertMarkets(
  conditionIds: readonly string[],
  database: Database = db,
): Promise<Map<string, AlertMarket>> {
  if (conditionIds.length === 0) return new Map();

  const rows = await database
    .select({
      conditionId: markets.conditionId,
      question: markets.question,
      slug: markets.slug,
      eventSlug: events.slug,
    })
    .from(markets)
    .leftJoin(events, sql`${events.id} = ${markets.eventId}`)
    .where(inArray(markets.conditionId, [...conditionIds]));

  const quotes = await database
    .select({ conditionId: marketQuotes.conditionId, yesPrice: marketQuotes.yesPrice })
    .from(marketQuotes)
    .where(inArray(marketQuotes.conditionId, [...conditionIds]));
  const priceByMarket = new Map(
    quotes.map((row) => [row.conditionId, row.yesPrice === null ? null : Number(row.yesPrice)]),
  );

  return new Map(
    rows.map((row) => [
      row.conditionId,
      {
        conditionId: row.conditionId,
        question: row.question,
        slug: row.slug,
        eventSlug: row.eventSlug,
        price: priceByMarket.get(row.conditionId) ?? null,
      },
    ]),
  );
}

/**
 * Alerts on confirmed violations, once each.
 *
 * Deliveries are loaded in one query for the whole batch rather than per
 * violation: the checker runs every sixty seconds over a set that is usually
 * unchanged, and N round-trips to decide "say nothing" N times is the kind of
 * cost that makes people turn alerting off.
 */
export async function alertConfirmedViolations(
  violations: readonly AlertableViolation[],
  transport: AlertTransport,
  options: ViolationAlertOptions,
  database: Database = db,
  now: Date = new Date(),
): Promise<AlertOutcome> {
  let sent = 0;
  let escalated = 0;
  let suppressed = 0;
  let belowThreshold = 0;
  let failed = 0;

  const eligible = violations.filter((violation) => {
    const ok = meetsThreshold(violation.trade?.netEdge ?? null, violation.trade?.netProfit ?? null, options);
    if (!ok) belowThreshold += 1;
    return ok;
  });

  if (eligible.length === 0) {
    return { sent: 0, escalated: 0, resolved: 0, suppressed, belowThreshold, failed: 0 };
  }

  const deliveries = await loadDeliveries(
    eligible.map((v) => violationKey(v.violationId)),
    database,
  );

  const marketMeta = await loadAlertMarkets(
    [...new Set(eligible.flatMap((v) => v.conditionIds))],
    database,
  );

  for (const violation of eligible) {
    const key = violationKey(violation.violationId);
    const state = deliveries.get(key) ?? null;
    const value = violation.trade?.netEdge ?? null;

    const decision = decide({ state, value, resolved: false, now }, options);

    if (decision === 'suppress') {
      suppressed += 1;
      continue;
    }

    const input: ViolationAlertInput = {
      violationId: violation.violationId,
      constraintKey: violation.constraintKey,
      kind: violation.kind,
      markets: violation.conditionIds.map(
        (id) =>
          marketMeta.get(id) ?? {
            conditionId: id,
            question: null,
            slug: null,
            eventSlug: null,
            price: null,
          },
      ),
      trade: violation.trade,
      screenMagnitude: violation.screenMagnitude,
      detectedAt: violation.detectedAt,
      ...(decision === 'escalate' ? { previousNetEdge: state?.lastAlertValue ?? null } : {}),
    };

    try {
      if (decision === 'send') {
        // Claim before speaking: the unique index decides which replica wins,
        // and the loser must not also post.
        const won = await claim(key, 'violation', now, value, database);
        if (!won) {
          suppressed += 1;
          continue;
        }

        const message = formatViolationAlert(input, 'confirmed');
        const result = await transport.send(message);
        await recordMessageId(key, result?.id ?? null, message, database);
        sent += 1;

        log.info(
          { key, netEdge: value, profit: violation.trade?.netProfit, messageId: result?.id },
          'violation alert sent',
        );
        continue;
      }

      const message = formatViolationAlert(input, 'escalation');
      await transport.send(message);
      await recordResend(key, now, value, message, true, database);
      escalated += 1;

      log.info(
        { key, netEdge: value, previous: state?.lastAlertValue },
        'violation escalation sent',
      );
    } catch (error) {
      failed += 1;
      log.error({ key, error: describeError(error) }, 'violation alert failed to send');
    }
  }

  return { sent, escalated, resolved: 0, suppressed, belowThreshold, failed };
}

/**
 * Follows up on violations that have ended.
 *
 * Replies to the original message when its id is known, so the lifetime lands
 * in the same thread of conversation as the alert it closes; falls back to a
 * standalone message otherwise. Only violations that were *alerted about* get a
 * follow-up — announcing the end of something never announced is noise.
 */
export async function alertResolvedViolations(
  resolved: readonly ResolvedViolation[],
  transport: AlertTransport,
  options: DedupeOptions,
  database: Database = db,
  now: Date = new Date(),
): Promise<AlertOutcome> {
  let count = 0;
  let suppressed = 0;
  let failed = 0;

  if (resolved.length === 0) {
    return { sent: 0, escalated: 0, resolved: 0, suppressed: 0, belowThreshold: 0, failed: 0 };
  }

  const deliveries = await loadDeliveries(
    resolved.map((v) => violationKey(v.violationId)),
    database,
  );

  for (const violation of resolved) {
    const key = violationKey(violation.violationId);
    const state = deliveries.get(key) ?? null;

    if (state === null) {
      // Never alerted, so nothing to close out.
      suppressed += 1;
      continue;
    }

    if (decide({ state, value: null, resolved: true, now }, options) !== 'resolve') {
      suppressed += 1;
      continue;
    }

    try {
      // Claim first, again: the UPDATE is conditional on not already being set,
      // so exactly one caller proceeds.
      const won = await claimResolution(key, now, database);
      if (!won) {
        suppressed += 1;
        continue;
      }

      const message = formatResolution(violation);
      if (state.messageId !== null) {
        message.message_reference = { message_id: state.messageId, fail_if_not_exists: false };
      }

      await transport.send(message);
      count += 1;

      log.info(
        {
          key,
          lifetimeSeconds: (violation.resolvedAt.getTime() - violation.detectedAt.getTime()) / 1000,
        },
        'violation resolution sent',
      );
    } catch (error) {
      failed += 1;
      log.error({ key, error: describeError(error) }, 'resolution alert failed to send');
    }
  }

  return { sent: 0, escalated: 0, resolved: count, suppressed, belowThreshold: 0, failed };
}
