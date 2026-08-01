import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import type { AlertTransport } from './discord.js';
import { formatDigest, type DigestEntry } from './format.js';
import { claim, recordMessageId } from './store.js';

/**
 * The hourly digest of apparent-but-unexecutable violations.
 *
 * These are the common case — most screened gaps do not survive the spread —
 * and alerting on each individually would bury the confirmed ones. Batching
 * them into one message an hour keeps the information without the noise, and
 * the grouped reasons are more useful than the individual rows anyway: "37 ×
 * the spread and fees exceed the mispricing" is a fact about the venue, where
 * thirty-seven separate lines are just thirty-seven lines.
 *
 * Keyed by the hour bucket itself, so the digest for 14:00 can be sent exactly
 * once no matter how many times the job fires or restarts inside that hour.
 */

const log = createLogger('alerts:digest');

type Database = PostgresJsDatabase<typeof schema>;

/** Start of the UTC hour containing `at`. */
export function hourBucket(at: Date): Date {
  const bucket = new Date(at);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/** `digest:2026-08-01T14:00:00.000Z` — one key per hour, so one message per hour. */
export function digestKey(bucketStart: Date): string {
  return `digest:${bucketStart.toISOString()}`;
}

export interface DigestResult {
  readonly sent: boolean;
  readonly reason: 'sent' | 'already-sent' | 'empty' | 'incomplete-hour' | 'failed';
  readonly entries: number;
}

/**
 * Sends the digest for the last *complete* hour.
 *
 * The previous hour, not the current one: a digest of a partial hour would be
 * followed by another for the same hour, which is exactly the duplication this
 * whole module exists to avoid. Running the job every ten minutes is therefore
 * safe — nine of those calls find the hour already covered and do nothing.
 */
export async function sendHourlyDigest(
  transport: AlertTransport,
  database: Database = db,
  now: Date = new Date(),
  options: { readonly sendWhenEmpty?: boolean } = {},
): Promise<DigestResult> {
  const currentBucket = hourBucket(now);
  const windowStart = new Date(currentBucket.getTime() - 60 * 60 * 1000);
  const windowEnd = currentBucket;

  const rows = await database.execute<{
    kind: string;
    constraint_key: string;
    question: string | null;
    screen_magnitude: string | null;
    reason: string | null;
  }>(sql`
    select v.kind, v.constraint_key, v.screen_magnitude, v.reason,
           (select m.question from markets m
             where m.condition_id = (v.condition_ids ->> 0) limit 1) as question
    from violations v
    where v.detected_at >= ${windowStart.toISOString()}::timestamptz
      and v.detected_at < ${windowEnd.toISOString()}::timestamptz
      and not v.ever_confirmed
    order by v.screen_magnitude desc nulls last
    limit 500
  `);

  const [confirmedRow] = await database.execute<{ n: number }>(sql`
    select count(*)::int n from violations
    where detected_at >= ${windowStart.toISOString()}::timestamptz
      and detected_at < ${windowEnd.toISOString()}::timestamptz and ever_confirmed
  `);
  const confirmedInWindow = Number(confirmedRow?.n ?? 0);

  const entries: DigestEntry[] = rows.map((row) => ({
    kind: row.kind,
    constraintKey: row.constraint_key,
    question: row.question,
    screenMagnitude: row.screen_magnitude === null ? null : Number(row.screen_magnitude),
    reason: row.reason,
  }));

  if (entries.length === 0 && options.sendWhenEmpty !== true) {
    return { sent: false, reason: 'empty', entries: 0 };
  }

  const key = digestKey(windowStart);

  // Claim before sending. Two replicas ticking at the same minute both reach
  // here; the unique index decides.
  const won = await claim(key, 'digest', now, null, database);
  if (!won) {
    return { sent: false, reason: 'already-sent', entries: entries.length };
  }

  try {
    const message = formatDigest({ windowStart, windowEnd, entries, confirmedInWindow });
    const result = await transport.send(message);
    await recordMessageId(key, result?.id ?? null, message, database);

    log.info(
      { window: windowStart.toISOString(), entries: entries.length, confirmedInWindow },
      'hourly digest sent',
    );
    return { sent: true, reason: 'sent', entries: entries.length };
  } catch (error) {
    // The claim stays. A digest that failed to send is not re-attempted next
    // minute — an hour of history is not worth a retry storm, and the next
    // hour's digest carries the same shape of information.
    log.error({ key, error: describeError(error) }, 'hourly digest failed to send');
    return { sent: false, reason: 'failed', entries: entries.length };
  }
}
