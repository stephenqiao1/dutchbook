import { sql } from 'drizzle-orm';

import { closeDatabase, db } from '../db/client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { extractAllRelations, type CatalogEvent, type CatalogMarket } from './extract.js';
import { saveRelationEdges, saveRelationGroups } from './store.js';

/**
 * `pnpm relations:extract`
 *
 * Runs every deterministic extractor over the catalog as it currently stands in
 * the database, and persists the result.
 *
 * This is the step the LLM pipeline depends on being current. Candidate
 * generation subtracts everything the deterministic layer already explains, so
 * a stale `relations` table does not merely miss edges — it sends the model
 * pairs whose answer was already known, and spends money to rediscover them.
 */

const log = createLogger('relations:extract');

interface MarketRow extends Record<string, unknown> {
  condition_id: string;
  question: string;
  description: string | null;
  event_id: string | null;
  end_date: Date | null;
  outcomes: string[] | null;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  neg_risk: boolean | null;
  title: string | null;
}

async function main(): Promise<number> {
  const marketRows = await db.execute<MarketRow>(sql`
    select condition_id, question, description, event_id, end_date, outcomes
    from markets
    where question is not null and question <> '' and missing_since is null
  `);
  const eventRows = await db.execute<EventRow>(sql`select id, neg_risk, title from events`);

  const markets: CatalogMarket[] = marketRows.map((row) => ({
    conditionId: row.condition_id,
    question: row.question,
    description: row.description,
    eventId: row.event_id,
    endDate: row.end_date,
    outcomes: row.outcomes,
  }));
  const events: CatalogEvent[] = eventRows.map((row) => ({
    eventId: row.id,
    negRisk: row.neg_risk,
    title: row.title,
  }));

  log.info({ markets: markets.length, events: events.length }, 'extracting');
  const result = extractAllRelations(markets, events);

  const edges = await saveRelationEdges(result.edges, db);
  const groups = await saveRelationGroups(result.groups, db);

  // Conflicts are loud on purpose: a ladder implication that contradicts a
  // venue-asserted partition means one of the two extractors is wrong, and the
  // venue is the one with settlement authority.
  for (const conflict of result.conflicts.slice(0, 20)) {
    log.error({ conflict }, 'implication contradicts a venue-asserted partition');
  }

  process.stdout.write(
    [
      '',
      '  ── deterministic extraction ───────────────────────────────────',
      `  markets           ${result.stats.markets}`,
      `  ladder edges      ${result.stats.ladderEdges}`,
      `  temporal edges    ${result.stats.temporalEdges}`,
      `  complement edges  ${result.stats.complementEdges}`,
      `  partitions        ${result.stats.partitions} (${result.stats.partitionMembers} members)`,
      `  conflicts         ${result.stats.conflicts}`,
      '',
      `  persisted         ${edges.inserted} new edges, ${edges.refreshed} refreshed`,
      `                    ${groups.inserted} new groups, ${groups.refreshed} refreshed`,
      '  ───────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );

  return result.stats.conflicts > 0 ? 2 : 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  log.error({ error: describeError(error) }, 'extraction failed');
}
await closeDatabase().catch(() => {});
process.exit(code);
