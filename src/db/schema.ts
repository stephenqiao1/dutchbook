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

/**
 * Point-in-time top-of-book per outcome token.
 *
 * Keyed by (condition_id, token_id, ts) so re-running a collector over a window
 * it already covered overwrites rather than duplicates. `numeric` rather than
 * float: these are prices, and float drift in a book is not worth the bytes
 * saved.
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

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type MarketRow = typeof markets.$inferSelect;
export type NewMarketRow = typeof markets.$inferInsert;
export type MarketRevisionRow = typeof marketRevisions.$inferSelect;
export type NewMarketRevisionRow = typeof marketRevisions.$inferInsert;
export type PriceSnapshotRow = typeof priceSnapshots.$inferSelect;
export type NewPriceSnapshotRow = typeof priceSnapshots.$inferInsert;
export type RawPayloadRow = typeof rawPayloads.$inferSelect;
export type NewRawPayloadRow = typeof rawPayloads.$inferInsert;
export type RelationRow = typeof relations.$inferSelect;
export type NewRelationRow = typeof relations.$inferInsert;
export type RelationGroupRow = typeof relationGroups.$inferSelect;
export type NewRelationGroupRow = typeof relationGroups.$inferInsert;
