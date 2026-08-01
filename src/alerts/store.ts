import { eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { alertDeliveries } from '../db/schema.js';
import type { DeliveryState } from './dedupe.js';

/**
 * Persistence for what has already been said.
 *
 * The only subtle part is {@link claim}: two replicas can reach the same
 * decision in the same second, and "one alert per violation" has to hold across
 * both. The unique index on `alert_key` plus an `onConflictDoNothing` insert
 * makes the *database* pick the winner — whichever transaction commits first
 * gets a row back, the loser gets nothing and stays quiet. Checking-then-sending
 * would leave a window between the check and the insert wide enough for both to
 * post.
 */

type Database = PostgresJsDatabase<typeof schema>;

export interface DeliveryRecord extends DeliveryState {
  readonly id: number;
  readonly alertKey: string;
}

function toState(row: typeof alertDeliveries.$inferSelect): DeliveryRecord {
  return {
    id: row.id,
    alertKey: row.alertKey,
    lastSentAt: row.lastSentAt,
    lastAlertValue: row.lastAlertValue === null ? null : Number(row.lastAlertValue),
    resolvedNotifiedAt: row.resolvedNotifiedAt,
    messageId: row.messageId,
    sendCount: Number(row.sendCount),
  };
}

export async function loadDelivery(
  alertKey: string,
  database: Database = db,
): Promise<DeliveryRecord | null> {
  const [row] = await database
    .select()
    .from(alertDeliveries)
    .where(eq(alertDeliveries.alertKey, alertKey))
    .limit(1);
  return row === undefined ? null : toState(row);
}

export async function loadDeliveries(
  alertKeys: readonly string[],
  database: Database = db,
): Promise<Map<string, DeliveryRecord>> {
  if (alertKeys.length === 0) return new Map();
  const rows = await database
    .select()
    .from(alertDeliveries)
    .where(inArray(alertDeliveries.alertKey, [...alertKeys]));
  return new Map(rows.map((row) => [row.alertKey, toState(row)]));
}

/**
 * Reserves the right to send the first alert for a key.
 *
 * Returns true to exactly one caller, ever. The row is written *before* the
 * message is sent, which is deliberate: a crash between claiming and sending
 * loses one alert, while sending before claiming and crashing after would
 * re-send on every restart forever. Losing one is the better failure.
 */
export async function claim(
  alertKey: string,
  kind: string,
  now: Date,
  value: number | null,
  database: Database = db,
): Promise<boolean> {
  const inserted = await database
    .insert(alertDeliveries)
    .values({
      alertKey,
      kind,
      firstSentAt: now,
      lastSentAt: now,
      sendCount: '1',
      lastAlertValue: value === null ? null : String(value),
    })
    .onConflictDoNothing({ target: alertDeliveries.alertKey })
    .returning({ id: alertDeliveries.id });

  return inserted.length > 0;
}

/** Records the message id once Discord has accepted the first send. */
export async function recordMessageId(
  alertKey: string,
  messageId: string | null,
  payload: unknown,
  database: Database = db,
): Promise<void> {
  await database
    .update(alertDeliveries)
    .set({ messageId, lastPayload: payload })
    .where(eq(alertDeliveries.alertKey, alertKey));
}

/**
 * Records a repeat message — an escalation, or a re-fired system alert.
 *
 * `lastAlertValue` moves to the value just quoted, so the next escalation
 * compares against what was actually said rather than the original. Without
 * that, an opportunity growing steadily would fire once and then never again,
 * or fire on every check once the cumulative ratio crossed the factor.
 */
export async function recordResend(
  alertKey: string,
  now: Date,
  value: number | null,
  payload: unknown,
  isEscalation: boolean,
  database: Database = db,
): Promise<void> {
  await database
    .update(alertDeliveries)
    .set({
      lastSentAt: now,
      lastAlertValue: value === null ? null : String(value),
      lastPayload: payload,
      sendCount: sql`${alertDeliveries.sendCount} + 1`,
      ...(isEscalation ? { escalations: sql`${alertDeliveries.escalations} + 1` } : {}),
    })
    .where(eq(alertDeliveries.alertKey, alertKey));
}

/**
 * Marks the resolution follow-up as delivered.
 *
 * Conditional on it not already being set, and reports whether it won: two
 * replicas noticing the same resolution both call this, and only the one whose
 * UPDATE matched a row should post.
 */
export async function claimResolution(
  alertKey: string,
  now: Date,
  database: Database = db,
): Promise<boolean> {
  const updated = await database
    .update(alertDeliveries)
    .set({ resolvedNotifiedAt: now })
    .where(sql`${alertDeliveries.alertKey} = ${alertKey} and ${alertDeliveries.resolvedNotifiedAt} is null`)
    .returning({ id: alertDeliveries.id });

  return updated.length > 0;
}

/** Deliveries by kind, for the operational view. */
export async function deliveryStats(
  database: Database = db,
): Promise<{ kind: string; keys: number; messages: number; escalations: number }[]> {
  const rows = await database.execute<{
    kind: string;
    keys: number;
    messages: number;
    escalations: number;
  }>(sql`
    select kind, count(*)::int keys,
           coalesce(sum(send_count), 0)::int messages,
           coalesce(sum(escalations), 0)::int escalations
    from alert_deliveries group by kind order by kind
  `);
  return rows.map((row) => ({
    kind: row.kind,
    keys: Number(row.keys),
    messages: Number(row.messages),
    escalations: Number(row.escalations),
  }));
}
