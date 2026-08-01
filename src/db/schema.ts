import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle table definitions.
 *
 * The catalog tables model Polymarket as a mutable upstream: markets are
 * renamed, re-tagged, closed, and reopened in place, and the vendor keeps no
 * history of it. So the ingest is a reconciliation rather than an append —
 * `markets` holds current state, `market_revisions` holds the audit trail of
 * every semantic edit, and nothing is ever deleted.
 *
 * Workflow: edit this file, `pnpm db:generate`, review the SQL in `drizzle/`,
 * commit it, then `pnpm db:migrate`.
 */

/**
 * A Polymarket event — a group of related markets ("Fed decision in March").
 *
 * `first_seen_at` and `last_seen_at` are ours, not the vendor's: they record
 * when *we* observed the row, which is the only trustworthy basis for deciding
 * something has gone missing.
 */
export const events = pgTable(
  'events',
  {
    /** Polymarket's event id, as a string — it arrives as both string and number. */
    id: text('id').primaryKey(),
    slug: text('slug'),
    title: text('title'),
    negRisk: boolean('neg_risk'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * When we *first observed* the event closed, not when Polymarket says it
     * closed. Write-once: later crawls must not move it, or an event that
     * reopens and re-closes would erase the original timestamp.
     */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    index('events_slug_idx').on(table.slug),
    index('events_last_seen_at_idx').on(table.lastSeenAt),
  ],
);

/**
 * A single market, keyed by its on-chain condition id.
 *
 * `condition_id` rather than Polymarket's numeric `id` is the primary key
 * because it is the identifier shared with the CLOB and the chain, and the one
 * that survives the vendor renumbering its own catalog.
 */
export const markets = pgTable(
  'markets',
  {
    conditionId: text('condition_id').primaryKey(),

    /** Nulled rather than cascaded: losing an event must not lose the market. */
    eventId: text('event_id').references(() => events.id, { onDelete: 'set null' }),

    question: text('question'),
    slug: text('slug'),
    description: text('description'),
    resolutionSource: text('resolution_source'),

    /** Ordered: index 0 pairs with `clob_token_ids[0]` and outcome price 0. */
    outcomes: jsonb('outcomes').$type<string[]>(),
    endDate: timestamp('end_date', { withTimezone: true }),

    active: boolean('active'),
    closed: boolean('closed'),
    archived: boolean('archived'),

    clobTokenIds: jsonb('clob_token_ids').$type<string[]>(),

    /**
     * SHA-256 over the semantically meaningful fields only — see
     * `HASHED_FIELDS` in `src/jobs/ingest-catalog.ts`. Volume, prices, and
     * liquidity are excluded on purpose: they change every crawl and would
     * make every market look edited on every run.
     */
    contentHash: text('content_hash').notNull(),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Set by the reconciliation sweep to the `last_seen_at` of the crawl that
     * last returned this market, once a later complete crawl has not. Cleared
     * the moment the market reappears — markets do come back.
     *
     * Rows are never deleted, so this column is how "gone" is expressed.
     */
    missingSince: timestamp('missing_since', { withTimezone: true }),
  },
  (table) => [
    index('markets_event_id_idx').on(table.eventId),
    index('markets_last_seen_at_idx').on(table.lastSeenAt),
    index('markets_missing_since_idx').on(table.missingSince),
    index('markets_slug_idx').on(table.slug),
  ],
);

/**
 * One row per field per edit — the point of the whole pipeline.
 *
 * Polymarket rewrites market text in place. This is the only record that a
 * question was reworded or a resolution source swapped after people had already
 * traded on it, so rows here are append-only and never updated.
 *
 * `content_hash_before`/`_after` bracket the edit: every revision written by a
 * single crawl shares a pair, which is what lets you reconstruct a market's
 * exact state at any point by replaying them.
 */
export const marketRevisions = pgTable(
  'market_revisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    conditionId: text('condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),

    /** When we detected the change, not when the vendor made it — unknowable. */
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),

    /** The `markets` column name, e.g. `question` or `resolution_source`. */
    field: text('field').notNull(),

    /** jsonb, not text, so booleans, nulls, and outcome arrays survive intact. */
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),

    contentHashBefore: text('content_hash_before').notNull(),
    contentHashAfter: text('content_hash_after').notNull(),
  },
  (table) => [
    index('market_revisions_condition_id_changed_at_idx').on(table.conditionId, table.changedAt),
    index('market_revisions_field_idx').on(table.field),
    index('market_revisions_changed_at_idx').on(table.changedAt),
  ],
);

/** One persisted order-book level. Prices and sizes as numbers, in USDC/shares. */
export interface DepthLevel {
  readonly price: number;
  readonly size: number;
}

/**
 * Point-in-time order book per outcome token, with depth.
 *
 * Keyed by (condition_id, token_id, ts) so re-running a collector over a window
 * it already covered overwrites rather than duplicates. `numeric` rather than
 * float for the scalar quotes: these are prices, and float drift in a book is
 * not worth the bytes saved.
 *
 * **The depth columns are the point of this table.** A midpoint is not a price
 * anyone can trade at, and a stored midpoint cannot answer the only question
 * that matters later — "what would 500 shares actually have cost at that
 * moment?" Keeping the top ten levels per side means a historical violation can
 * be re-priced against the depth that really existed, rather than against a
 * number that implies infinite liquidity at the touch. Recording only the
 * midpoint would make every past opportunity look executable.
 */
export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    conditionId: text('condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),

    /** CLOB ERC-1155 token id — one per outcome, ordered as `markets.outcomes`. */
    tokenId: text('token_id').notNull(),

    ts: timestamp('ts', { withTimezone: true }).notNull(),

    bid: numeric('bid', { precision: 18, scale: 8 }),
    ask: numeric('ask', { precision: 18, scale: 8 }),
    mid: numeric('mid', { precision: 18, scale: 8 }),

    /** `ask - bid`. Null on a one-sided book, which has no spread. */
    spread: numeric('spread', { precision: 18, scale: 8 }),

    /**
     * Top ten levels, best-first (bids descending, asks ascending) — the same
     * order {@link OrderBook} guarantees, so a stored book walks identically to
     * a live one with no re-sorting at read time.
     */
    bids: jsonb('bids').$type<DepthLevel[]>(),
    asks: jsonb('asks').$type<DepthLevel[]>(),

    /** Total shares resting on each side, across the *whole* book, not just the
     * ten stored levels — so truncation is visible rather than silent. */
    bidDepth: numeric('bid_depth', { precision: 24, scale: 8 }),
    askDepth: numeric('ask_depth', { precision: 24, scale: 8 }),

    /**
     * The venue's own book timestamp, distinct from `ts`.
     *
     * `ts` is when we recorded it; this is when the venue built it. The gap
     * between them is the staleness that makes a Gamma-derived price an
     * illusion, and it is only measurable if both are kept.
     */
    bookTs: timestamp('book_ts', { withTimezone: true }),

    /** The venue's book hash, for detecting an unchanged book across polls. */
    bookHash: text('book_hash'),

    /** Where the quote came from, e.g. `clob-book` or `gamma-market`. */
    source: text('source').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conditionId, table.tokenId, table.ts] }),
    index('price_snapshots_ts_idx').on(table.ts),
    index('price_snapshots_token_ts_idx').on(table.tokenId, table.ts),
  ],
);

/**
 * Every response the client received, archived before validation.
 *
 * Written ahead of parsing on purpose: a payload that later fails to parse is
 * the one you most need to look at, and this table is the only way to re-derive
 * the catalog if the parsing logic turns out to have been wrong.
 *
 * `response_hash` is unique, so a catalog that has not changed between crawls
 * costs one row rather than one per run. Two endpoints returning byte-identical
 * bodies collapse to a single row, attributed to whichever arrived first — that
 * is the intended dedupe, not a collision.
 */
export const rawPayloads = pgTable(
  'raw_payloads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    /** Path plus query, e.g. `/events/keyset?limit=100&after_cursor=MTAwMA==`. */
    endpoint: text('endpoint').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

    body: jsonb('body').notNull(),

    /** SHA-256 over the canonicalised body. */
    responseHash: text('response_hash').notNull(),
  },
  (table) => [
    uniqueIndex('raw_payloads_response_hash_key').on(table.responseHash),
    index('raw_payloads_endpoint_fetched_at_idx').on(table.endpoint, table.fetchedAt),
  ],
);

/**
 * Directed relations between markets.
 *
 * A row asserts a logical constraint that holds by construction, not by
 * correlation: `implies` from A to B means every world where A resolves Yes is
 * a world where B resolves Yes, and therefore P(A) <= P(B). Edges derived from
 * a threshold ladder carry confidence 1.0 because the entailment is arithmetic.
 *
 * `source` records how the edge was derived, so a later, less certain extractor
 * can add rows here without its guesses being mistaken for entailments.
 *
 * The unique constraint is what makes re-extraction idempotent: rediscovering
 * the same relation refreshes `last_seen_at` rather than inserting a duplicate.
 */
export const relations = pgTable(
  'relations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    fromConditionId: text('from_condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),
    toConditionId: text('to_condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),

    /** Relation kind. `implies` today; `excludes`/`equivalent` are foreseeable. */
    type: text('type').notNull(),
    /** Extractor that produced it, e.g. `ladder`. */
    source: text('source').notNull(),

    /** 1.0 for entailments. Reserved for extractors that are not certain. */
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),

    /** Human-readable justification, carried so an edge can be audited later. */
    rationale: text('rationale'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('relations_edge_key').on(table.fromConditionId, table.toConditionId, table.type),
    index('relations_from_idx').on(table.fromConditionId),
    index('relations_to_idx').on(table.toConditionId),
    index('relations_source_idx').on(table.source),
    // A market cannot imply itself, and an edge that says so is a bug upstream.
    check('relations_no_self_edge', sql`${table.fromConditionId} <> ${table.toConditionId}`),
  ],
);

/**
 * Set-valued relations, which a pairwise table cannot express.
 *
 * A partition asserts that its members are mutually exclusive *and* exhaustive,
 * so their Yes probabilities sum to exactly 1. Decomposing that into pairs
 * loses the second half: pairwise exclusivity only bounds the sum at 1, and it
 * is exhaustiveness — a property of the whole set — that pins it.
 *
 * `key` is derived from the source (`partition:neg-risk-event:<id>`), so
 * re-extraction upserts the same group rather than accumulating copies.
 */
export const relationGroups = pgTable(
  'relation_groups',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    /** `partition` today. */
    type: text('type').notNull(),
    /** `neg-risk-event` — the venue's own exclusivity flag. */
    source: text('source').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    rationale: text('rationale'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('relation_groups_key').on(table.key),
    index('relation_groups_type_idx').on(table.type),
  ],
);

/**
 * Membership of a {@link relationGroups} set.
 *
 * Cascades from both sides: a group without its members is meaningless, and a
 * market that no longer exists cannot be part of a partition of live outcomes.
 */
export const relationGroupMembers = pgTable(
  'relation_group_members',
  {
    groupId: bigserial('group_id', { mode: 'number' })
      .notNull()
      .references(() => relationGroups.id, { onDelete: 'cascade' }),
    conditionId: text('condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.conditionId] }),
    index('relation_group_members_condition_idx').on(table.conditionId),
  ],
);

/** Dimensionality of the local sentence-transformer used for candidates. */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * A question embedding, for nearest-neighbour candidate generation.
 *
 * Comparing every pair of markets is O(n²) — at 300k markets that is 45 billion
 * comparisons, and sending any meaningful fraction of them to a model is not a
 * pipeline, it is a bill. So pairs are drawn from a vector index instead, and
 * only the semantically close ones are ever considered.
 *
 * `content_hash` is the market's own hash: the embedding is recomputed only
 * when the question actually changed, not on every crawl.
 */
export const marketEmbeddings = pgTable(
  'market_embeddings',
  {
    conditionId: text('condition_id')
      .primaryKey()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),
    /** Model that produced it, so a model change can be detected and re-run. */
    model: text('model').notNull(),
    /** The market `content_hash` the vector was computed from. */
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // HNSW over cosine distance: the index candidate generation reads.
    index('market_embeddings_hnsw').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('market_embeddings_model_idx').on(table.model),
  ],
);

/**
 * A model's suggestion about a pair — never an edge.
 *
 * Nothing here constrains any probability. A row becomes a relation only when a
 * reviewer accepts it, and acceptance writes a separate row into `relations`
 * with source `llm_reviewed`. That separation is the whole point: the model's
 * output is evidence, and the verdict is the fact.
 *
 * The pair is stored in canonical order and uniquely constrained, so a pair is
 * proposed at most once ever. A rejected pair stays rejected: re-running the
 * pipeline finds the row and does not call the model again.
 */
export const relationProposals = pgTable(
  'relation_proposals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    /** Lexicographically smaller condition id. */
    lowConditionId: text('low_condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),
    highConditionId: text('high_condition_id')
      .notNull()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),

    /** `implies` | `implied_by` | `mutually_exclusive` | `complement` | `unrelated`. */
    proposedType: text('proposed_type').notNull(),
    /** Direction is relative to (low, high), so it survives canonical ordering. */
    rationale: text('rationale').notNull(),
    /** The model's own confidence, 0-1. Advisory only; it gates nothing. */
    modelConfidence: numeric('model_confidence', { precision: 5, scale: 4 }).notNull(),
    model: text('model').notNull(),
    /** Cosine similarity that made the pair a candidate. */
    similarity: numeric('similarity', { precision: 6, scale: 5 }),

    /** `pending` | `accepted` | `rejected` | `skipped`. */
    status: text('status').notNull().default('pending'),
    /** Who decided. Null while pending. */
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Optional note from the reviewer, especially on a rejection. */
    reviewNote: text('review_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One proposal per pair, ever. This is what makes a re-run cost nothing.
    uniqueIndex('relation_proposals_pair').on(table.lowConditionId, table.highConditionId),
    index('relation_proposals_status_idx').on(table.status),
    index('relation_proposals_type_idx').on(table.proposedType),
    check('relation_proposals_ordered', sql`${table.lowConditionId} < ${table.highConditionId}`),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type MarketRow = typeof markets.$inferSelect;
export type NewMarketRow = typeof markets.$inferInsert;
export type MarketRevisionRow = typeof marketRevisions.$inferSelect;
export type NewMarketRevisionRow = typeof marketRevisions.$inferInsert;
/**
 * Latest Gamma quote per market — the cheap screen's whole input.
 *
 * A cache, not a history: one row per market, overwritten. `price_snapshots` is
 * where history lives. The split matters because the screen runs every 60
 * seconds over every constraint in the graph and needs a single indexed read,
 * not a `DISTINCT ON` over a growing time series.
 *
 * These are Gamma's numbers, which lag the book by seconds and describe no size
 * at all. That is *fine here and only here*: this table exists to decide which
 * constraints are worth spending an order-book request on. Nothing downstream
 * of the screen is allowed to price against it.
 */
export const marketQuotes = pgTable(
  'market_quotes',
  {
    conditionId: text('condition_id')
      .primaryKey()
      .references(() => markets.conditionId, { onDelete: 'cascade' }),

    /**
     * Probability of the *first* outcome, which is what every relation in
     * `relations` is written about. For a Yes/No market that is Yes; for an
     * Over/Under market it is Over; for a team market it is the named team.
     */
    yesPrice: numeric('yes_price', { precision: 18, scale: 8 }),
    bestBid: numeric('best_bid', { precision: 18, scale: 8 }),
    bestAsk: numeric('best_ask', { precision: 18, scale: 8 }),

    /** Gamma's own freshness, when it offers one. */
    quotedAt: timestamp('quoted_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('gamma-market'),
  },
  (table) => [index('market_quotes_fetched_at_idx').on(table.fetchedAt)],
);

/**
 * Coherence violations, as *episodes* rather than observations.
 *
 * The unit here is "this constraint was violated from T1 until T2", not "at
 * T we saw a violation". A row is opened when a constraint starts violating,
 * updated in place on every subsequent check, and closed when it stops. That
 * is what makes lifetime measurable at all — a table of per-tick observations
 * would need the episodes reconstructed afterwards, and reconstruction of a
 * signal you could have recorded directly is how lifetimes get quietly wrong.
 *
 * A partial unique index enforces at most one *open* episode per constraint,
 * so a checker that runs twice concurrently cannot fork one violation into two.
 * The same constraint violating again next week is a new episode, which is
 * correct: those are two separate opportunities, not one long one.
 */
export const violations = pgTable(
  'violations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    /**
     * Stable identity of the constraint, e.g. `implies:4213` or `partition:87`.
     * Derived from the relation or group id, so it survives a re-extraction
     * that renumbers nothing.
     */
    constraintKey: text('constraint_key').notNull(),

    /** `implies` | `complement` | `partition`. */
    kind: text('kind').notNull(),

    /** Relation ids behind this constraint. One for an edge, many for a group. */
    relationIds: jsonb('relation_ids').$type<number[]>().notNull(),
    /** `relation_groups.id` for a partition; null for a pairwise constraint. */
    groupId: text('group_id'),
    /** Every market the correcting trade touches. */
    conditionIds: jsonb('condition_ids').$type<string[]>().notNull(),

    /**
     * `apparent` — violated on the screen, but no profitable trade exists.
     * `confirmed` — a correcting trade with positive net edge at a real size.
     * `closed`    — no longer violating; `resolved_at` is set.
     */
    status: text('status').notNull(),

    /** Why an apparent violation was not confirmed. Null once confirmed. */
    reason: text('reason'),

    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /** True if this episode was ever confirmed, even if it later degraded. */
    everConfirmed: boolean('ever_confirmed').notNull().default(false),

    /** Screen-stage magnitude at detection, from Gamma midpoints. */
    screenMagnitude: numeric('screen_magnitude', { precision: 18, scale: 8 }),
    /** Best magnitude seen across the episode. */
    peakMagnitude: numeric('peak_magnitude', { precision: 18, scale: 8 }),

    /**
     * Best *net* edge per unit seen across the episode, after fees, and the
     * size at which it was achieved. Peak rather than latest because the
     * question a reader asks later is "was this ever worth taking".
     */
    peakNetEdge: numeric('peak_net_edge', { precision: 18, scale: 8 }),
    peakSize: numeric('peak_size', { precision: 24, scale: 8 }),
    /** Total dollars the peak trade would have returned: edge × size. */
    peakNetProfit: numeric('peak_net_profit', { precision: 24, scale: 8 }),

    /** The full trade construction at the peak — legs, prices, sizes, fees. */
    trade: jsonb('trade'),

    checks: bigserial('checks', { mode: 'number' }),
  },
  (table) => [
    // At most one open episode per constraint. This is the whole lifetime model.
    uniqueIndex('violations_one_open_per_constraint')
      .on(table.constraintKey)
      .where(sql`${table.resolvedAt} is null`),
    index('violations_status_idx').on(table.status),
    index('violations_detected_at_idx').on(table.detectedAt),
    index('violations_resolved_at_idx').on(table.resolvedAt),
    index('violations_key_idx').on(table.constraintKey),
  ],
);

export type MarketQuoteRow = typeof marketQuotes.$inferSelect;
export type NewMarketQuoteRow = typeof marketQuotes.$inferInsert;
export type ViolationRow = typeof violations.$inferSelect;
export type NewViolationRow = typeof violations.$inferInsert;
export type PriceSnapshotRow = typeof priceSnapshots.$inferSelect;
export type NewPriceSnapshotRow = typeof priceSnapshots.$inferInsert;
export type RawPayloadRow = typeof rawPayloads.$inferSelect;
export type NewRawPayloadRow = typeof rawPayloads.$inferInsert;
export type RelationRow = typeof relations.$inferSelect;
export type NewRelationRow = typeof relations.$inferInsert;
export type RelationGroupRow = typeof relationGroups.$inferSelect;
export type NewRelationGroupRow = typeof relationGroups.$inferInsert;
export type MarketEmbeddingRow = typeof marketEmbeddings.$inferSelect;
export type NewMarketEmbeddingRow = typeof marketEmbeddings.$inferInsert;
export type RelationProposalRow = typeof relationProposals.$inferSelect;
export type NewRelationProposalRow = typeof relationProposals.$inferInsert;
