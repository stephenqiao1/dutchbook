import { createHash } from 'node:crypto';

import { and, count, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { config } from '../config.js';
import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import {
  events,
  marketRevisions,
  markets,
  rawPayloads,
  type MarketRow,
  type NewEventRow,
  type NewMarketRevisionRow,
  type NewMarketRow,
  type NewRawPayloadRow,
} from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import {
  ingestDuration,
  ingestErrors,
  ingestRuns,
  marketsSeen,
  rateLimitHits,
  revisionsWritten,
} from '../metrics.js';
import {
  GammaClient,
  type Event as GammaEvent,
  type Market as GammaMarket,
  type GammaClientOptions,
  type IterateOptions,
  type RawResponse,
} from '../polymarket/index.js';

/**
 * Catalog ingest: reconcile the Polymarket catalog into Postgres.
 *
 * This is a reconciliation, not an append. Polymarket edits markets in place —
 * questions get reworded, resolution sources swapped, markets closed and
 * reopened — and keeps no history of any of it. So each run:
 *
 * 1. hashes every market over its *semantic* fields only,
 * 2. writes nothing but `last_seen_at` when that hash is unchanged,
 * 3. records one `market_revisions` row per changed field when it is not,
 * 4. and never deletes: a market that stops appearing is flagged, not removed.
 *
 * Each batch commits as one transaction, and every write is keyed on
 * `condition_id`, so a crash mid-crawl leaves a consistent database and the
 * next run resumes without duplicating anything.
 */

const log = createLogger('ingest-catalog');

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * The fields the content hash covers, named by their `markets` column so the
 * hash, the diff, and `market_revisions.field` all agree on one vocabulary.
 *
 * Volume, liquidity, prices, spreads, and best bid/ask are deliberately absent:
 * they move on every crawl, and including them would mark every market as
 * edited every run, burying the handful of edits that actually matter.
 *
 * `clob_token_ids` is here for a different reason than the rest. It is not
 * editorial content, but an unchanged hash writes nothing but `last_seen_at`,
 * and Polymarket routinely publishes a market before its CLOB tokens are
 * minted. Left out, a market first seen with null token ids would keep them
 * null until its text happened to change, and price collection would have
 * nothing to key on. Including it makes the backfill land, at the cost of one
 * revision row per market on the run that fills them in — which is arguably
 * the right record to keep anyway.
 *
 * Widening this set further is a one-line change, but note that it silently
 * invalidates every stored hash — the next run will see every market as changed
 * and diff it. That diff is correct and the revisions it writes are real, so the
 * cost is one noisy run, not corruption.
 *
 * Still outside the set, and so still only refreshed on a run where a hashed
 * field also moved: `slug`, `event_id`, and `archived`. Those only ever lag;
 * none of them is load-bearing for pricing or resolution.
 */
export const HASHED_FIELDS = [
  'question',
  'description',
  'resolution_source',
  'outcomes',
  // Adjacent to `outcomes` because they are index-paired: token id i is the
  // token for outcome i.
  'clob_token_ids',
  'end_date',
  'active',
  'closed',
] as const;

export type HashedField = (typeof HASHED_FIELDS)[number];

/** A market reduced to the fields that define its content. */
export type MarketContent = Record<HashedField, unknown>;

/**
 * The shape both a stored row and a freshly built row satisfy.
 *
 * Fields are optional and may be undefined so a `MarketRow` read back from
 * Postgres and a not-yet-inserted `NewMarketRow` both fit. `canonicalize`
 * folds undefined into null, so the two hash identically.
 */
interface ContentSource {
  question?: string | null | undefined;
  description?: string | null | undefined;
  resolutionSource?: string | null | undefined;
  outcomes?: string[] | null | undefined;
  clobTokenIds?: string[] | null | undefined;
  endDate?: Date | null | undefined;
  active?: boolean | null | undefined;
  closed?: boolean | null | undefined;
}

/** Projects either side of a comparison onto the same column-named shape. */
export function contentOf(row: ContentSource): MarketContent {
  return {
    question: row.question,
    description: row.description,
    resolution_source: row.resolutionSource,
    outcomes: row.outcomes,
    clob_token_ids: row.clobTokenIds,
    end_date: row.endDate,
    active: row.active,
    closed: row.closed,
  };
}

/**
 * Rewrites a value into a form whose JSON encoding is stable.
 *
 * Object keys are sorted, so two jsonb values that differ only in key order
 * hash identically. Array order is *preserved*, because it carries meaning
 * here: `outcomes[0]` pairs with `clob_token_ids[0]` and outcome price 0, so
 * sorting `["Yes","No"]` would erase which token is Yes.
 *
 * `undefined` and `null` collapse together — a field the vendor dropped and a
 * field it sent as null are the same absence, and should not look like an edit.
 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .toSorted()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }

  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 over the canonicalised semantic fields. Stable across runs and hosts. */
export function contentHash(content: MarketContent): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** SHA-256 over a canonicalised response body, for `raw_payloads` dedupe. */
export function responseHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export interface FieldChange {
  readonly field: HashedField;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

/**
 * Field-by-field diff over exactly the hashed fields.
 *
 * Values are stored canonicalised so a revision row reads the same whether the
 * vendor sent a Date or an ISO string.
 */
export function diffContent(before: MarketContent, after: MarketContent): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of HASHED_FIELDS) {
    const oldValue = canonicalize(before[field]);
    const newValue = canonicalize(after[field]);
    // Sound because canonicalisation makes the encoding deterministic.
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({ field, oldValue, newValue });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Mapping the crawl onto rows
// ---------------------------------------------------------------------------

export function toEventRow(event: GammaEvent, seenAt: Date): NewEventRow {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    negRisk: event.negRisk,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    // Only ever an initial value: the upsert coalesces so it is never moved.
    closedAt: event.closed === true ? seenAt : null,
  };
}

/**
 * Builds a market row with its hash already computed.
 *
 * Returns null when the market has no `condition_id`. That is the primary key
 * and the identifier shared with the CLOB and the chain; a market without one
 * cannot be stored, reconciled, or priced.
 */
export function toMarketRow(
  market: GammaMarket,
  eventId: string | null,
  seenAt: Date,
): NewMarketRow | null {
  if (market.conditionId === null) return null;

  const content: ContentSource = {
    question: market.question,
    description: market.description,
    resolutionSource: market.resolutionSource,
    outcomes: market.outcomes,
    clobTokenIds: market.clobTokenIds,
    endDate: market.endDate,
    active: market.active,
    closed: market.closed,
  };

  return {
    conditionId: market.conditionId,
    eventId,
    ...content,
    slug: market.slug,
    archived: market.archived,
    contentHash: contentHash(contentOf(content)),
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    missingSince: null,
  };
}

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/** The writes one batch performs. Every method runs inside one transaction. */
export interface CatalogTx {
  /** Existing rows for these ids, locked so a concurrent run cannot interleave. */
  loadMarkets(conditionIds: readonly string[]): Promise<MarketRow[]>;
  upsertEvents(rows: readonly NewEventRow[]): Promise<void>;
  upsertMarkets(rows: readonly NewMarketRow[]): Promise<void>;
  /** The unchanged path: refresh presence, touch no content. */
  touchMarkets(conditionIds: readonly string[], seenAt: Date): Promise<void>;
  insertRevisions(rows: readonly NewMarketRevisionRow[]): Promise<void>;
}

export interface CatalogStore {
  /** Runs `work` in one transaction: it commits whole, or it does nothing. */
  transaction<T>(work: (tx: CatalogTx) => Promise<T>): Promise<T>;
  /** Returns false when an identical body was already archived. */
  archiveRawPayload(row: NewRawPayloadRow): Promise<boolean>;
  /** Flags markets a complete crawl did not return. Answers how many are missing. */
  reconcileMissing(runStartedAt: Date): Promise<number>;
}

type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Columns the upsert refreshes from the incoming row. `first_seen_at` is not
 * among them — it records the first sighting and must never move. */
function marketUpdateSet(): Record<string, unknown> {
  return {
    eventId: sql`excluded.event_id`,
    question: sql`excluded.question`,
    slug: sql`excluded.slug`,
    description: sql`excluded.description`,
    resolutionSource: sql`excluded.resolution_source`,
    outcomes: sql`excluded.outcomes`,
    endDate: sql`excluded.end_date`,
    active: sql`excluded.active`,
    closed: sql`excluded.closed`,
    archived: sql`excluded.archived`,
    clobTokenIds: sql`excluded.clob_token_ids`,
    contentHash: sql`excluded.content_hash`,
    lastSeenAt: sql`excluded.last_seen_at`,
    // Seeing it at all un-flags it; markets do come back.
    missingSince: sql`null`,
  };
}

function wrapTransaction(tx: Transaction): CatalogTx {
  return {
    async loadMarkets(conditionIds) {
      if (conditionIds.length === 0) return [];
      return tx
        .select()
        .from(markets)
        .where(inArray(markets.conditionId, [...conditionIds]))
        .for('update');
    },

    async upsertEvents(rows) {
      if (rows.length === 0) return;
      await tx
        .insert(events)
        .values([...rows])
        .onConflictDoUpdate({
          target: events.id,
          set: {
            slug: sql`excluded.slug`,
            title: sql`excluded.title`,
            negRisk: sql`excluded.neg_risk`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // Write-once: the first time we saw it closed is the answer forever.
            closedAt: sql`coalesce(${events.closedAt}, excluded.closed_at)`,
          },
        });
    },

    async upsertMarkets(rows) {
      if (rows.length === 0) return;
      await tx
        .insert(markets)
        .values([...rows])
        // Upsert rather than a plain insert even on the create path: a
        // concurrent run may have inserted the same market between our
        // SELECT ... FOR UPDATE and this statement.
        .onConflictDoUpdate({ target: markets.conditionId, set: marketUpdateSet() });
    },

    async touchMarkets(conditionIds, seenAt) {
      if (conditionIds.length === 0) return;
      await tx
        .update(markets)
        .set({ lastSeenAt: seenAt, missingSince: null })
        .where(inArray(markets.conditionId, [...conditionIds]));
    },

    async insertRevisions(rows) {
      if (rows.length === 0) return;
      await tx.insert(marketRevisions).values([...rows]);
    },
  };
}

export function createCatalogStore(database: Database = db): CatalogStore {
  return {
    async transaction(work) {
      return database.transaction(async (tx) => work(wrapTransaction(tx)));
    },

    async archiveRawPayload(row) {
      const inserted = await database
        .insert(rawPayloads)
        .values(row)
        .onConflictDoNothing({ target: rawPayloads.responseHash })
        .returning({ id: rawPayloads.id });
      return inserted.length > 0;
    },

    async reconcileMissing(runStartedAt) {
      return database.transaction(async (tx) => {
        // Stamp the moment it went missing, not the moment we noticed: the last
        // crawl that did return it is the last time it demonstrably existed.
        await tx
          .update(markets)
          .set({ missingSince: sql`${markets.lastSeenAt}` })
          .where(and(lt(markets.lastSeenAt, runStartedAt), isNull(markets.missingSince)));

        const [row] = await tx
          .select({ total: count() })
          .from(markets)
          .where(isNotNull(markets.missingSince));

        return row?.total ?? 0;
      });
    },
  };
}

/**
 * Markets no recent crawl has returned, most recently missing first.
 *
 * The `missing_since` column is maintained by the sweep; this is the read side
 * of it, for alerting and for answering "what disappeared this week".
 */
export async function findMissingMarkets(
  database: Database = db,
  limit = 100,
): Promise<Array<Pick<MarketRow, 'conditionId' | 'question' | 'slug' | 'missingSince'>>> {
  return database
    .select({
      conditionId: markets.conditionId,
      question: markets.question,
      slug: markets.slug,
      missingSince: markets.missingSince,
    })
    .from(markets)
    .where(isNotNull(markets.missingSince))
    .orderBy(sql`${markets.missingSince} desc`)
    .limit(limit);
}

/** Full revision history for one market, oldest first. */
export async function findMarketRevisions(
  conditionId: string,
  database: Database = db,
): Promise<schema.MarketRevisionRow[]> {
  return database
    .select()
    .from(marketRevisions)
    .where(eq(marketRevisions.conditionId, conditionId))
    .orderBy(marketRevisions.changedAt, marketRevisions.id);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface IngestLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface IngestOptions {
  /** Defaults to a full `iterateEvents()` crawl with raw archiving wired up. */
  source?: AsyncIterable<GammaEvent>;
  store?: CatalogStore;
  /** Options for the default crawl. Ignored when `source` is supplied. */
  crawl?: IterateOptions;
  /**
   * Client tuning for the default crawl — rate, retries, base URL. Ignored
   * when `source` is supplied. An `onRawResponse` given here runs *before* the
   * archiving hook rather than replacing it; archiving is the ingest's job.
   */
  gamma?: GammaClientOptions;
  /** Markets per transaction. Default 250. */
  batchSize?: number;
  /**
   * Whether to run the missing-market sweep. Defaults to true only for an
   * unfiltered, uncapped crawl — see the note on the sweep below.
   */
  reconcileMissing?: boolean;
  signal?: AbortSignal;
  logger?: IngestLogger;
  now?: () => Date;
}

export interface IngestSummary {
  readonly runStartedAt: string;
  readonly durationMs: number;
  readonly complete: boolean;
  readonly batches: number;
  readonly events: { readonly seen: number };
  readonly markets: {
    readonly seen: number;
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly skipped: number;
  };
  readonly revisions: number;
  readonly rawPayloads: { readonly archived: number; readonly duplicate: number };
  /** Markets flagged missing, or null when the sweep did not run. */
  readonly missing: number | null;
  readonly errors: number;
}

interface Counters {
  batches: number;
  eventsSeen: number;
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  revisions: number;
  archived: number;
  duplicate: number;
  errors: number;
}

/**
 * Runs one catalog reconciliation.
 *
 * Resolves with the summary on success. On failure the summary is still logged
 * — a run that died halfway is exactly the one you want numbers for — and the
 * error is rethrown for the caller (or BullMQ) to decide about.
 */
export async function ingestCatalog(options: IngestOptions = {}): Promise<IngestSummary> {
  const logger = options.logger ?? log;
  const now = options.now ?? ((): Date => new Date());
  const batchSize = Math.max(1, options.batchSize ?? config.CATALOG_INGEST_BATCH_SIZE);
  const store = options.store ?? createCatalogStore();

  const counters: Counters = {
    batches: 0,
    eventsSeen: 0,
    seen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    revisions: 0,
    archived: 0,
    duplicate: 0,
    errors: 0,
  };

  const runStartedAt = now();
  const startedMs = Date.now();

  /**
   * The sweep marks every market a crawl did not return. That is only sound
   * when the crawl was supposed to return all of them: after a filtered or
   * page-capped crawl it would flag the entire rest of the catalog as missing.
   */
  const isFullCrawl =
    options.source === undefined &&
    options.crawl?.params === undefined &&
    options.crawl?.maxPages === undefined;
  const shouldReconcile = options.reconcileMissing ?? isFullCrawl;

  const source =
    options.source ??
    defaultSource(store, counters, logger, options.crawl, options.gamma, options.signal);

  let complete = false;
  let missing: number | null = null;

  try {
    let batch: GammaEvent[] = [];
    let pending = 0;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const ready = batch;
      batch = [];
      pending = 0;
      await applyBatch(store, ready, now(), counters, logger);
      counters.batches += 1;
    };

    for await (const event of source) {
      options.signal?.throwIfAborted();

      counters.eventsSeen += 1;
      batch.push(event);
      pending += event.markets.length;

      if (pending >= batchSize) await flush();
    }

    await flush();
    complete = true;

    if (shouldReconcile) {
      missing = await store.reconcileMissing(runStartedAt);
    } else {
      logger.debug(
        { reason: isFullCrawl ? 'disabled by caller' : 'partial crawl' },
        'catalog ingest skipped the missing-market sweep',
      );
    }

    return summarize(counters, runStartedAt, startedMs, complete, missing, logger);
  } catch (error) {
    summarize(counters, runStartedAt, startedMs, complete, missing, logger, error);
    throw error;
  }
}

function summarize(
  counters: Counters,
  runStartedAt: Date,
  startedMs: number,
  complete: boolean,
  missing: number | null,
  logger: IngestLogger,
  error?: unknown,
): IngestSummary {
  const summary: IngestSummary = {
    runStartedAt: runStartedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    complete,
    batches: counters.batches,
    events: { seen: counters.eventsSeen },
    markets: {
      seen: counters.seen,
      created: counters.created,
      updated: counters.updated,
      unchanged: counters.unchanged,
      skipped: counters.skipped,
    },
    revisions: counters.revisions,
    rawPayloads: { archived: counters.archived, duplicate: counters.duplicate },
    missing,
    errors: counters.errors,
  };

  // `summarize` is the single choke point every run passes through, so it is
  // the only place metrics need touching.
  ingestRuns.inc({ result: error === undefined ? 'success' : 'failure' });
  ingestDuration.observe(summary.durationMs / 1_000);
  revisionsWritten.inc({}, summary.revisions);
  ingestErrors.inc({ kind: 'record' }, counters.errors);
  if (error !== undefined) ingestErrors.inc({ kind: 'run' });

  for (const outcome of ['created', 'updated', 'unchanged', 'skipped'] as const) {
    marketsSeen.inc({ outcome }, summary.markets[outcome]);
  }

  if (error === undefined) {
    logger.info({ ...summary }, 'catalog ingest complete');
  } else {
    logger.error({ ...summary, error: describeError(error) }, 'catalog ingest failed');
  }

  return summary;
}

/**
 * Applies one batch inside a single transaction: events first (markets carry an
 * FK to them), then markets, then the revisions those markets produced.
 */
async function applyBatch(
  store: CatalogStore,
  batch: readonly GammaEvent[],
  seenAt: Date,
  counters: Counters,
  logger: IngestLogger,
): Promise<void> {
  const eventRows: NewEventRow[] = [];
  // Keyed, so a market appearing under two events in one batch is written once
  // rather than colliding inside a single INSERT.
  const incoming = new Map<string, NewMarketRow>();

  for (const event of batch) {
    eventRows.push(toEventRow(event, seenAt));

    for (const market of event.markets) {
      counters.seen += 1;

      const row = toMarketRow(market, event.id, seenAt);
      if (row === null) {
        counters.skipped += 1;
        logger.warn(
          { marketId: market.id, eventId: event.id, slug: market.slug },
          'catalog ingest skipped market with no condition_id',
        );
        continue;
      }

      const duplicate = incoming.get(row.conditionId);
      if (duplicate !== undefined) {
        counters.seen -= 1;
        logger.warn(
          { conditionId: row.conditionId, eventId: event.id },
          'catalog ingest saw one condition_id twice in a batch, keeping the later row',
        );
      }
      incoming.set(row.conditionId, row);
    }
  }

  await store.transaction(async (tx) => {
    await tx.upsertEvents(eventRows);

    const existing = await tx.loadMarkets([...incoming.keys()]);
    const before = new Map(existing.map((row) => [row.conditionId, row]));

    const toWrite: NewMarketRow[] = [];
    const toTouch: string[] = [];
    const revisions: NewMarketRevisionRow[] = [];

    for (const [conditionId, row] of incoming) {
      const previous = before.get(conditionId);

      if (previous === undefined) {
        toWrite.push(row);
        counters.created += 1;
        continue;
      }

      if (previous.contentHash === row.contentHash) {
        // Requirement: nothing but presence is written on this path.
        toTouch.push(conditionId);
        counters.unchanged += 1;
        continue;
      }

      // A changed hash with no field diff means the hash *definition* changed,
      // not the market. Rewrite the row so the new hash sticks, but do not
      // invent revisions for an edit that never happened.
      for (const change of diffContent(contentOf(previous), contentOf(row))) {
        revisions.push({
          conditionId,
          changedAt: seenAt,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          contentHashBefore: previous.contentHash,
          contentHashAfter: row.contentHash,
        });
      }

      toWrite.push(row);
      counters.updated += 1;
    }

    await tx.upsertMarkets(toWrite);
    await tx.insertRevisions(revisions);
    await tx.touchMarkets(toTouch, seenAt);

    counters.revisions += revisions.length;

    logger.debug(
      {
        events: eventRows.length,
        created: toWrite.length - revisions.length,
        wrote: toWrite.length,
        touched: toTouch.length,
        revisions: revisions.length,
      },
      'catalog ingest batch committed',
    );
  });
}

/**
 * A live crawl with raw archiving wired in.
 *
 * Payloads are archived from the client hook, which fires before parsing and
 * outside the batch transaction. That ordering is deliberate: a body that later
 * fails to parse is the one worth keeping, and the archive is deduplicated by
 * hash, so writing it twice costs nothing.
 */
function defaultSource(
  store: CatalogStore,
  counters: Counters,
  logger: IngestLogger,
  crawl: IterateOptions | undefined,
  gamma: GammaClientOptions | undefined,
  signal: AbortSignal | undefined,
): AsyncIterable<GammaEvent> {
  const client = new GammaClient({
    ...gamma,
    onRateLimited: (event) => {
      rateLimitHits.inc({ status: event.status });
      gamma?.onRateLimited?.(event);
    },
    onRawResponse: async (raw) => {
      await gamma?.onRawResponse?.(raw);
      try {
        const fresh = await store.archiveRawPayload(toRawPayloadRow(raw));
        if (fresh) counters.archived += 1;
        else counters.duplicate += 1;
      } catch (error) {
        // Archival is best-effort: losing a copy of a payload must not lose
        // the crawl that produced it.
        counters.errors += 1;
        logger.warn(
          { url: raw.url, status: raw.status, error: describeError(error) },
          'catalog ingest could not archive a raw payload',
        );
      }
    },
  });

  // The signal reaches the fetch itself, so a job-level timeout or a lost
  // lock interrupts an in-flight request rather than waiting for the page to
  // land and only then noticing between events.
  return client.iterateEvents({ ...crawl, ...(signal === undefined ? {} : { signal }) });
}

export function toRawPayloadRow(raw: RawResponse): NewRawPayloadRow {
  const url = new URL(raw.url);
  // A body that is not JSON — an HTML error page, say — is still worth keeping,
  // so it is wrapped rather than dropped.
  const body = raw.body === undefined ? { unparsed: raw.text } : raw.body;

  return {
    endpoint: `${url.pathname}${url.search}`,
    fetchedAt: new Date(),
    body,
    responseHash: responseHash(body),
  };
}
