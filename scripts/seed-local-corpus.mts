/**
 * Seeds the local pgvector database from the committed corpus fixture.
 *
 * The fixture carries four fields per market — conditionId, question, endDate,
 * eventId — because it was captured to exercise the threshold-ladder parser,
 * which needs nothing else. Every other column is therefore left NULL rather
 * than filled with a plausible-looking default.
 *
 * That is a deliberate correction. An earlier version of this script wrote
 * `["Yes","No"]` into `outcomes` as a placeholder; a large part of the real
 * catalog resolves to ["Over","Under"], ["Favorite","Underdog"], or a pair of
 * team names, so the placeholder was not merely absent data but wrong data
 * sitting in a column that reads as authoritative. A NULL announces itself; a
 * fabricated value does not.
 *
 * Run `scripts/backfill-local-criteria.mts` afterwards to populate descriptions,
 * outcomes, and negRisk from the live API.
 */
import { readFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';

import { db, closeDatabase } from '../src/db/client.js';
import { events, markets } from '../src/db/schema.js';
import { contentHash, contentOf } from '../src/jobs/ingest-catalog.js';
import { extractAllRelations } from '../src/relations/extract.js';
import { saveRelationEdges, saveRelationGroups } from '../src/relations/store.js';

interface FixtureMarket {
  conditionId: string;
  question: string;
  endDate: string | null;
  eventId: string | null;
}

const corpus = JSON.parse(
  readFileSync('test/fixtures/relations/catalog-sample.json', 'utf8'),
) as { markets: FixtureMarket[] };
const rows = corpus.markets;

const eventIds = [...new Set(rows.map((r) => r.eventId).filter((x): x is string => Boolean(x)))];
await db
  .insert(events)
  .values(eventIds.map((id) => ({ id, slug: `e-${id}`, title: `Event ${id}` })))
  .onConflictDoNothing();

for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500).map((r) => {
    const content = {
      question: r.question,
      description: null,
      resolutionSource: null,
      outcomes: null,
      clobTokenIds: null,
      endDate: r.endDate ? new Date(r.endDate) : null,
      active: true,
      closed: false,
    };
    return {
      conditionId: r.conditionId,
      eventId: r.eventId,
      question: r.question,
      endDate: content.endDate,
      active: true,
      closed: false,
      contentHash: contentHash(contentOf(content)),
    };
  });
  await db.insert(markets).values(batch).onConflictDoNothing();
}
const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int n from markets`);
console.log('markets seeded:', n);

// Deterministic edges first: candidate generation must exclude what they cover.
const extraction = extractAllRelations(
  rows.map((r) => ({
    conditionId: r.conditionId,
    question: r.question,
    eventId: r.eventId,
    endDate: r.endDate,
    outcomes: null,
  })),
  eventIds.map((id) => ({ eventId: id, negRisk: null })),
);
await saveRelationEdges(extraction.edges, db);
await saveRelationGroups(extraction.groups, db);
console.log('deterministic edges:', extraction.edges.length, ' groups:', extraction.groups.length);
await closeDatabase();
