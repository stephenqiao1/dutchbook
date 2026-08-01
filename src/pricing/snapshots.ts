import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { priceSnapshots, type DepthLevel } from '../db/schema.js';
import { createLogger } from '../logger.js';
import { topOfBook, type OrderBook } from '../polymarket/clob.js';
import { SNAPSHOT_DEPTH } from './costs.js';

/**
 * Persisting order books to `price_snapshots`.
 *
 * Full depth on both sides, not just the midpoint. The reason is stated on the
 * table itself: a stored midpoint cannot answer "what would this order have
 * cost at that moment", and a history of midpoints makes every past opportunity
 * look executable at any size. Ten levels per side is enough to re-price a
 * realistic order after the fact.
 */

const log = createLogger('price-snapshots');

type Database = PostgresJsDatabase<typeof schema>;

export interface SnapshotOptions {
  /** Marks where the quote came from. Default `clob-book`. */
  readonly source?: string;
  /** Recording time. Defaults to now, evaluated once for the whole batch. */
  readonly ts?: Date;
  /** Levels kept per side. Default {@link SNAPSHOT_DEPTH}. */
  readonly depth?: number;
}

export interface SnapshotResult {
  readonly written: number;
  /** Books with no `conditionId`, which cannot satisfy the foreign key. */
  readonly skipped: number;
}

/** Rounds to the table's scale so a round-trip through numeric is lossless. */
function scaled(value: number | null, places = 8): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(places);
}

function toDepth(levels: readonly { price: number; size: number }[], depth: number): DepthLevel[] {
  return levels.slice(0, depth).map((level) => ({ price: level.price, size: level.size }));
}

function totalSize(levels: readonly { size: number }[]): number {
  let total = 0;
  for (const level of levels) total += level.size;
  return total;
}

/**
 * One book to its row.
 *
 * Exported because the mapping is the interesting part and deserves testing
 * without a database: the depth arrays must come out best-first and truncated,
 * and the aggregate depth must count the *whole* book so that truncation is
 * visible rather than silent.
 */
export function snapshotRow(
  book: OrderBook,
  ts: Date,
  options: SnapshotOptions = {},
): typeof priceSnapshots.$inferInsert | null {
  // The foreign key is on condition_id; a book without one cannot be attributed
  // to a market, and inventing an attribution is worse than dropping the row.
  if (book.conditionId === null || book.conditionId === '') return null;

  const depth = options.depth ?? SNAPSHOT_DEPTH;
  const top = topOfBook(book);

  return {
    conditionId: book.conditionId,
    tokenId: book.tokenId,
    ts,
    bid: scaled(top.bid),
    ask: scaled(top.ask),
    mid: scaled(top.mid),
    spread: scaled(top.spread),
    bids: toDepth(book.bids, depth),
    asks: toDepth(book.asks, depth),
    bidDepth: scaled(totalSize(book.bids)),
    askDepth: scaled(totalSize(book.asks)),
    bookTs: book.timestamp,
    bookHash: book.hash,
    source: options.source ?? 'clob-book',
  };
}

/**
 * Writes a batch of books.
 *
 * `onConflictDoUpdate` on the primary key rather than `doNothing`: re-running a
 * collector over a window it already covered should correct the row, not leave
 * a stale one behind. The primary key is (condition_id, token_id, ts), so two
 * books for the same token in the same millisecond collapse — which is the
 * intended behaviour for a poller, not a collision.
 */
export async function writeSnapshots(
  books: Iterable<OrderBook>,
  database: Database = db,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const ts = options.ts ?? new Date();

  const rows: (typeof priceSnapshots.$inferInsert)[] = [];
  let skipped = 0;

  // Deduplicated on the primary key before the insert: Postgres rejects a
  // statement that touches the same key twice rather than applying the conflict
  // clause, so the same book arriving twice in one batch would fail the write.
  const seen = new Set<string>();
  for (const book of books) {
    const row = snapshotRow(book, ts, options);
    if (row === null) {
      skipped += 1;
      continue;
    }
    const key = `${row.conditionId}\u0000${row.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  if (rows.length === 0) {
    if (skipped > 0) log.warn({ skipped }, 'no snapshots written: every book lacked a condition id');
    return { written: 0, skipped };
  }

  await database
    .insert(priceSnapshots)
    .values(rows)
    .onConflictDoUpdate({
      target: [priceSnapshots.conditionId, priceSnapshots.tokenId, priceSnapshots.ts],
      set: {
        bid: sql`excluded.bid`,
        ask: sql`excluded.ask`,
        mid: sql`excluded.mid`,
        spread: sql`excluded.spread`,
        bids: sql`excluded.bids`,
        asks: sql`excluded.asks`,
        bidDepth: sql`excluded.bid_depth`,
        askDepth: sql`excluded.ask_depth`,
        bookTs: sql`excluded.book_ts`,
        bookHash: sql`excluded.book_hash`,
        source: sql`excluded.source`,
      },
    });

  log.debug({ written: rows.length, skipped }, 'price snapshots written');
  return { written: rows.length, skipped };
}

/**
 * A stored snapshot back into a walkable book.
 *
 * The whole reason depth is persisted: a historical row re-prices exactly like
 * a live book, through the same {@link executableCost}, with no special case.
 */
export function bookFromSnapshot(row: {
  tokenId: string;
  conditionId: string;
  bids: DepthLevel[] | null;
  asks: DepthLevel[] | null;
  bookTs: Date | null;
  bookHash: string | null;
}): OrderBook {
  return {
    tokenId: row.tokenId,
    conditionId: row.conditionId,
    timestamp: row.bookTs,
    hash: row.bookHash,
    bids: row.bids ?? [],
    asks: row.asks ?? [],
    tickSize: null,
    minOrderSize: null,
    negRisk: null,
    lastTradePrice: null,
  };
}
