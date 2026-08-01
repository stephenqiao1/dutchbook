import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { marketEmbeddings } from '../db/schema.js';
import { createLogger } from '../logger.js';
import { embeddingText, type Embedder } from './embeddings.js';
import { canonicalPair } from './types.js';

/**
 * Candidate generation.
 *
 * Every pair is O(n²): at 300k markets that is 45 billion comparisons, and
 * classifying even a thousandth of them would be 45 million model calls. So
 * pairs come from a vector index instead — each market's nearest neighbours
 * above a similarity floor — and everything already explained by a
 * deterministic extractor, or already proposed once, is subtracted.
 *
 * The subtraction is what makes a re-run free. A pair that has been proposed,
 * accepted, or rejected is never a candidate again.
 */

const log = createLogger('candidates');

type Database = PostgresJsDatabase<typeof schema>;

/** Below this the pairs are noise; above it they are usually the same family. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

export interface EmbedMarketsOptions {
  /** Rows per model call and per insert. */
  readonly batchSize?: number;
  /** Recompute even when the stored `content_hash` still matches. */
  readonly force?: boolean;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface MarketToEmbed {
  readonly conditionId: string;
  readonly question: string;
  readonly contentHash: string;
}

/**
 * Embeds markets whose vector is missing or stale.
 *
 * Staleness is keyed on the market's own `content_hash`, so a crawl that
 * changed nothing re-embeds nothing — the expensive step runs only when the
 * question actually moved.
 */
export async function embedMarkets(
  markets: readonly MarketToEmbed[],
  embedder: Embedder,
  database: Database = db,
  options: EmbedMarketsOptions = {},
): Promise<{ embedded: number; skipped: number }> {
  const batchSize = options.batchSize ?? 128;

  const existing = new Map<string, string>();
  if (options.force !== true) {
    const rows = await database
      .select({
        conditionId: marketEmbeddings.conditionId,
        contentHash: marketEmbeddings.contentHash,
        model: marketEmbeddings.model,
      })
      .from(marketEmbeddings);
    for (const row of rows) {
      if (row.model === embedder.model) existing.set(row.conditionId, row.contentHash);
    }
  }

  const pending = markets.filter((m) => existing.get(m.conditionId) !== m.contentHash);
  let embedded = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map((m) => embeddingText(m.question)));

    await database
      .insert(marketEmbeddings)
      .values(
        batch.map((market, index) => ({
          conditionId: market.conditionId,
          model: embedder.model,
          contentHash: market.contentHash,
          embedding: vectors[index] ?? [],
        })),
      )
      .onConflictDoUpdate({
        target: marketEmbeddings.conditionId,
        set: {
          model: sql`excluded.model`,
          contentHash: sql`excluded.content_hash`,
          embedding: sql`excluded.embedding`,
          createdAt: sql`now()`,
        },
      });

    embedded += batch.length;
    options.onProgress?.(embedded, pending.length);
  }

  log.info(
    { embedded, skipped: markets.length - pending.length, model: embedder.model },
    'market embeddings up to date',
  );
  return { embedded, skipped: markets.length - pending.length };
}

export interface CandidateRow {
  readonly lowConditionId: string;
  readonly highConditionId: string;
  readonly similarity: number;
}

export interface FindCandidatesOptions {
  readonly threshold?: number;
  /** Nearest neighbours examined per market. */
  readonly neighbours?: number;
  /** Cap on returned pairs, highest similarity first. */
  readonly limit?: number;
  /**
   * Restrict to pairs inside one event. Cross-event pairs are mostly noise —
   * the same template reused a week later — and the deterministic extractors
   * are already event-scoped.
   */
  readonly sameEventOnly?: boolean;
  /**
   * `similarity` takes the most-similar pairs first. `spread` takes a uniform
   * sample of the eligible population instead, ordered by a hash of the pair.
   *
   * The distinction decides what an acceptance rate measured downstream can be
   * a claim *about*. Ordering by similarity concentrates the sample in the
   * near-duplicate tail, where any classifier looks good; a hash is
   * uncorrelated with similarity, so the sample stands in for the population
   * the pipeline would actually process. It is a hash rather than `random()`
   * so the same run twice draws the same pairs.
   */
  readonly order?: 'similarity' | 'spread';
}

/**
 * Nearest-neighbour pairs that no deterministic edge and no prior proposal
 * already covers.
 *
 * Done in SQL rather than in the application: the exclusions are anti-joins
 * over indexed tables, and pulling candidates into memory to filter them there
 * would mean transferring the very pairs the query exists to discard.
 */
export async function findCandidatePairs(
  database: Database = db,
  options: FindCandidatesOptions = {},
): Promise<CandidateRow[]> {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const neighbours = options.neighbours ?? 8;
  const limit = options.limit ?? 500;
  const sameEventOnly = options.sameEventOnly ?? true;
  const ordering =
    options.order === 'spread'
      ? sql`md5(p.low_condition_id || p.high_condition_id)`
      : sql`p.similarity desc`;

  // `1 - (a <=> b)` is cosine similarity for normalised vectors.
  const rows = await database.execute<{
    low_condition_id: string;
    high_condition_id: string;
    similarity: number;
  }>(sql`
    with recursive neighbours as (
      select
        e.condition_id as source_id,
        n.condition_id as target_id,
        1 - (e.embedding <=> n.embedding) as similarity
      from market_embeddings e
      cross join lateral (
        select n.condition_id, n.embedding
        from market_embeddings n
        join markets nm on nm.condition_id = n.condition_id
        join markets em on em.condition_id = e.condition_id
        where n.condition_id <> e.condition_id
          and (${sameEventOnly} = false or nm.event_id = em.event_id)
        order by n.embedding <=> e.embedding
        limit ${neighbours}
      ) n
    ),
    pairs as (
      select
        least(source_id, target_id) as low_condition_id,
        greatest(source_id, target_id) as high_condition_id,
        max(similarity) as similarity
      from neighbours
      where similarity >= ${threshold}
      group by 1, 2
    )
    ,
    -- Transitive closure of the implication graph.
    --
    -- This anti-join is not an optimisation, it is a correctness fix. Ladders
    -- store *adjacent* rungs only, because implication is transitive and an
    -- 88-rung ladder is 87 edges rather than 3,828. So "above 222" and
    -- "above 212" are connected by a path but not by an edge, and a direct-edge
    -- test alone let 45% of one 220-pair sample through as "uncovered" — pairs
    -- whose answer the deterministic layer already knew. That is money spent to
    -- rediscover arithmetic, and worse, it flatters any precision figure
    -- measured downstream with pairs that were never in question.
    --
    -- UNION rather than UNION ALL: it deduplicates, so the recursion terminates
    -- even if a cycle ever reaches this table.
    reachable(src, dst) as (
      select from_condition_id, to_condition_id from relations where type = 'implies'
      union
      select r.src, e.to_condition_id
      from reachable r
      join relations e on e.from_condition_id = r.dst and e.type = 'implies'
    )
    select p.low_condition_id, p.high_condition_id, p.similarity
    from pairs p
    -- Already explained deterministically, in either direction, directly or
    -- through a chain.
    where not exists (
      select 1 from reachable r
      where (r.src = p.low_condition_id and r.dst = p.high_condition_id)
         or (r.src = p.high_condition_id and r.dst = p.low_condition_id)
    )
    and not exists (
      select 1 from relations r
      where (r.from_condition_id = p.low_condition_id and r.to_condition_id = p.high_condition_id)
         or (r.from_condition_id = p.high_condition_id and r.to_condition_id = p.low_condition_id)
    )
    -- Already in a partition together, which is a stronger claim than anything
    -- the model could add about the pair.
    and not exists (
      select 1
      from relation_group_members a
      join relation_group_members b on b.group_id = a.group_id
      where a.condition_id = p.low_condition_id and b.condition_id = p.high_condition_id
    )
    -- Already proposed once. This is what makes a re-run cost zero calls.
    and not exists (
      select 1 from relation_proposals rp
      where rp.low_condition_id = p.low_condition_id
        and rp.high_condition_id = p.high_condition_id
    )
    order by ${ordering}
    limit ${limit}
  `);

  return rows.map((row) => ({
    lowConditionId: row.low_condition_id,
    highConditionId: row.high_condition_id,
    similarity: Number(row.similarity),
  }));
}

/** Canonicalises a pair the way the unique constraint expects. */
export function toCanonical(a: string, b: string): { low: string; high: string } {
  const [low, high] = canonicalPair(a, b);
  return { low, high };
}
