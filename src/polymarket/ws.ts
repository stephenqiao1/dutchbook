/* eslint-disable unicorn/prefer-add-event-listener --
 * `WebSocketLike` is this module's own minimal seam, not a DOM `EventTarget`:
 * it has no `addEventListener` to prefer. Keeping the surface to four handler
 * properties is what lets the tests substitute a plain object, and what makes
 * `detach()` — silencing a socket so its `close()` cannot fire a second
 * reconnect — a matter of nulling four fields rather than tracking listener
 * identities for removal.
 */
import { z } from 'zod';

import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { bookDivergence, wsConnected, wsMessages, wsReconnects } from '../metrics.js';
import { ClobClient, type BookLevel, type OrderBook, type TopOfBook } from './clob.js';
import { fullJitterBackoff, type PolymarketLogger } from './http.js';

/**
 * The CLOB market WebSocket, and the in-memory books it maintains.
 *
 * Polling `POST /books` gives a price that is already old: a check running every
 * sixty seconds sees a violation an average of thirty seconds after it opens,
 * and short-lived mispricings — the only kind that survive on a liquid venue —
 * are gone before the next tick. This feed replaces the poll for stage 1, so a
 * gap is seen at the speed the venue publishes it rather than the speed we ask.
 *
 * Read-only, like the rest of `src/polymarket`. No auth, no wallet, no orders.
 *
 * Everything below was verified against the running service on 2026-08-01, not
 * inferred from documentation. Each of these will silently corrupt a book if
 * assumed the other way:
 *
 * 1. **`price_change.size` is the new ABSOLUTE size at that level, not a
 *    delta.** Applying the two interpretations side by side over 214 changes on
 *    8 tokens and comparing against a REST snapshot: absolute matched 6/8,
 *    delta matched 0/8. A size of `0` removes the level.
 * 2. **Levels arrive worst-first**, exactly as on REST — bids ascending, asks
 *    descending. `bids[0]` is the *worst* bid. Books are held as price→size maps
 *    here and sorted on materialisation, so the wire order never matters.
 * 3. **The initial `book` snapshot is not delivered reliably at scale.** With 24
 *    assets subscribed, 24 snapshots arrived. With 1,000, *zero* arrived; with
 *    25,548, eight. Meanwhile 5,780 assets sent `price_change` events for books
 *    that were never snapshotted. Building a book from those changes alone
 *    yields a plausible-looking book containing only the levels that happened to
 *    move — no error, no gap, just confidently wrong prices. **REST seeds every
 *    book; a change for an unseeded token is dropped and counted.**
 * 4. **A second `subscribe` on an open connection is rejected** with the text
 *    frame `INVALID OPERATION`, and the new assets never deliver. The asset set
 *    is fixed for the life of a connection, so changing it means reconnecting —
 *    which is why the subscription is sharded rather than held on one socket.
 * 5. **`PING` gets `PONG`** as a text frame. This is the only liveness signal on
 *    a shard whose markets are quiet; without it a silent connection and a dead
 *    one are indistinguishable.
 * 6. **`best_bid`/`best_ask` on a `price_change` are the venue's *current* top,
 *    not the top after that particular change.** They run ahead of the
 *    incremental stream: measured over 3,914 changes, 24 disagreed with the
 *    applied book, and in every sampled case the reported top required changes
 *    that had not been delivered yet (e.g. a bid removal reported alongside a
 *    best ask one tick better than any ask we had been told about). So this is a
 *    *hint that we are behind*, useful for prioritising a reconciliation, and
 *    not evidence of a defect. Treating it as a divergence verdict produced a
 *    0.6% false-positive rate.
 * 7. **Each state carries a `hash`.** Over 60 comparisons, whenever the REST
 *    hash equalled the last hash applied here, the level maps were identical.
 *    That makes the hash a state identifier, and it is what lets reconciliation
 *    tell a genuine divergence from the two snapshots simply being taken at
 *    different instants.
 */

const log = createLogger('polymarket-ws');

export const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Assets per connection.
 *
 * One socket accepted all 25,548 tokens under constraint, so this is not a venue
 * limit. It is a blast-radius limit: the asset set cannot be changed without
 * reconnecting (hazard 4), so a shard is the unit of "what has to be rebuilt
 * when the constraint set changes", and the unit that a single dropped socket
 * takes offline.
 */
export const DEFAULT_SHARD_SIZE = 2_500;

const DEFAULT_PING_INTERVAL_MS = 10_000;
/** Silence beyond this means dead, even if the socket still claims to be open. */
const DEFAULT_STALE_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
/** How many recent state hashes to remember per token. See {@link MarketFeed.reconcile}. */
const HASH_HISTORY = 4;

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

const wsLevelSchema = z.object({ price: z.string(), size: z.string() });

const wsBookSchema = z.object({
  event_type: z.literal('book'),
  market: z.string().optional(),
  asset_id: z.string(),
  timestamp: z.string().optional(),
  hash: z.string().optional(),
  bids: z.array(wsLevelSchema).optional(),
  asks: z.array(wsLevelSchema).optional(),
});

const wsPriceChangeSchema = z.object({
  event_type: z.literal('price_change'),
  market: z.string().optional(),
  timestamp: z.string().optional(),
  price_changes: z.array(
    z.object({
      asset_id: z.string(),
      price: z.string(),
      size: z.string(),
      side: z.string(),
      hash: z.string().optional(),
      best_bid: z.string().optional(),
      best_ask: z.string().optional(),
    }),
  ),
});

/**
 * Anything else the venue sends (`tick_size_change`, `last_trade_price`, and
 * whatever is added next) parses as this and is counted, not dropped silently.
 * An unknown event type is information — it is how a protocol change announces
 * itself — but it is not a reason to fail.
 */
const wsOtherSchema = z.object({ event_type: z.string() });

const wsEventSchema = z.union([wsBookSchema, wsPriceChangeSchema, wsOtherSchema]);

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

/** The slice of `WebSocket` this module uses, so tests need no network. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

// ---------------------------------------------------------------------------
// Book state
// ---------------------------------------------------------------------------

/**
 * One token's book as price→size maps.
 *
 * Maps rather than sorted arrays because every update is a point write to one
 * level; keeping arrays sorted through thousands of writes a second would spend
 * the whole latency budget on `splice`. The sorted, best-first {@link OrderBook}
 * the rest of the codebase consumes is materialised on read and cached until the
 * next write.
 */
class LiveBook {
  readonly tokenId: string;
  conditionId: string | null = null;

  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();

  /** Null until seeded from REST. Changes for an unseeded book are dropped. */
  seededAt: Date | null = null;
  hash: string | null = null;
  /** Venue time of the last applied state, not local receive time. */
  timestamp: Date | null = null;
  updatedAt = 0;
  /** Bumped on every applied change; reconciliation uses it as a version. */
  version = 0;

  /** Carried from the REST seed — the WS feed never sends these. */
  tickSize: number | null = null;
  minOrderSize: number | null = null;
  negRisk: boolean | null = null;
  lastTradePrice: number | null = null;

  /** Recent state hashes, newest last. See {@link MarketFeed.reconcile}. */
  readonly hashes: string[] = [];

  #bidsCache: readonly BookLevel[] | null = null;
  #asksCache: readonly BookLevel[] | null = null;

  constructor(tokenId: string) {
    this.tokenId = tokenId;
  }

  /** Replaces both sides wholesale. Used by the REST seed and `book` events. */
  reset(bids: Iterable<readonly [number, number]>, asks: Iterable<readonly [number, number]>): void {
    this.bids.clear();
    this.asks.clear();
    for (const [price, size] of bids) if (size > 0) this.bids.set(price, size);
    for (const [price, size] of asks) if (size > 0) this.asks.set(price, size);
    this.#invalidate();
  }

  /**
   * Applies one level change.
   *
   * Absolute, not additive (hazard 1). Returns false for a level that cannot
   * exist — the same filter `normalizeBook` applies to REST books, because a
   * price outside (0, 1] is malformed rather than an opportunity and a
   * zero-priced level would read as free depth to the book walker.
   */
  apply(side: 'bids' | 'asks', price: number, size: number): boolean {
    if (!Number.isFinite(price) || !Number.isFinite(size)) return false;
    if (price <= 0 || price > 1) return false;
    if (size < 0) return false;

    const levels = side === 'bids' ? this.bids : this.asks;
    if (size === 0) levels.delete(price);
    else levels.set(price, size);

    this.version += 1;
    this.#invalidate();
    return true;
  }

  noteHash(hash: string | undefined): void {
    if (hash === undefined || hash === '') return;
    this.hash = hash;
    this.hashes.push(hash);
    if (this.hashes.length > HASH_HISTORY) this.hashes.shift();
  }

  /** Have we ever held this state? Distinguishes "behind" from "ahead". */
  knowsHash(hash: string): boolean {
    return this.hashes.includes(hash);
  }

  get bestBid(): number | null {
    return this.sortedBids[0]?.price ?? null;
  }

  get bestAsk(): number | null {
    return this.sortedAsks[0]?.price ?? null;
  }

  get sortedBids(): readonly BookLevel[] {
    return (this.#bidsCache ??= materialise(this.bids, 'desc'));
  }

  get sortedAsks(): readonly BookLevel[] {
    return (this.#asksCache ??= materialise(this.asks, 'asc'));
  }

  toOrderBook(): OrderBook {
    return {
      tokenId: this.tokenId,
      conditionId: this.conditionId,
      timestamp: this.timestamp,
      hash: this.hash,
      bids: this.sortedBids,
      asks: this.sortedAsks,
      tickSize: this.tickSize,
      minOrderSize: this.minOrderSize,
      negRisk: this.negRisk,
      lastTradePrice: this.lastTradePrice,
    };
  }

  #invalidate(): void {
    this.#bidsCache = null;
    this.#asksCache = null;
  }
}

function materialise(levels: ReadonlyMap<number, number>, direction: 'desc' | 'asc'): BookLevel[] {
  const out: BookLevel[] = [];
  for (const [price, size] of levels) if (size > 0) out.push({ price, size });
  out.sort((a, b) => (direction === 'desc' ? b.price - a.price : a.price - b.price));
  return out;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Emitted after a book changes, so a consumer can react rather than poll. */
export interface BookUpdate {
  readonly tokenId: string;
  readonly conditionId: string | null;
  /** Venue timestamp of the change. The basis for any latency measurement. */
  readonly at: Date | null;
  /** Local receive time. */
  readonly receivedAt: number;
}

export interface FeedStats {
  readonly shards: number;
  readonly connected: number;
  readonly subscribed: number;
  readonly seeded: number;
  readonly messages: number;
  readonly changesApplied: number;
  /** Changes for tokens with no REST base — dropped, never used (hazard 3). */
  readonly changesUnseeded: number;
  readonly reconnects: number;
  /** Events whose reported top ran ahead of ours. A hint, not a defect — hazard 6. */
  readonly topHints: number;
  readonly contentDivergences: number;
  readonly staleDivergences: number;
}

export interface MarketFeedOptions {
  url?: string;
  clob?: ClobClient;
  createWebSocket?: WebSocketFactory;
  logger?: PolymarketLogger;
  shardSize?: number;
  pingIntervalMs?: number;
  staleTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
  random?: () => number;
  /** Called after each applied batch of changes. Kept synchronous and cheap. */
  onUpdate?: (update: BookUpdate) => void;
}

interface Shard {
  readonly index: number;
  readonly assets: readonly string[];
  socket: WebSocketLike | null;
  connected: boolean;
  attempt: number;
  nextAttemptAt: number;
  lastMessageAt: number;
  lastPingAt: number;
}

export interface ReconcileReport {
  readonly checked: number;
  readonly agreed: number;
  /** REST was taken before our latest update. Expected, not a problem. */
  readonly ahead: number;
  /** Hash matched but levels did not: the apply logic is wrong. */
  readonly contentDivergences: number;
  /** A state we never saw, still unseen a full cycle later: we missed updates. */
  readonly staleDivergences: number;
  /** Unknown hashes parked for re-examination next cycle. */
  readonly pending: number;
  readonly resynced: number;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export class MarketFeed {
  readonly #url: string;
  readonly #clob: ClobClient;
  readonly #createWebSocket: WebSocketFactory;
  readonly #logger: PolymarketLogger;
  readonly #shardSize: number;
  readonly #pingIntervalMs: number;
  readonly #staleTimeoutMs: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #listeners: ((update: BookUpdate) => void)[] = [];

  readonly #books = new Map<string, LiveBook>();
  readonly #shards: Shard[] = [];
  /** Changes that arrived before their book was seeded, replayed after seeding. */
  readonly #pendingChanges = new Map<string, { side: 'bids' | 'asks'; price: number; size: number; ts: number; hash: string | undefined }[]>();
  /** Tokens whose REST hash we did not recognise, awaiting a second look. */
  readonly #unrecognised = new Map<string, { hash: string; since: number }>();
  readonly #resyncQueue = new Set<string>();
  /**
   * Tokens with a seed in flight right now.
   *
   * Per token rather than one global flag: two shards reconnecting at once run
   * two overlapping seeds, and a shared flag lets the first to finish declare
   * seeding over — after which the second shard's changes are dropped instead of
   * buffered, for the rest of its own seed.
   */
  readonly #seedingTokens = new Set<string>();

  #cursor = 0;
  #messages = 0;
  #changesApplied = 0;
  #changesUnseeded = 0;
  #reconnects = 0;
  #topHints = 0;
  #contentDivergences = 0;
  #staleDivergences = 0;
  #stopped = false;

  constructor(options: MarketFeedOptions = {}) {
    this.#url = options.url ?? CLOB_WS_URL;
    this.#clob = options.clob ?? new ClobClient();
    this.#createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.#logger = options.logger ?? log;
    this.#shardSize = Math.max(1, options.shardSize ?? DEFAULT_SHARD_SIZE);
    this.#pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.#staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.#reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    if (options.onUpdate !== undefined) this.#listeners.push(options.onUpdate);
  }

  /**
   * Registers an update listener.
   *
   * A method as well as a constructor option because the feed is often built by
   * one place and consumed by another — an injected feed that could only be
   * listened to at construction would silently deliver nothing, which looks
   * exactly like a market that never moves.
   */
  addUpdateListener(handler: (update: BookUpdate) => void): void {
    this.#listeners.push(handler);
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Subscribes to `tokenIds` and seeds their books.
   *
   * Sockets open *before* the REST seed, and changes arriving in between are
   * buffered rather than dropped. Seeding first and connecting second would lose
   * every update in the gap — silently, since a book that is merely a few
   * seconds stale looks exactly like a correct one.
   */
  async start(tokenIds: readonly string[], signal?: AbortSignal): Promise<void> {
    const wanted = [...new Set(tokenIds.filter((id) => id !== ''))];

    // Idempotent: `start` is also how the subscription is rebuilt when the
    // constraint graph changes, so it must tear down what is already open
    // rather than stack another set of sockets on top of it.
    this.stop();
    this.#shards.length = 0;
    this.#stopped = false;

    const keep = new Set(wanted);
    for (const tokenId of this.#books.keys()) {
      if (!keep.has(tokenId)) this.#books.delete(tokenId);
    }
    for (const tokenId of wanted) {
      if (!this.#books.has(tokenId)) this.#books.set(tokenId, new LiveBook(tokenId));
      // Every book is re-seeded below. Marking them unseeded first means changes
      // arriving during the seed are buffered rather than applied to a base that
      // is about to be replaced.
      const book = this.#books.get(tokenId);
      if (book !== undefined) book.seededAt = null;
    }

    for (let i = 0; i < wanted.length; i += this.#shardSize) {
      const index = this.#shards.length;
      this.#shards.push({
        index,
        assets: wanted.slice(i, i + this.#shardSize),
        socket: null,
        connected: false,
        attempt: 0,
        nextAttemptAt: 0,
        lastMessageAt: this.#now(),
        lastPingAt: this.#now(),
      });
    }

    // Buffering is armed before the first socket opens. A change that arrives
    // between `onopen` and the seed request is exactly the one that would
    // otherwise be lost, and losing it looks like a correct book.
    for (const tokenId of wanted) this.#seedingTokens.add(tokenId);
    for (const shard of this.#shards) this.#connect(shard);

    await this.seed(wanted, signal);

    this.#logger.debug(
      { tokens: wanted.length, shards: this.#shards.length, shardSize: this.#shardSize },
      'market feed started',
    );
  }

  /**
   * Fetches REST books for `tokenIds` and installs them as the base state.
   *
   * This is the only way a book comes into existence. Hazard 3 is the whole
   * reason: the venue does not reliably snapshot a large subscription, so a book
   * assembled from `price_change` alone would contain only the levels that
   * happened to move and none of the resting depth behind them.
   */
  async seed(tokenIds: readonly string[], signal?: AbortSignal): Promise<number> {
    const wanted = tokenIds.filter((id) => this.#books.has(id));
    let seeded = 0;

    for (const tokenId of wanted) this.#seedingTokens.add(tokenId);

    try {
      if (wanted.length === 0) return 0;

      const options = signal === undefined ? {} : { signal };
      const { books, missing } = await this.#clob.fetchBooks(wanted, options);

      for (const [tokenId, rest] of books) {
        const book = this.#books.get(tokenId);
        if (book === undefined) continue;
        this.#install(book, rest);
        seeded += 1;
      }

      if (missing.length > 0) {
        // Not an error: a token the venue does not know has no book to keep, and
        // the checker falls back to its cached quote for that market.
        this.#logger.debug(
          { missing: missing.length, sample: missing.slice(0, 3) },
          'no rest book to seed; those tokens stay unseeded',
        );
      }
    } finally {
      for (const tokenId of wanted) {
        this.#seedingTokens.delete(tokenId);
        // A token the venue returned no book for was never installed, so its
        // buffer is never drained. Dropping it here is what stops the 7,600-odd
        // constrained markets with no CLOB book from accumulating changes for
        // the life of the process.
        const book = this.#books.get(tokenId);
        if (book?.seededAt == null) this.#pendingChanges.delete(tokenId);
      }
    }

    return seeded;
  }

  /** Closes every shard. Books are kept, so a restart re-seeds rather than refetches. */
  stop(): void {
    this.#stopped = true;
    for (const shard of this.#shards) {
      shard.connected = false;
      detach(shard.socket);
      try {
        shard.socket?.close(1000, 'shutting down');
      } catch {
        // A socket that refuses to close is already gone.
      }
      shard.socket = null;
    }
    wsConnected.set(0);
  }

  // -- reads ----------------------------------------------------------------

  /** The live book, or null when the token has no REST base yet. */
  book(tokenId: string): OrderBook | null {
    const book = this.#books.get(tokenId);
    if (book === undefined || book.seededAt === null) return null;
    return book.toOrderBook();
  }

  /** Best bid, best ask, midpoint. Null unless both sides are present. */
  top(tokenId: string): TopOfBook | null {
    const book = this.#books.get(tokenId);
    if (book === undefined || book.seededAt === null) return null;

    const bid = book.bestBid;
    const ask = book.bestAsk;
    const both = bid !== null && ask !== null;
    return { bid, ask, mid: both ? (bid + ask) / 2 : null, spread: both ? ask - bid : null };
  }

  /** The midpoint alone, which is all stage 1 needs. */
  mid(tokenId: string): number | null {
    return this.top(tokenId)?.mid ?? null;
  }

  stats(): FeedStats {
    let seeded = 0;
    for (const book of this.#books.values()) if (book.seededAt !== null) seeded += 1;

    return {
      shards: this.#shards.length,
      connected: this.#shards.filter((s) => s.connected).length,
      subscribed: this.#books.size,
      seeded,
      messages: this.#messages,
      changesApplied: this.#changesApplied,
      changesUnseeded: this.#changesUnseeded,
      reconnects: this.#reconnects,
      topHints: this.#topHints,
      contentDivergences: this.#contentDivergences,
      staleDivergences: this.#staleDivergences,
    };
  }

  // -- timers ---------------------------------------------------------------

  /**
   * Heartbeat and reconnect scheduling. Call about once a second.
   *
   * A separate method rather than an internal `setInterval` so the whole policy
   * — ping cadence, staleness deadline, backoff — is exercised by tests on a
   * fake clock instead of by waiting.
   */
  tick(): void {
    if (this.#stopped) return;
    const now = this.#now();

    for (const shard of this.#shards) {
      if (shard.connected) {
        // Silence is not evidence of health: a shard of quiet markets sends
        // nothing for minutes, and a half-open socket sends nothing ever. PONG
        // is what separates them.
        if (now - shard.lastMessageAt > this.#staleTimeoutMs) {
          this.#logger.warn(
            { shard: shard.index, silentMs: now - shard.lastMessageAt },
            'no traffic within the staleness deadline; recycling the connection',
          );
          this.#drop(shard, 'stale');
          continue;
        }
        if (now - shard.lastPingAt >= this.#pingIntervalMs) {
          shard.lastPingAt = now;
          try {
            shard.socket?.send('PING');
          } catch (error) {
            this.#logger.debug({ shard: shard.index, error: describeError(error) }, 'ping failed');
            this.#drop(shard, 'ping-failed');
          }
        }
        continue;
      }

      if (shard.socket === null && now >= shard.nextAttemptAt) this.#connect(shard);
    }

    wsConnected.set(this.#shards.filter((s) => s.connected).length);
  }

  // -- reconciliation -------------------------------------------------------

  /**
   * Compares a rotating slice of in-memory books against fresh REST snapshots.
   *
   * The naive version of this check does not work. A REST snapshot and a live
   * book are taken at different instants, so their levels differ constantly for
   * reasons that are not bugs — measured directly: of 8 tokens compared after 45
   * seconds of updates, 2 differed by exactly one level, in each case a level
   * that landed between the last WS event and the REST read. A counter fed by
   * that comparison never reaches zero and therefore says nothing.
   *
   * The `hash` (hazard 7) is what makes the check meaningful, by sorting each
   * token into one of four cases:
   *
   * - **Hash equal, levels equal** → in sync.
   * - **Hash equal, levels differ** → we hold the hash of the venue's current
   *   state without every level behind it, so an intermediate update was lost.
   * - **Hash in our recent history** → REST is behind us. Expected.
   * - **Hash unrecognised** → either an update still in flight, or one we never
   *   got. Indistinguishable in the moment, so judgment is deferred: the token
   *   is parked and re-examined next cycle, by which time anything in flight has
   *   long arrived. Only a state still unrecognised then counts as stale.
   * - **Never seeded** → nothing to compare.
   *
   * This is a repair loop, not a tripwire. The apply path reconstructs the
   * venue's book exactly at low volume — 565 changes on 5 tokens with zero
   * disagreement — but drift rises with subscription size (1.8% of comparisons
   * at 30 tokens, 2.7% at 200) because the venue's delivery thins out under
   * load. So divergence is an expected, ongoing condition, and how quickly this
   * sweeps the subscription bounds how long a drifted book can price stage 1.
   */
  async reconcile(limit: number, signal?: AbortSignal): Promise<ReconcileReport> {
    const seededTokens = [...this.#books.values()].filter((b) => b.seededAt !== null).map((b) => b.tokenId);
    if (seededTokens.length === 0) {
      return { checked: 0, agreed: 0, ahead: 0, contentDivergences: 0, staleDivergences: 0, pending: 0, resynced: 0 };
    }

    // Two sources, and the split matters. Tokens already suspected of being
    // wrong jump the queue, but they take at most half the budget: hints arrive
    // in the hundreds under load, and letting them fill the batch would stall
    // the rotation entirely — the sweep that bounds how long an *unsuspected*
    // drifted book can go unrepaired would simply stop advancing.
    const chosen = new Set<string>();
    const hintBudget = Math.max(1, Math.floor(limit / 2));

    for (const tokenId of this.#resyncQueue) {
      if (chosen.size >= hintBudget) break;
      chosen.add(tokenId);
    }
    // Only the ones actually taken are cleared. Slicing and then clearing the
    // whole queue would silently drop every hint past the budget.
    for (const tokenId of chosen) this.#resyncQueue.delete(tokenId);

    // Bounded by the token count, not by `limit`: a rotation that cannot find
    // anything new must terminate rather than spin.
    for (let i = 0; i < seededTokens.length && chosen.size < limit; i += 1) {
      const token = seededTokens[this.#cursor % seededTokens.length];
      this.#cursor += 1;
      if (token !== undefined) chosen.add(token);
    }

    const batch = [...chosen];

    const options = signal === undefined ? {} : { signal };
    const { books } = await this.#clob.fetchBooks(batch, options);

    let agreed = 0;
    let ahead = 0;
    let content = 0;
    let stale = 0;
    let resynced = 0;
    const now = this.#now();

    for (const [tokenId, rest] of books) {
      const book = this.#books.get(tokenId);
      if (book === undefined || book.seededAt === null) continue;

      const restHash = rest.hash ?? '';

      if (restHash !== '' && restHash === book.hash) {
        if (sameLevels(book, rest)) {
          agreed += 1;
          this.#unrecognised.delete(tokenId);
          continue;
        }

        // Same state identifier, different contents: we hold the hash of the
        // venue's current state but not all the levels behind it, which means an
        // intermediate update never arrived. Measured against subscription size
        // — 0 of 565 changes at 5 tokens, 2.7% of comparisons at 200 — so this
        // is delivery loss under volume rather than a defect in the apply path.
        // It is still wrong, still repaired here, and still worth counting.
        content += 1;
        this.#contentDivergences += 1;
        bookDivergence.inc({ kind: 'content' });
        this.#logger.warn(
          {
            tokenId,
            hash: restHash,
            memory: { bids: book.bids.size, asks: book.asks.size, bestBid: book.bestBid, bestAsk: book.bestAsk },
            rest: { bids: rest.bids.length, asks: rest.asks.length, bestBid: rest.bids[0]?.price ?? null, bestAsk: rest.asks[0]?.price ?? null },
            sample: divergenceSample(book, rest),
          },
          'BOOK DIVERGENCE: in-memory book disagrees with REST at an identical state hash — an update was missed; repairing',
        );
        this.#install(book, rest);
        this.#unrecognised.delete(tokenId);
        resynced += 1;
        continue;
      }

      if (restHash !== '' && book.knowsHash(restHash)) {
        // We are ahead of the snapshot. Nothing to do.
        ahead += 1;
        this.#unrecognised.delete(tokenId);
        continue;
      }

      const parked = this.#unrecognised.get(tokenId);
      if (parked === undefined || parked.hash !== restHash) {
        this.#unrecognised.set(tokenId, { hash: restHash, since: now });
        continue;
      }

      // Same unrecognised state a full cycle later: not in flight, missed.
      stale += 1;
      this.#staleDivergences += 1;
      bookDivergence.inc({ kind: 'stale' });
      this.#logger.warn(
        { tokenId, hash: restHash, parkedForMs: now - parked.since },
        'BOOK DIVERGENCE: a REST state we never received, still unseen a cycle later — updates were missed',
      );
      this.#install(book, rest);
      this.#unrecognised.delete(tokenId);
      resynced += 1;
    }

    return {
      checked: books.size,
      agreed,
      ahead,
      contentDivergences: content,
      staleDivergences: stale,
      pending: this.#unrecognised.size,
      resynced,
    };
  }

  // -- internals ------------------------------------------------------------

  #connect(shard: Shard): void {
    if (this.#stopped) return;

    let socket: WebSocketLike;
    try {
      socket = this.#createWebSocket(this.#url);
    } catch (error) {
      this.#logger.warn({ shard: shard.index, error: describeError(error) }, 'could not open websocket');
      this.#scheduleReconnect(shard);
      return;
    }

    shard.socket = socket;
    shard.connected = false;

    const reconnecting = shard.attempt > 0;

    socket.onopen = () => {
      shard.connected = true;
      shard.attempt = 0;
      shard.lastMessageAt = this.#now();
      shard.lastPingAt = this.#now();
      wsConnected.set(this.#shards.filter((s) => s.connected).length);

      // The whole asset set, in one message: a second subscribe on the same
      // socket is rejected outright (hazard 4).
      try {
        socket.send(JSON.stringify({ assets_ids: shard.assets, type: 'market' }));
      } catch (error) {
        this.#logger.warn({ shard: shard.index, error: describeError(error) }, 'subscribe failed');
        this.#drop(shard, 'subscribe-failed');
        return;
      }

      this.#logger.debug({ shard: shard.index, assets: shard.assets.length }, 'shard subscribed');

      // Nothing is replayed for the time we were away, so the books this shard
      // owns are of unknown age. Re-seeding is the only way back to a known
      // state; letting the reconciler discover it a few hundred tokens a minute
      // would leave them wrong for minutes, and wrong quietly.
      if (reconnecting) this.#reseed(shard);
    };

    socket.onmessage = (event) => {
      shard.lastMessageAt = this.#now();
      this.#handle(String(event.data));
    };

    socket.onerror = () => {
      // `onclose` always follows, and carries the code. Nothing useful to add.
    };

    socket.onclose = (event) => {
      const wasConnected = shard.connected;
      shard.connected = false;
      shard.socket = null;
      wsConnected.set(this.#shards.filter((s) => s.connected).length);

      if (this.#stopped) return;

      if (wasConnected) {
        this.#logger.warn(
          { shard: shard.index, code: event.code, reason: event.reason },
          'websocket closed; reconnecting',
        );
      }
      this.#scheduleReconnect(shard);
    };
  }

  #drop(shard: Shard, reason: string): void {
    shard.connected = false;
    const socket = shard.socket;
    shard.socket = null;
    // Detach first. Closing a socket fires its own `onclose`, which would
    // schedule a second reconnect for the same shard — doubling the backoff
    // exponent and the reconnect count on every recycled connection.
    detach(socket);
    try {
      socket?.close(4000, reason);
    } catch {
      // Already gone.
    }
    this.#scheduleReconnect(shard);
  }

  /**
   * Full-jitter backoff, the same policy the HTTP clients use.
   *
   * Full rather than equal jitter matters more here than there: every shard
   * disconnects together when the venue restarts, and correlated reconnects are
   * how a blip becomes an outage.
   */
  #scheduleReconnect(shard: Shard): void {
    if (this.#stopped) return;

    this.#reconnects += 1;
    wsReconnects.inc({});

    const waitMs = fullJitterBackoff(
      shard.attempt,
      null,
      this.#reconnectBaseMs,
      this.#reconnectMaxMs,
      this.#random,
    );
    shard.attempt += 1;
    shard.nextAttemptAt = this.#now() + waitMs;
  }

  /**
   * Rebuilds a shard's books from REST after it reconnects.
   *
   * Unseeded first, so changes arriving mid-seed are buffered and replayed
   * against the new snapshot rather than applied to the old one. Stage 1 falls
   * back to cached quotes for these markets in the meantime, which is the honest
   * answer while the true state is unknown.
   */
  #reseed(shard: Shard): void {
    for (const tokenId of shard.assets) {
      const book = this.#books.get(tokenId);
      if (book !== undefined) book.seededAt = null;
    }

    void this.seed(shard.assets).catch((error: unknown) => {
      this.#logger.warn(
        { shard: shard.index, error: describeError(error) },
        're-seed after reconnect failed; those books stay unseeded until the next attempt',
      );
    });
  }

  #install(book: LiveBook, rest: OrderBook): void {
    book.reset(
      rest.bids.map((l) => [l.price, l.size] as const),
      rest.asks.map((l) => [l.price, l.size] as const),
    );
    book.conditionId = rest.conditionId;
    book.timestamp = rest.timestamp;
    book.tickSize = rest.tickSize;
    book.minOrderSize = rest.minOrderSize;
    book.negRisk = rest.negRisk;
    book.lastTradePrice = rest.lastTradePrice;
    book.seededAt = new Date(this.#now());
    book.updatedAt = this.#now();
    book.version += 1;
    book.hashes.length = 0;
    book.hash = null;
    book.noteHash(rest.hash ?? undefined);

    // Drained here, per token, the instant its base exists. A single batched
    // drain at the end of `seed` would leave the first batch's books unpatched
    // for the whole length of the seed — six seconds across 125 requests at
    // production size — while their buffered changes sat unapplied.
    this.#drainPending(book);
  }

  #handle(raw: string): void {
    this.#messages += 1;

    // `PONG` and `INVALID OPERATION` are bare text frames, not JSON.
    if (raw.length === 0) return;
    const first = raw[0];
    if (first !== '[' && first !== '{') {
      wsMessages.inc({ type: raw === 'PONG' ? 'pong' : 'text' });
      if (raw !== 'PONG') {
        this.#logger.warn({ frame: raw.slice(0, 120) }, 'unexpected text frame from the market feed');
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      wsMessages.inc({ type: 'unparseable' });
      this.#logger.warn({ frame: raw.slice(0, 200) }, 'market feed frame was not valid JSON');
      return;
    }

    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const event = wsEventSchema.safeParse(item);
      if (!event.success) {
        wsMessages.inc({ type: 'unknown' });
        continue;
      }

      if (event.data.event_type === 'book') {
        wsMessages.inc({ type: 'book' });
        this.#onBook(event.data as z.infer<typeof wsBookSchema>);
      } else if (event.data.event_type === 'price_change') {
        wsMessages.inc({ type: 'price_change' });
        this.#onPriceChange(event.data as z.infer<typeof wsPriceChangeSchema>);
      } else {
        wsMessages.inc({ type: event.data.event_type });
      }
    }
  }

  /**
   * A full snapshot pushed by the venue.
   *
   * Trusted when it arrives, but never depended on: it is delivered for small
   * subscriptions and essentially not at all for large ones (hazard 3).
   */
  #onBook(event: z.infer<typeof wsBookSchema>): void {
    const book = this.#books.get(event.asset_id);
    if (book === undefined) return;

    book.reset(
      (event.bids ?? []).map((l) => [Number(l.price), Number(l.size)] as const).filter(valid),
      (event.asks ?? []).map((l) => [Number(l.price), Number(l.size)] as const).filter(valid),
    );
    book.conditionId = event.market ?? book.conditionId;
    book.timestamp = venueTime(event.timestamp);
    book.seededAt ??= new Date(this.#now());
    book.updatedAt = this.#now();
    book.version += 1;
    book.noteHash(event.hash);

    this.#emit(book);
  }

  #onPriceChange(event: z.infer<typeof wsPriceChangeSchema>): void {
    const ts = venueTime(event.timestamp);
    const touched = new Map<string, { best_bid?: string | undefined; best_ask?: string | undefined }>();

    for (const change of event.price_changes) {
      const book = this.#books.get(change.asset_id);
      if (book === undefined) continue;

      const side = change.side.toUpperCase() === 'BUY' ? 'bids' : 'asks';
      const price = Number(change.price);
      const size = Number(change.size);

      if (book.seededAt === null) {
        // Hazard 3. Applying this would build a book out of only the levels that
        // moved — no resting depth, no error, and a confident wrong price.
        this.#changesUnseeded += 1;
        if (this.#seedingTokens.has(change.asset_id)) {
          const queue = this.#pendingChanges.get(change.asset_id) ?? [];
          queue.push({ side, price, size, ts: ts?.getTime() ?? 0, hash: change.hash });
          this.#pendingChanges.set(change.asset_id, queue);
        }
        continue;
      }

      if (book.apply(side, price, size)) {
        this.#changesApplied += 1;
        book.conditionId = event.market ?? book.conditionId;
        book.timestamp = ts;
        book.updatedAt = this.#now();
        book.noteHash(change.hash);
        touched.set(change.asset_id, { best_bid: change.best_bid, best_ask: change.best_ask });
      }
    }

    for (const [tokenId, reported] of touched) {
      const book = this.#books.get(tokenId);
      if (book === undefined) continue;
      this.#checkTop(book, reported);
      this.#emit(book);
    }
  }

  /**
   * Compares the applied top against the top the venue reported on the event.
   *
   * A *hint*, deliberately not a verdict — see hazard 6. The reported top is the
   * venue's current best bid/ask, which routinely runs ahead of the incremental
   * stream, so a disagreement usually means an update is still in flight rather
   * than that anything is wrong. Counting these as divergences measured a 0.6%
   * false-positive rate and would have made the divergence counter meaningless.
   *
   * What it is good for is prioritisation: a token whose top disagrees is a
   * token worth reconciling next, and reconciliation is hash-gated and therefore
   * capable of telling the difference.
   *
   * Only compared when both sides are present on both views: a book with one
   * empty side has no meaningful top.
   */
  #checkTop(book: LiveBook, reported: { best_bid?: string | undefined; best_ask?: string | undefined }): void {
    const bid = reported.best_bid === undefined ? null : Number(reported.best_bid);
    const ask = reported.best_ask === undefined ? null : Number(reported.best_ask);
    if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask)) return;

    const mine = { bid: book.bestBid, ask: book.bestAsk };
    if (mine.bid === null || mine.ask === null) return;

    // A tick is 0.001 at the coarsest; half a tick is comfortably inside the
    // float noise of parsing decimal strings and far below a real disagreement.
    const off = Math.abs(mine.bid - bid) > 5e-4 || Math.abs(mine.ask - ask) > 5e-4;
    if (!off) return;

    this.#topHints += 1;
    this.#logger.debug(
      { tokenId: book.tokenId, reported: { bid, ask }, memory: mine },
      'applied top trails the top the venue reported; queued for reconciliation',
    );
    this.#resyncQueue.add(book.tokenId);
  }

  /** Replays the changes buffered for one token while its seed was in flight. */
  #drainPending(book: LiveBook): void {
    const queue = this.#pendingChanges.get(book.tokenId);
    if (queue === undefined) return;
    this.#pendingChanges.delete(book.tokenId);

    const base = book.timestamp?.getTime() ?? 0;
    let applied = 0;
    let latest = 0;

    for (const change of queue) {
      // A buffered change older than the snapshot describes a level the
      // snapshot already accounts for; replaying it would move the book
      // backwards.
      if (change.ts < base) continue;
      if (book.apply(change.side, change.price, change.size)) {
        this.#changesApplied += 1;
        book.noteHash(change.hash);
        applied += 1;
        if (change.ts > latest) latest = change.ts;
      }
    }

    if (applied === 0) return;

    // The book now reflects those changes, so its timestamp is the newest change
    // applied — not the snapshot it started from. Leaving the snapshot's
    // timestamp here makes every violation this emission opens look as old as
    // the venue's last write to that market, which on a quiet one is minutes:
    // measured as a 331-second worst case in the latency histogram, all of it
    // an artefact of seeding rather than anything the checker was slow to see.
    if (latest > 0) book.timestamp = new Date(latest);
    book.updatedAt = this.#now();
    this.#emit(book);
  }

  #emit(book: LiveBook): void {
    if (this.#listeners.length === 0) return;

    const update: BookUpdate = {
      tokenId: book.tokenId,
      conditionId: book.conditionId,
      at: book.timestamp,
      receivedAt: book.updatedAt,
    };

    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch (error) {
        // One bad listener must not stop the others, and must not stop the feed.
        this.#logger.warn({ error: describeError(error) }, 'feed update handler threw, continuing');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Silences a socket before closing it, so its `onclose` cannot fire twice. */
function detach(socket: WebSocketLike | null): void {
  if (socket === null) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

function valid(level: readonly [number, number]): boolean {
  const [price, size] = level;
  return Number.isFinite(price) && Number.isFinite(size) && price > 0 && price <= 1 && size > 0;
}

function venueTime(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

function sameLevels(book: LiveBook, rest: OrderBook): boolean {
  if (book.bids.size !== rest.bids.length || book.asks.size !== rest.asks.length) return false;
  for (const level of rest.bids) {
    const mine = book.bids.get(level.price);
    if (mine === undefined || Math.abs(mine - level.size) > 1e-6) return false;
  }
  for (const level of rest.asks) {
    const mine = book.asks.get(level.price);
    if (mine === undefined || Math.abs(mine - level.size) > 1e-6) return false;
  }
  return true;
}

/** The first few disagreeing levels, so a divergence log says *what* differs. */
function divergenceSample(book: LiveBook, rest: OrderBook): string[] {
  const out: string[] = [];
  for (const [side, levels, mine] of [
    ['bid', rest.bids, book.bids],
    ['ask', rest.asks, book.asks],
  ] as const) {
    for (const level of levels) {
      const held = mine.get(level.price);
      if (held === undefined) out.push(`${side} ${level.price}: rest ${level.size}, missing here`);
      else if (Math.abs(held - level.size) > 1e-6) out.push(`${side} ${level.price}: rest ${level.size}, here ${held}`);
      if (out.length >= 6) return out;
    }
    for (const [price, size] of mine) {
      if (!levels.some((l) => l.price === price)) out.push(`${side} ${price}: here ${size}, absent from rest`);
      if (out.length >= 6) return out;
    }
  }
  return out;
}
