import { z } from 'zod';

import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import {
  attemptSignal,
  defaultSleep,
  fullJitterBackoff,
  parseRetryAfter,
  TokenBucket,
  truncate,
  type PolymarketLogger,
  type Sleep,
} from './http.js';

/**
 * Client for the Polymarket CLOB — the live central limit order book.
 *
 * This exists because Gamma's prices are not tradeable. Gamma reports a
 * midpoint that lags the book by seconds, and a midpoint is not a price you can
 * transact at even when it is current: it ignores the spread, and it ignores
 * whether there is any size behind it. An arbitrage computed from Gamma
 * midpoints is usually an illusion that evaporates on contact with real depth.
 *
 * Read-only. There is no authentication, no wallet, and no order placement
 * here, deliberately — every endpoint this touches is public.
 *
 * Three things the live API does that the code below has to defend against,
 * each verified against the running service rather than assumed:
 *
 * 1. **Levels arrive worst-first.** `bids` come back ascending by price and
 *    `asks` descending, so on *both* sides the best price is the *last*
 *    element. Reading `bids[0]` as the top of book is off by the whole depth of
 *    the book — on one live market that is 0.001 against a real best bid of
 *    0.024. This client sorts explicitly and never trusts the wire order.
 * 2. **`POST /books` does not answer in request order.** A six-token request
 *    came back permuted. Mapping responses to requests positionally would
 *    silently attribute every book to the wrong market, which is the kind of
 *    bug that produces confident, wrong prices rather than an error. Responses
 *    are keyed by `asset_id`.
 * 3. **Unknown tokens are dropped, not rejected.** That same request contained
 *    one bogus token id and returned 200 with five books. A caller that assumes
 *    one response per request would shift its own bookkeeping. `fetchBooks`
 *    reports the missing ids instead.
 */

export const CLOB_BASE_URL = 'https://clob.polymarket.com';

/**
 * `/books` is limited to 500 req / 10s — its own budget, far tighter than the
 * 9,000 req / 10s general CLOB allowance, because one request covers many
 * tokens. 50 req/s is the ceiling; 20 leaves headroom for other callers sharing
 * this IP, exactly as the Gamma client does.
 *
 * Source: https://docs.polymarket.com/api-reference/rate-limits (2026-08-01)
 */
const DEFAULT_REQUESTS_PER_SECOND = 20;

/**
 * Tokens per `POST /books` call.
 *
 * No maximum is published. Batches of 100, 250, and 500 were all accepted and
 * answered in full against the live service; 100 is the default because a
 * failed request costs a whole batch, and the request is retried as a unit.
 */
export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 500;

const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'dutchbook/0.1 (+polymarket-clob-client)',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ClobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request never produced a response: DNS, TCP, TLS, or timeout. */
export class ClobNetworkError extends ClobError {
  readonly url: string;
  readonly attempts: number;

  constructor(message: string, url: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.url = url;
    this.attempts = attempts;
  }
}

/** A non-2xx response the client gave up on. */
export class ClobHttpError extends ClobError {
  readonly status: number;
  readonly url: string;
  readonly attempts: number;
  readonly body: string;

  constructor(message: string, status: number, url: string, attempts: number, body: string) {
    super(message);
    this.status = status;
    this.url = url;
    this.attempts = attempts;
    this.body = body;
  }
}

/** Throttled past the retry budget. */
export class ClobRateLimitError extends ClobHttpError {
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number,
    url: string,
    attempts: number,
    body: string,
    retryAfterMs: number | null,
  ) {
    super(message, status, url, attempts, body);
    this.retryAfterMs = retryAfterMs;
  }
}

/** A 2xx response whose body was not the shape this client can read. */
export class ClobSchemaError extends ClobError {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

/**
 * Prices and sizes arrive as decimal *strings* (`"0.024"`, `"18638"`).
 *
 * They are parsed to numbers here rather than kept as strings because every
 * downstream consumer does arithmetic on them. A level whose price or size does
 * not parse is dropped rather than coerced to zero: a zero-priced level would
 * look like free depth to the book walker, which is the most dangerous possible
 * way to be wrong.
 */
const wireLevelSchema = z.object({
  price: z.string(),
  size: z.string(),
});

const wireBookSchema = z.object({
  market: z.string().optional(),
  asset_id: z.string(),
  /** Milliseconds since epoch, as a string. */
  timestamp: z.string().optional(),
  hash: z.string().optional(),
  bids: z.array(wireLevelSchema).optional(),
  asks: z.array(wireLevelSchema).optional(),
  min_order_size: z.union([z.string(), z.number()]).optional(),
  tick_size: z.union([z.string(), z.number()]).optional(),
  neg_risk: z.boolean().optional(),
  last_trade_price: z.union([z.string(), z.number()]).optional(),
});

const wireBooksSchema = z.array(wireBookSchema);

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One price level. `size` is in shares. */
export interface BookLevel {
  readonly price: number;
  readonly size: number;
}

/**
 * A normalised order book.
 *
 * Invariant, and the reason this type exists rather than passing the wire shape
 * around: **`bids` are sorted best-first (descending price) and `asks`
 * best-first (ascending price).** The wire format is the opposite on both
 * sides. Everything downstream — the book walker especially — depends on this,
 * so normalisation happens once, here.
 */
export interface OrderBook {
  readonly tokenId: string;
  readonly conditionId: string | null;
  /** When the venue built the book, not when we received it. */
  readonly timestamp: Date | null;
  readonly hash: string | null;
  /** Descending by price: `bids[0]` is the best bid. */
  readonly bids: readonly BookLevel[];
  /** Ascending by price: `asks[0]` is the best ask. */
  readonly asks: readonly BookLevel[];
  readonly tickSize: number | null;
  readonly minOrderSize: number | null;
  readonly negRisk: boolean | null;
  readonly lastTradePrice: number | null;
}

export interface FetchBooksResult {
  /** Keyed by token id. Absent tokens are in {@link missing}. */
  readonly books: ReadonlyMap<string, OrderBook>;
  /**
   * Requested tokens the venue returned nothing for.
   *
   * Always check this. The API answers an unknown token id with silence and a
   * 200, so an empty `missing` is the only evidence that a request was fully
   * served.
   */
  readonly missing: readonly string[];
}

/** Best bid, best ask, and the midpoint between them. */
export interface TopOfBook {
  readonly bid: number | null;
  readonly ask: number | null;
  /** Null unless both sides are present — a one-sided book has no midpoint. */
  readonly mid: number | null;
  /** Null unless both sides are present. */
  readonly spread: number | null;
}

export function topOfBook(book: OrderBook): TopOfBook {
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  const both = bid !== null && ask !== null;
  return {
    bid,
    ask,
    mid: both ? (bid + ask) / 2 : null,
    spread: both ? ask - bid : null,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClobRawResponse {
  readonly url: string;
  readonly status: number;
  readonly attempt: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly body: unknown;
  /** The token ids this request asked about, for attribution. */
  readonly tokenIds: readonly string[];
}

export type ClobRawResponseHook = (raw: ClobRawResponse) => void | Promise<void>;

export interface ClobRateLimitEvent {
  readonly url: string;
  readonly status: number;
  readonly attempt: number;
  readonly retryAfterMs: number | null;
}

export interface ClobClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  logger?: PolymarketLogger;
  /** Token bucket refill rate. Default 20 (the `/books` ceiling is 50). */
  requestsPerSecond?: number;
  burst?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** Tokens per `POST /books`. Default 100, clamped to 500. */
  batchSize?: number;
  onRawResponse?: ClobRawResponseHook;
  onRateLimited?: (event: ClobRateLimitEvent) => void;
  random?: () => number;
  now?: () => number;
  sleep?: Sleep;
}

export interface FetchBooksOptions {
  signal?: AbortSignal;
  /** Override the client's batch size for this call. */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ClobClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: PolymarketLogger;
  readonly #bucket: TokenBucket;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #batchSize: number;
  readonly #onRawResponse: ClobRawResponseHook | undefined;
  readonly #onRateLimited: ((event: ClobRateLimitEvent) => void) | undefined;
  readonly #random: () => number;
  readonly #sleep: Sleep;

  constructor(options: ClobClientOptions = {}) {
    const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;

    this.#baseUrl = options.baseUrl ?? CLOB_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? createLogger('polymarket-clob');
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#batchSize = clampBatch(options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#onRawResponse = options.onRawResponse;
    this.#onRateLimited = options.onRateLimited;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? defaultSleep;

    this.#bucket = new TokenBucket(
      requestsPerSecond,
      options.burst ?? requestsPerSecond,
      options.now ?? (() => performance.now()),
      this.#sleep,
    );
  }

  /**
   * Order books for many tokens, batched through `POST /books`.
   *
   * One request per {@link DEFAULT_BATCH_SIZE} tokens rather than one per
   * token: `/books` and `/book` have almost the same per-request budget
   * (500 vs 1,500 req / 10s), so batching is worth up to two orders of
   * magnitude in throughput against the same rate limit.
   *
   * Duplicate ids are collapsed before the request and still resolve for every
   * caller, since the result is a map.
   */
  async fetchBooks(
    tokenIds: readonly string[],
    options: FetchBooksOptions = {},
  ): Promise<FetchBooksResult> {
    const wanted = [...new Set(tokenIds.filter((id) => id !== ''))];
    if (wanted.length === 0) return { books: new Map(), missing: [] };

    const size = clampBatch(options.batchSize ?? this.#batchSize);
    const books = new Map<string, OrderBook>();

    for (let i = 0; i < wanted.length; i += size) {
      const batch = wanted.slice(i, i + size);
      const body = await this.#postJson('/books', batch, options.signal);

      const parsed = wireBooksSchema.safeParse(body);
      if (!parsed.success) {
        throw new ClobSchemaError(
          `unexpected /books shape: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          '/books',
        );
      }

      for (const wire of parsed.data) {
        // Keyed by asset_id, never by position: the venue reorders freely.
        books.set(wire.asset_id, normalizeBook(wire));
      }
    }

    const missing = wanted.filter((id) => !books.has(id));
    if (missing.length > 0) {
      this.#logger.warn(
        { requested: wanted.length, missing: missing.length, sample: missing.slice(0, 5) },
        'clob returned no book for some requested tokens',
      );
    }

    return { books, missing };
  }

  /** One token's book, or `null` when the venue does not know it. */
  async fetchBook(tokenId: string, options: FetchBooksOptions = {}): Promise<OrderBook | null> {
    const { books } = await this.fetchBooks([tokenId], options);
    return books.get(tokenId) ?? null;
  }

  /**
   * The venue's `base_fee` for a token, as returned.
   *
   * Returned raw and unconverted on purpose. The spec calls it basis points but
   * it only ever takes two values, and dividing it by 10,000 produces a rate
   * far above anything Polymarket publishes — see `FEE_ENABLED_SENTINEL_BPS` in
   * `src/pricing/costs.ts`. Pass it to `resolveFeeRate` rather than doing
   * arithmetic on it here.
   */
  async fetchBaseFeeBps(tokenId: string, signal?: AbortSignal): Promise<number | null> {
    const body = await this.#getJson(`/fee-rate/${encodeURIComponent(tokenId)}`, signal);
    const parsed = z.object({ base_fee: z.number() }).safeParse(body);
    return parsed.success ? parsed.data.base_fee : null;
  }

  /**
   * One request, with rate limiting, retries, and raw capture.
   *
   * Identical retry policy to the Gamma client: 429 and 5xx back off with full
   * jitter, other 4xx are the caller's bug and fail immediately.
   */
  async #postJson(
    path: string,
    tokenIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#request(
      path,
      'POST',
      JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
      tokenIds,
      signal,
    );
  }

  async #getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request(path, 'GET', undefined, [], signal);
  }

  async #request(
    path: string,
    method: 'GET' | 'POST',
    payload: string | undefined,
    tokenIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = new URL(path, this.#baseUrl).toString();

    let attempt = 0;
    let throttled = false;
    let lastStatus: number | null = null;
    let lastBody = '';
    let lastRetryAfterMs: number | null = null;
    let lastNetworkError: unknown = null;

    for (;;) {
      await this.#bucket.take(signal);
      signal?.throwIfAborted();

      let response: Response | null = null;
      let retryAfterMs: number | null = null;

      try {
        response = await this.#fetch(target, {
          method,
          headers: REQUEST_HEADERS,
          ...(payload === undefined ? {} : { body: payload }),
          signal: attemptSignal(signal, this.#timeoutMs),
        });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        lastNetworkError = error;
        lastStatus = null;
      }

      if (response !== null) {
        const text = await response.text();
        let body: unknown;
        try {
          body = text === '' ? null : JSON.parse(text);
        } catch {
          body = undefined;
        }

        await this.#emitRaw({
          url: target,
          status: response.status,
          attempt,
          headers: Object.fromEntries(response.headers),
          text,
          body,
          tokenIds,
        });

        if (response.ok) {
          if (body === undefined) {
            throw new ClobSchemaError('response body was not valid JSON', target);
          }
          return body;
        }

        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        lastStatus = response.status;
        lastBody = truncate(text, 500);
        lastRetryAfterMs = retryAfterMs;
        if (response.status === 429) throttled = true;

        this.#onRateLimited?.({ url: target, status: response.status, attempt, retryAfterMs });

        if (response.status !== 429 && response.status < 500) {
          throw new ClobHttpError(
            `clob ${response.status} for ${target}`,
            response.status,
            target,
            attempt + 1,
            lastBody,
          );
        }
      }

      if (attempt >= this.#maxRetries) break;

      const waitMs = fullJitterBackoff(
        attempt,
        retryAfterMs,
        this.#baseBackoffMs,
        this.#maxBackoffMs,
        this.#random,
      );
      this.#logger.debug(
        {
          url: target,
          attempt: attempt + 1,
          status: lastStatus,
          tokens: tokenIds.length,
          waitMs,
          error: lastNetworkError === null ? null : describeError(lastNetworkError),
        },
        'clob request failed, retrying',
      );

      await this.#sleep(waitMs, signal);
      attempt += 1;
    }

    const attempts = attempt + 1;

    if (throttled) {
      throw new ClobRateLimitError(
        `clob rate limit not cleared after ${attempts} attempts for ${target}`,
        lastStatus ?? 429,
        target,
        attempts,
        lastBody,
        lastRetryAfterMs,
      );
    }

    if (lastStatus !== null) {
      throw new ClobHttpError(
        `clob ${lastStatus} after ${attempts} attempts for ${target}`,
        lastStatus,
        target,
        attempts,
        lastBody,
      );
    }

    throw new ClobNetworkError(
      `clob unreachable after ${attempts} attempts: ${describeError(lastNetworkError)}`,
      target,
      attempts,
      { cause: lastNetworkError },
    );
  }

  async #emitRaw(raw: ClobRawResponse): Promise<void> {
    if (this.#onRawResponse === undefined) return;
    try {
      await this.#onRawResponse(raw);
    } catch (error) {
      this.#logger.warn(
        { url: raw.url, error: describeError(error) },
        'clob raw-response hook threw, continuing',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function clampBatch(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(size)));
}

function toNumber(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Wire levels to a sorted, sane side of the book.
 *
 * Drops anything that cannot be traded against: unparseable numbers, non-finite
 * values, non-positive sizes, and prices outside (0, 1]. A share on Polymarket
 * settles at 0 or 1 USDC, so a price outside that range is a malformed level
 * rather than an opportunity — and a level with size 0 is a resting order that
 * has already been filled.
 *
 * Sorting is explicit and does not assume the venue's ordering. It is also a
 * stable total order: equal prices keep their relative order, so a book with
 * duplicate price levels walks deterministically.
 */
function normalizeSide(
  levels: readonly z.infer<typeof wireLevelSchema>[] | undefined,
  direction: 'desc' | 'asc',
): BookLevel[] {
  const clean: BookLevel[] = [];

  for (const level of levels ?? []) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (size <= 0) continue;
    if (price <= 0 || price > 1) continue;
    clean.push({ price, size });
  }

  clean.sort((a, b) => (direction === 'desc' ? b.price - a.price : a.price - b.price));
  return clean;
}

/** One wire book to the normalised, best-first form the rest of the code uses. */
export function normalizeBook(wire: z.infer<typeof wireBookSchema>): OrderBook {
  const ms = toNumber(wire.timestamp);

  return {
    tokenId: wire.asset_id,
    conditionId: wire.market ?? null,
    timestamp: ms === null ? null : new Date(ms),
    hash: wire.hash ?? null,
    bids: normalizeSide(wire.bids, 'desc'),
    asks: normalizeSide(wire.asks, 'asc'),
    tickSize: toNumber(wire.tick_size),
    minOrderSize: toNumber(wire.min_order_size),
    negRisk: wire.neg_risk ?? null,
    lastTradePrice: toNumber(wire.last_trade_price),
  };
}

/** Parses a raw `/books` payload. Exported so fixtures can be replayed in tests. */
export function parseBooksPayload(body: unknown): OrderBook[] {
  const parsed = wireBooksSchema.safeParse(body);
  if (!parsed.success) {
    throw new ClobSchemaError(
      `unexpected /books shape: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      '/books',
    );
  }
  return parsed.data.map((wire) => normalizeBook(wire));
}

// ---------------------------------------------------------------------------
// Module-level convenience
// ---------------------------------------------------------------------------

let shared: ClobClient | undefined;

/** The process-wide client, so one token bucket governs every caller. */
export function clobClient(): ClobClient {
  return (shared ??= new ClobClient());
}
