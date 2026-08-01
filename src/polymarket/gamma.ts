import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import {
  attemptSignal,
  defaultSleep,
  fullJitterBackoff,
  parseRetryAfter as parseRetryAfterHeader,
  TokenBucket,
  truncate,
  type PolymarketLogger,
  type Sleep,
} from './http.js';
import {
  keysetPageSchema,
  parseEvent,
  parseMarket,
  type Event,
  type FieldIssue,
  type Market,
  type RecordParse,
} from './schemas.js';

/**
 * Client for the Polymarket Gamma API — the public catalog of markets and
 * events. No authentication.
 *
 * Three things shape the design:
 *
 * - **Keyset pagination.** `/markets/keyset` and `/events/keyset` take
 *   `after_cursor` and `limit` (max 100) and return `next_cursor` until the
 *   last page. Sending `offset` to a keyset endpoint is a 422, so this client
 *   never sends one and strips it from caller-supplied params.
 * - **Streaming.** The catalog is large and grows; the crawl surface is a pair
 *   of async generators that hold one page at a time and never materialise the
 *   whole catalog.
 * - **A shared rate budget.** Polymarket's limits are Cloudflare-driven and
 *   global across all callers rather than per-key (roughly 4,000 req / 10s on
 *   Gamma), so a 429 is possible at any rate. The token bucket here is a
 *   courtesy cap, not a guarantee — the retry loop is what actually keeps a
 *   crawl alive.
 */

export const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

/** Server-side ceiling; a larger `limit` is rejected, so requests are clamped. */
export const MAX_PAGE_LIMIT = 100;

/** Far under the published ~400 req/s, because the budget is shared globally. */
const DEFAULT_REQUESTS_PER_SECOND = 20;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'user-agent': 'dutchbook/0.1 (+polymarket-gamma-client)',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for every failure raised by this client. */
export class GammaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request never produced a response: DNS, TCP, TLS, or timeout. */
export class GammaNetworkError extends GammaError {
  readonly url: string;
  readonly attempts: number;

  constructor(message: string, url: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.url = url;
    this.attempts = attempts;
  }
}

/** A non-2xx response that the client gave up on. */
export class GammaHttpError extends GammaError {
  readonly status: number;
  readonly url: string;
  readonly attempts: number;
  /** Truncated response body, for the log line. */
  readonly body: string;

  constructor(message: string, status: number, url: string, attempts: number, body: string) {
    super(message);
    this.status = status;
    this.url = url;
    this.attempts = attempts;
    this.body = body;
  }
}

/**
 * Throttled past the retry budget.
 *
 * Extends {@link GammaHttpError} so a caller that only cares about "the request
 * failed" can catch one type, while a caller that wants to pause a crawl and
 * resume later can check for this specifically — `retryAfterMs` carries the
 * last hint the edge gave us.
 */
export class RateLimitExceededError extends GammaHttpError {
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

/** A 2xx response whose body was not the shape this client can page through. */
export class GammaSchemaError extends GammaError {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The unvalidated payload of a single HTTP response, for raw archival. */
export interface RawResponse {
  readonly url: string;
  readonly status: number;
  /** 0 for the first try, incrementing per retry. */
  readonly attempt: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /** `JSON.parse(text)`, or `undefined` when the body was not valid JSON. */
  readonly body: unknown;
}

/**
 * Called with every response the client receives — including retries and error
 * statuses — before validation. Ingest uses this to archive raw payloads.
 *
 * It is awaited, so a slow archive applies backpressure to the crawl. A hook
 * that throws is logged and ignored: archival must never break a crawl.
 */
export type RawResponseHook = (raw: RawResponse) => void | Promise<void>;

/** A response that forced the client to back off. */
export interface RateLimitEvent {
  readonly url: string;
  /** 429, or the 5xx that triggered the retry. */
  readonly status: number;
  /** 0 for the first try, incrementing per retry. */
  readonly attempt: number;
  readonly retryAfterMs: number | null;
}

/** The slice of a pino logger this client uses. */
export type GammaLogger = PolymarketLogger;

export interface GammaClientOptions {
  baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  logger?: GammaLogger;
  /** Token bucket refill rate. Default 20. */
  requestsPerSecond?: number;
  /** Bucket capacity, i.e. the allowed burst. Defaults to `requestsPerSecond`. */
  burst?: number;
  /** Retries after the first attempt. Default 6. */
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Per-attempt request timeout. Default 30s. */
  timeoutMs?: number;
  onRawResponse?: RawResponseHook;
  /**
   * Called for every 429 or 5xx, before the backoff. Polymarket's budget is
   * shared globally, so this firing without our own rate changing is the
   * signal that someone else is consuming it.
   */
  onRateLimited?: (event: RateLimitEvent) => void;
  /** Injectable jitter source; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable monotonic clock for the token bucket. */
  now?: () => number;
  /** Injectable sleep, for both backoff and rate limiting. */
  sleep?: Sleep;
}

export interface IterateOptions {
  /** Page size, clamped to {@link MAX_PAGE_LIMIT}. Default 100. */
  limit?: number;
  /** Resume a previous crawl from its last `next_cursor`. */
  afterCursor?: string;
  /** Stop after this many pages. Unlimited by default. */
  maxPages?: number;
  signal?: AbortSignal;
  /**
   * Extra query parameters, e.g. `{ closed: false, tag_id: 100 }`.
   * `offset` is dropped — keyset endpoints answer it with a 422.
   */
  params?: Readonly<Record<string, string | number | boolean | undefined>>;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Re-exported so existing callers and tests keep one import site. The
 * implementation is shared with every other Polymarket client — see
 * {@link ./http.ts} for why that sharing is load-bearing rather than tidiness.
 */
export const parseRetryAfter = parseRetryAfterHeader;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GammaClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: GammaLogger;
  readonly #bucket: TokenBucket;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #onRawResponse: RawResponseHook | undefined;
  readonly #onRateLimited: ((event: RateLimitEvent) => void) | undefined;
  readonly #random: () => number;
  readonly #sleep: Sleep;

  constructor(options: GammaClientOptions = {}) {
    const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;

    this.#baseUrl = options.baseUrl ?? GAMMA_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? createLogger('polymarket-gamma');
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
   * Streams the market catalog, one market at a time. The caller never holds
   * more than a page.
   */
  async *iterateMarkets(options: IterateOptions = {}): AsyncGenerator<Market> {
    yield* this.#iterate('/markets/keyset', 'market', parseMarket, options);
  }

  /** Streams the event catalog, including each event's nested markets. */
  async *iterateEvents(options: IterateOptions = {}): AsyncGenerator<Event> {
    yield* this.#iterate('/events/keyset', 'event', parseEvent, options);
  }

  /**
   * Markets by condition id, in one request.
   *
   * `/markets` accepts a repeated `condition_ids` parameter, which is the only
   * cheap way to price a scattered subset of the catalog: the alternative is
   * one request per market, and the coherence screen needs hundreds every
   * minute. Not a keyset endpoint, so no cursor is involved.
   *
   * The venue silently omits ids it does not recognise, so the caller gets back
   * fewer markets than it asked for rather than an error. Match on
   * `conditionId` rather than position.
   */
  async fetchMarketsByConditionIds(
    conditionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Market[]> {
    const wanted = [...new Set(conditionIds.filter((id) => id !== ''))];
    if (wanted.length === 0) return [];

    const url = new URL('/markets', this.#baseUrl);
    for (const id of wanted) url.searchParams.append('condition_ids', id);

    const body = await this.#fetchUrl(url.toString(), signal);
    if (!Array.isArray(body)) {
      throw new GammaSchemaError('expected an array of markets', url.pathname);
    }

    const markets: Market[] = [];
    for (const [index, raw] of body.entries()) {
      const parsed = parseMarket(raw);
      if (!parsed.ok) {
        this.#logger.warn({ index, reason: parsed.reason }, 'gamma market skipped: unidentifiable');
        continue;
      }
      this.#reportIssues('market', parsed.value.id, parsed.issues);
      markets.push(parsed.value);
    }
    return markets;
  }

  async *#iterate<T extends { id: string }>(
    path: string,
    kind: string,
    parseRecord: (input: unknown) => RecordParse<T>,
    options: IterateOptions,
  ): AsyncGenerator<T> {
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(options.limit ?? MAX_PAGE_LIMIT)));
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const extra = this.#sanitizeParams(options.params, path);

    let cursor = options.afterCursor;
    let pages = 0;
    const seenCursors = new Set<string>();

    for (;;) {
      const query: Record<string, string | number | boolean> = { ...extra, limit };
      if (cursor !== undefined && cursor !== '') query['after_cursor'] = cursor;

      const body = await this.#fetchJson(path, query, options.signal);
      const page = keysetPageSchema.safeParse(body);
      if (!page.success) {
        throw new GammaSchemaError(
          `unexpected ${kind} page shape: ${page.error.issues.map((i) => i.message).join('; ')}`,
          path,
        );
      }

      pages += 1;
      const { records, nextCursor } = page.data;

      for (const [index, raw] of records.entries()) {
        const parsed = parseRecord(raw);

        if (!parsed.ok) {
          // No usable id, so there is nothing to key a warning on but position.
          this.#logger.warn(
            { kind, cursor: cursor ?? null, index, reason: parsed.reason },
            'gamma record skipped: unidentifiable',
          );
          continue;
        }

        this.#reportIssues(kind, parsed.value.id, parsed.issues);
        yield parsed.value;
      }

      if (nextCursor === null || pages >= maxPages) return;

      // A server that echoes its own cursor would otherwise crawl forever.
      if (seenCursors.has(nextCursor)) {
        this.#logger.warn({ kind, cursor: nextCursor, pages }, 'gamma cursor repeated, stopping');
        return;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  #reportIssues(kind: string, id: string, issues: readonly FieldIssue[]): void {
    for (const issue of issues) {
      this.#logger.warn(
        {
          kind,
          [`${kind}Id`]: id,
          field: issue.field,
          reason: issue.reason,
          received: truncate(JSON.stringify(issue.received) ?? String(issue.received), 200),
        },
        'gamma field dropped: kept record with field null',
      );
    }
  }

  /** Drops `offset`, which keyset endpoints answer with a 422. */
  #sanitizeParams(
    params: IterateOptions['params'],
    path: string,
  ): Record<string, string | number | boolean> {
    const clean: Record<string, string | number | boolean> = {};
    if (params === undefined) return clean;

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (key === 'offset') {
        this.#logger.warn({ path }, 'gamma dropped `offset`: keyset endpoints reject it with 422');
        continue;
      }
      clean[key] = value;
    }
    return clean;
  }

  /**
   * One request, with rate limiting, retries, and raw capture.
   *
   * Retries 429 and 5xx with exponential backoff and full jitter — full rather
   * than equal jitter because every caller shares one global budget, and
   * correlated retries are what turn a blip into an outage. Other 4xx are the
   * caller's bug and fail immediately.
   */
  async #fetchJson(
    path: string,
    query: Record<string, string | number | boolean>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return this.#fetchUrl(url.toString(), signal);
  }

  /** The retry/rate-limit loop, against an already-built URL. */
  async #fetchUrl(target: string, signal?: AbortSignal): Promise<unknown> {

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
          headers: REQUEST_HEADERS,
          signal: this.#attemptSignal(signal),
        });
      } catch (error) {
        // A caller-initiated abort is not a transport failure — surface it.
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
        });

        if (response.ok) {
          if (body === undefined) {
            throw new GammaSchemaError('response body was not valid JSON', target);
          }
          return body;
        }

        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        lastStatus = response.status;
        lastBody = truncate(text, 500);
        lastRetryAfterMs = retryAfterMs;
        if (response.status === 429) throttled = true;

        // Retryable, so it costs us a backoff — report it before sleeping.
        this.#onRateLimited?.({
          url: target,
          status: response.status,
          attempt,
          retryAfterMs,
        });

        if (response.status !== 429 && response.status < 500) {
          throw new GammaHttpError(
            `gamma ${response.status} for ${target}`,
            response.status,
            target,
            attempt + 1,
            lastBody,
          );
        }
      }

      if (attempt >= this.#maxRetries) break;

      const waitMs = this.#backoff(attempt, retryAfterMs);
      this.#logger.debug(
        {
          url: target,
          attempt: attempt + 1,
          status: lastStatus,
          waitMs,
          error: lastNetworkError === null ? null : describeError(lastNetworkError),
        },
        'gamma request failed, retrying',
      );

      await this.#sleep(waitMs, signal);
      attempt += 1;
    }

    const attempts = attempt + 1;

    if (throttled) {
      throw new RateLimitExceededError(
        `gamma rate limit not cleared after ${attempts} attempts for ${target}`,
        lastStatus ?? 429,
        target,
        attempts,
        lastBody,
        lastRetryAfterMs,
      );
    }

    if (lastStatus !== null) {
      throw new GammaHttpError(
        `gamma ${lastStatus} after ${attempts} attempts for ${target}`,
        lastStatus,
        target,
        attempts,
        lastBody,
      );
    }

    throw new GammaNetworkError(
      `gamma unreachable after ${attempts} attempts: ${describeError(lastNetworkError)}`,
      target,
      attempts,
      { cause: lastNetworkError },
    );
  }

  #backoff(attempt: number, retryAfterMs: number | null): number {
    return fullJitterBackoff(
      attempt,
      retryAfterMs,
      this.#baseBackoffMs,
      this.#maxBackoffMs,
      this.#random,
    );
  }

  #attemptSignal(signal: AbortSignal | undefined): AbortSignal {
    return attemptSignal(signal, this.#timeoutMs);
  }

  async #emitRaw(raw: RawResponse): Promise<void> {
    if (this.#onRawResponse === undefined) return;
    try {
      await this.#onRawResponse(raw);
    } catch (error) {
      this.#logger.warn(
        { url: raw.url, error: describeError(error) },
        'gamma raw-response hook threw, continuing',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience
// ---------------------------------------------------------------------------

let shared: GammaClient | undefined;

/** The process-wide client, so one token bucket governs every caller. */
export function gammaClient(): GammaClient {
  return (shared ??= new GammaClient());
}

/** Streams every market in the catalog through the shared client. */
export async function* iterateMarkets(options: IterateOptions = {}): AsyncGenerator<Market> {
  yield* gammaClient().iterateMarkets(options);
}

/** Streams every event in the catalog through the shared client. */
export async function* iterateEvents(options: IterateOptions = {}): AsyncGenerator<Event> {
  yield* gammaClient().iterateEvents(options);
}
