/**
 * Backfills resolution criteria, outcomes, and the negRisk flag into the local
 * development database from the live Gamma API, one event at a time.
 *
 * Why this exists: the committed corpus fixture carries only conditionId,
 * question, endDate, and eventId — it was captured to test the threshold-ladder
 * parser, which needs nothing else. The LLM proposal pipeline is specified to
 * send *resolution criteria* to the classifier, and the seed script had been
 * filling `outcomes` with a hardcoded ["Yes","No"] placeholder. That placeholder
 * is wrong for a large fraction of the catalog — an over/under market's real
 * outcomes are ["Over","Under"] — and a placeholder sitting in a column that
 * looks authoritative is worse than a null, because it reads as evidence.
 *
 * Development-database only. The production ingest gets these fields from the
 * catalog crawl and never needs this.
 */
import { sql } from 'drizzle-orm';

import { closeDatabase, db } from '../src/db/client.js';

const BASE = 'https://gamma-api.polymarket.com';

const onlyProposed = process.argv.includes('--proposed-only');
const force = process.argv.includes('--force');
const concurrencyArg = process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1];
const concurrency = Number.isFinite(Number(concurrencyArg)) ? Number(concurrencyArg) : 8;

const rows = await db.execute<{ event_id: string }>(
  onlyProposed
    ? sql`select distinct m.event_id
          from relation_proposals p
          join markets m on m.condition_id in (p.low_condition_id, p.high_condition_id)
          where m.event_id is not null`
    : // Resumable by default: an event whose negRisk is already known was
      // fetched on an earlier pass, so a restart costs nothing.
      force
      ? sql`select distinct event_id as event_id from markets where event_id is not null`
      : sql`select id as event_id from events where neg_risk is null`,
);

const eventIds = rows.map((r) => r.event_id);
console.log(`backfilling ${eventIds.length} events at concurrency ${concurrency}`);

let events = 0;
let markets = 0;
let failed = 0;
let processed = 0;

/**
 * Gamma throttles this endpoint well below the documented budget, so 429 is an
 * ordinary outcome rather than an error. Full jitter on the backoff, because a
 * fixed delay would resynchronise every worker onto the same retry instant.
 */
async function fetchEvent(eventId: string): Promise<Response> {
  const maxRetries = 6;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${BASE}/events?id=${encodeURIComponent(eventId)}`, {
      headers: { accept: 'application/json' },
    });
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxRetries) throw new Error(`HTTP ${response.status}`);

    const after = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0
      ? after * 1000
      : Math.min(20_000, 400 * 2 ** attempt) * (0.5 + Math.random() / 2);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function backfillEvent(eventId: string): Promise<void> {
  try {
    const response = await fetchEvent(eventId);

    const body = (await response.json()) as Array<{
      negRisk?: boolean;
      markets?: Array<{ conditionId?: string; description?: string; outcomes?: string }>;
    }>;
    const event = body[0];
    if (event === undefined) {
      failed += 1;
      return;
    }

    await db.execute(sql`
      update events set neg_risk = ${event.negRisk ?? null} where id = ${eventId}
    `);
    events += 1;

    for (const market of event.markets ?? []) {
      if (market.conditionId === undefined) continue;
      // eslint-disable-next-line no-await-in-loop
      // Gamma sends `outcomes` as a JSON-encoded string, not an array.
      let outcomes: string[] | null = null;
      if (typeof market.outcomes === 'string') {
        try {
          const parsed: unknown = JSON.parse(market.outcomes);
          if (Array.isArray(parsed)) outcomes = parsed.map(String);
        } catch {
          outcomes = null;
        }
      }

      await db.execute(sql`
        update markets
        set description = ${market.description ?? null},
            outcomes = ${outcomes === null ? null : JSON.stringify(outcomes)}::jsonb
        where condition_id = ${market.conditionId}
      `);
      markets += 1;
    }
  } catch (error) {
    failed += 1;
    console.warn(`event ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  processed += 1;
  if (processed % 250 === 0) console.log(`  ${processed}/${eventIds.length}`);
}

// A fixed pool of workers pulling from one shared cursor. Still well under the
// Gamma client's 20 req/s budget, and roughly an order of magnitude faster than
// one sequential request at a time.
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const eventId = eventIds[index];
      if (eventId === undefined) return;
      await backfillEvent(eventId);
    }
  }),
);

console.log(`events updated ${events}, markets touched ${markets}, failed ${failed}`);
await closeDatabase();
