import { sql } from 'drizzle-orm';

import { closeDatabase, db } from '../db/client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { buildRelationGraph, type CatalogEvent, type CatalogMarket } from './extract.js';
import { relatedTo } from './graph.js';

/**
 * `pnpm relations:inspect <condition_id>`
 *
 * Prints every market related to the given one, with the relation type and the
 * extractor that produced it.
 *
 * The graph is rebuilt from the catalog on each run rather than read back from
 * the `relations` table, so what is printed is what the current code derives —
 * which is what you want when the question is "why did it claim that?".
 */

const log = createLogger('relations:inspect');

/** Terminal width is finite and questions are not. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const LABELS: Readonly<Record<string, string>> = {
  implies: 'implies       →',
  'implied-by': 'implied by    ←',
  complement: 'complement    ↔',
  partition: 'partition     ⊕',
};

async function main(conditionId: string): Promise<number> {
  const rows = await db.execute<{
    condition_id: string;
    event_id: string | null;
    question: string;
    end_date: Date | null;
    outcomes: string[] | null;
    neg_risk: boolean | null;
    event_title: string | null;
  }>(sql`
    select m.condition_id, m.event_id, m.question, m.end_date, m.outcomes,
           e.neg_risk, e.title as event_title
    from markets m
    left join events e on e.id = m.event_id
    where m.event_id in (
      -- The relation graph only ever links markets inside one event, so the
      -- events touching this market are all that has to be loaded.
      select event_id from markets where condition_id = ${conditionId}
    )
  `);

  if (rows.length === 0) {
    process.stdout.write(`no market found with condition_id ${conditionId}\n`);
    return 1;
  }

  const markets: CatalogMarket[] = rows.map((r) => ({
    conditionId: r.condition_id,
    question: r.question,
    eventId: r.event_id,
    endDate: r.end_date,
    outcomes: r.outcomes,
  }));

  const events: CatalogEvent[] = [
    ...new Map(
      rows
        .filter((r) => r.event_id !== null)
        .map((r) => [
          r.event_id,
          { eventId: r.event_id ?? '', negRisk: r.neg_risk, title: r.event_title },
        ]),
    ).values(),
  ];

  const { graph, extraction } = buildRelationGraph(markets, events, { tolerateCycles: true });
  const questions = new Map(markets.map((m) => [m.conditionId, m.question] as const));

  const self = questions.get(conditionId);
  if (self === undefined) {
    process.stdout.write(`no market found with condition_id ${conditionId}\n`);
    return 1;
  }

  const lines: string[] = [
    '',
    `  ${conditionId}`,
    `  ${self}`,
    `  event ${rows.find((r) => r.condition_id === conditionId)?.event_id ?? '—'}`,
    '',
  ];

  const related = relatedTo(graph, conditionId);

  if (related.length === 0) {
    lines.push('  no relations found', '');
  } else {
    const order = ['implies', 'implied-by', 'complement', 'partition'] as const;
    for (const kind of order) {
      const group = related.filter((r) => r.relation === kind);
      if (group.length === 0) continue;

      lines.push(`  ${kind.toUpperCase()} (${group.length})`);
      for (const item of group) {
        const marker = item.direct ? ' ' : '·';
        lines.push(
          `   ${marker} ${LABELS[item.relation] ?? item.relation}  [${item.source}]`,
          `       ${item.conditionId}`,
          `       ${truncate(questions.get(item.conditionId) ?? '(unknown market)', 92)}`,
        );
      }
      lines.push('');
    }
    lines.push('  · = implied transitively, not a stored edge', '');
  }

  lines.push(
    `  graph: ${graph.stats.nodes} nodes, ${graph.stats.reducedEdges} reduced edges ` +
      `(${graph.stats.impliesEdges} before reduction), ${graph.stats.complementEdges} complements, ` +
      `${graph.stats.partitions} partitions`,
  );
  if (extraction.conflicts.length > 0) {
    lines.push(`  WARNING: ${extraction.conflicts.length} edge(s) contradicted a partition`);
  }
  if (graph.stats.cyclesFound > 0) {
    lines.push(`  WARNING: ${graph.stats.cyclesFound} implication cycle(s) found and dropped`);
  }
  lines.push('');

  process.stdout.write(lines.join('\n'));
  return 0;
}

const target = process.argv[2];
let code = 1;

if (target === undefined || target === '') {
  process.stdout.write('usage: pnpm relations:inspect <condition_id>\n');
} else {
  try {
    code = await main(target);
  } catch (error) {
    log.error({ error: describeError(error) }, 'inspect failed');
  }
}

await closeDatabase().catch(() => {});
process.exit(code);
