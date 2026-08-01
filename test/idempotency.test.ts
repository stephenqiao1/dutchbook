import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { events, marketRevisions, markets, priceSnapshots, rawPayloads } from '../src/db/schema.js';
import { createCatalogStore, ingestCatalog } from '../src/jobs/ingest-catalog.js';
import { loadFixture } from './polymarket/fixtures.js';

/**
 * The load-bearing test: running the same crawl twice must change nothing.
 *
 * Everything else in the pipeline is a means to this end. If a second identical
 * run creates rows, writes revisions, or moves a content hash, then the change
 * log is noise and cannot be used to prove a market was silently edited — which
 * is the entire point of the schema.
 *
 * It runs against real Postgres, because the properties under test are database
 * properties: upsert semantics, jsonb round-tripping, and the unique constraint
 * that deduplicates archived payloads. An in-memory fake cannot fail the way a
 * database fails.
 *
 * The two runs use *different* clocks, so the only column permitted to differ
 * has genuinely moved. Freezing the clock would make the assertion vacuous.
 */

const RUN_ONE_AT = new Date('2026-03-01T00:00:00Z');
const RUN_TWO_AT = new Date('2026-03-02T06:30:00Z');

/** Columns whose value is the wall clock, and nothing else. */
const TIME_BASED_COLUMNS = new Set(['lastSeenAt', 'fetchedAt']);

const PAGE_CURSORS = ['MjAwMA==', 'NDAwMA=='];

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A dedicated database, if one is configured; otherwise a throwaway container.
const explicitUrl = process.env['TEST_DATABASE_URL'];
const canRun = explicitUrl !== undefined || dockerAvailable();

if (!canRun) {
  // Loud on purpose. Silence here would let the most important test in the repo
  // vanish from a run without anyone noticing.
  console.warn(
    '\n  SKIPPED test/idempotency.test.ts — needs Postgres.' +
      '\n  Start Docker, or set TEST_DATABASE_URL to a throwaway database.\n',
  );
}

type Database = PostgresJsDatabase<typeof schema>;

let sql: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

/** Applies every committed migration, in order. */
async function migrate(client: postgres.Sql): Promise<void> {
  const dir = new URL('../drizzle/', import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();

  expect(files.length, 'no migrations found in drizzle/').toBeGreaterThan(0);

  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed !== '') await client.unsafe(trimmed);
    }
  }
}

/**
 * Serves the recorded catalog pages, following `after_cursor` the way Gamma
 * does. `mutate` edits the decoded pages before they are served, which is how
 * the second test stages an upstream edit.
 */
function catalogFetch(mutate?: (pages: CatalogPage[]) => void): typeof globalThis.fetch {
  const pages = [1, 2, 3].map((n) => loadFixture(`catalog-page-${n}`) as CatalogPage);
  mutate?.(pages);

  return async (input) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get('after_cursor');

    let index = 0;
    if (cursor !== null) {
      const found = PAGE_CURSORS.indexOf(cursor);
      if (found < 0) throw new Error(`unexpected cursor ${JSON.stringify(cursor)}`);
      index = found + 1;
    }
    if (index >= pages.length) throw new Error(`no page at index ${index}`);

    return new Response(JSON.stringify(pages[index]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

interface CatalogPage {
  data: Array<{ id: string; markets: Array<Record<string, unknown>> }>;
  next_cursor?: string;
}

async function ingest(at: Date, fetch: typeof globalThis.fetch): Promise<ReturnType<typeof ingestCatalog>> {
  return ingestCatalog({
    store: createCatalogStore(database),
    logger: silent,
    now: () => at,
    gamma: { baseUrl: 'https://gamma.test', fetch },
  });
}

async function truncate(): Promise<void> {
  await sql`truncate raw_payloads, market_revisions, price_snapshots, markets, events restart identity cascade`;
}

type Row = Record<string, unknown>;

function withoutTimeBasedColumns(rows: Row[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !TIME_BASED_COLUMNS.has(key))),
  );
}

interface Snapshot {
  events: Row[];
  markets: Row[];
  revisions: Row[];
  priceSnapshots: Row[];
  rawPayloads: Row[];
}

/** Every table, ordered deterministically, minus the wall-clock columns. */
async function snapshot(): Promise<Snapshot> {
  return {
    events: withoutTimeBasedColumns(await database.select().from(events).orderBy(events.id)),
    markets: withoutTimeBasedColumns(
      await database.select().from(markets).orderBy(markets.conditionId),
    ),
    revisions: withoutTimeBasedColumns(
      await database.select().from(marketRevisions).orderBy(marketRevisions.id),
    ),
    priceSnapshots: withoutTimeBasedColumns(
      await database.select().from(priceSnapshots).orderBy(priceSnapshots.conditionId),
    ),
    rawPayloads: withoutTimeBasedColumns(
      await database.select().from(rawPayloads).orderBy(rawPayloads.responseHash),
    ),
  };
}

/** Primary keys whose row differs between two snapshots of the same table. */
function changedKeys(before: Row[], after: Row[], key: string): string[] {
  const index = new Map(before.map((row) => [String(row[key]), JSON.stringify(row)]));
  const changed: string[] = [];

  for (const row of after) {
    const id = String(row[key]);
    const previous = index.get(id);
    if (previous === undefined || previous !== JSON.stringify(row)) changed.push(id);
  }

  return changed.toSorted();
}

describe.skipIf(!canRun)('catalog ingest is idempotent', () => {
  beforeAll(async () => {
    let url = explicitUrl;

    if (url === undefined) {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
      url = container.getConnectionUri();
      stopContainer = async () => {
        await container.stop();
      };
    }

    sql = postgres(url, { max: 4, onnotice: () => {} });
    database = drizzle(sql, { schema });
    await migrate(sql);
  }, 240_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await stopContainer?.();
  }, 60_000);

  it(
    'a second identical run writes nothing',
    async () => {
      await truncate();

      const first = await ingest(RUN_ONE_AT, catalogFetch());

      // Guard: if the fixtures failed to load, everything below passes vacuously.
      expect(first.events.seen).toBe(60);
      expect(first.markets.seen).toBe(202);
      expect(first.markets.created).toBe(195);
      expect(first.markets.skipped).toBe(7);
      expect(first.revisions).toBe(0);
      expect(first.complete).toBe(true);

      const before = await snapshot();
      expect(before.markets).toHaveLength(195);
      expect(before.events).toHaveLength(60);
      expect(before.rawPayloads).toHaveLength(3);

      // The same crawl again, at a different time, through a fresh client.
      const second = await ingest(RUN_TWO_AT, catalogFetch());

      expect(second.markets).toEqual({
        seen: 202,
        created: 0,
        updated: 0,
        unchanged: 195,
        skipped: 7,
      });
      expect(second.revisions).toBe(0);
      expect(second.rawPayloads).toEqual({ archived: 0, duplicate: 3 });
      expect(second.missing).toBe(0);

      const after = await snapshot();

      // The whole assertion, in one line: nothing but the clock moved.
      expect(after).toEqual(before);
      expect(after.revisions).toHaveLength(0);
      expect(after.markets).toHaveLength(195);
      expect(after.rawPayloads).toHaveLength(3);
    },
    120_000,
  );

  it(
    'last_seen_at is the only column that moves',
    async () => {
      await truncate();
      await ingest(RUN_ONE_AT, catalogFetch());
      await ingest(RUN_TWO_AT, catalogFetch());

      const rows = await database.select().from(markets).orderBy(markets.conditionId);

      for (const row of rows) {
        expect(row.lastSeenAt).toEqual(RUN_TWO_AT);
        // Excluded from the snapshot above precisely so this can be asserted
        // directly: the first sighting must survive every later run.
        expect(row.firstSeenAt).toEqual(RUN_ONE_AT);
        expect(row.missingSince).toBeNull();
      }

      const eventRows = await database.select().from(events);
      for (const row of eventRows) expect(row.firstSeenAt).toEqual(RUN_ONE_AT);
    },
    120_000,
  );

  it(
    'three edited fields produce exactly three revisions and nothing else',
    async () => {
      await truncate();
      await ingest(RUN_ONE_AT, catalogFetch());
      const before = await snapshot();

      // Three markets, one field each, all on page one — so exactly one of the
      // three archived payloads changes, and the other two must still dedupe.
      const edited: string[] = [];
      const fetch = catalogFetch((pages) => {
        const candidates = pages[0]!.data
          .flatMap((event) => event.markets)
          .filter((market) => typeof market['conditionId'] === 'string');

        const [a, b, c] = candidates;
        if (a === undefined || b === undefined || c === undefined) {
          throw new Error('fixture page one has fewer than three storable markets');
        }

        a['question'] = `EDITED — ${String(a['question'])}`;
        b['description'] = 'EDITED: resolution criteria reworded after launch.';
        c['closed'] = !(c['closed'] as boolean);

        edited.push(...[a, b, c].map((market) => String(market['conditionId'])));
      });

      const summary = await ingest(RUN_TWO_AT, fetch);

      expect(summary.markets).toEqual({
        seen: 202,
        created: 0,
        updated: 3,
        unchanged: 192,
        skipped: 7,
      });
      expect(summary.revisions).toBe(3);

      const after = await snapshot();

      // Exactly three revisions, one per edited market.
      expect(after.revisions).toHaveLength(3);
      expect(after.revisions.map((row) => String(row['conditionId'])).toSorted()).toEqual(
        [...edited].toSorted(),
      );
      expect(after.revisions.map((row) => String(row['field'])).toSorted()).toEqual([
        'closed',
        'description',
        'question',
      ]);

      for (const revision of after.revisions) {
        expect(revision['contentHashBefore']).not.toBe(revision['contentHashAfter']);
        expect(revision['oldValue']).not.toEqual(revision['newValue']);
      }

      // Exactly three market rows differ, and they are the three we edited.
      expect(changedKeys(before.markets, after.markets, 'conditionId')).toEqual([...edited].toSorted());
      expect(after.markets).toHaveLength(195);

      // Nothing else moved: events untouched, and only page one re-archived.
      expect(after.events).toEqual(before.events);
      expect(after.priceSnapshots).toEqual(before.priceSnapshots);
      expect(after.rawPayloads).toHaveLength(4);
      expect(summary.rawPayloads).toEqual({ archived: 1, duplicate: 2 });
    },
    120_000,
  );

  it(
    'a third run after the edit is idempotent again',
    async () => {
      await truncate();
      await ingest(RUN_ONE_AT, catalogFetch());

      const fetch = () =>
        catalogFetch((pages) => {
          const first = pages[0]!.data.flatMap((event) => event.markets).find(
            (market) => typeof market['conditionId'] === 'string',
          );
          first!['question'] = 'EDITED once, then left alone';
        });

      await ingest(RUN_TWO_AT, fetch());
      const before = await snapshot();

      // The edit has landed; re-crawling the edited catalog must settle.
      const third = await ingest(new Date('2026-03-03T00:00:00Z'), fetch());

      expect(third.markets.updated).toBe(0);
      expect(third.markets.unchanged).toBe(195);
      expect(third.revisions).toBe(0);
      expect(await snapshot()).toEqual(before);
    },
    120_000,
  );
});
