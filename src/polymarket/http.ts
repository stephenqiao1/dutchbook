import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * The transport discipline shared by every Polymarket client.
 *
 * This exists so "the CLOB client rate-limits like the Gamma client" is
 * guaranteed by *being the same code* rather than by two copies that agree
 * today. Polymarket's budget is enforced per-IP at the Cloudflare edge and is
 * therefore shared across every client in this process: two independent token
 * buckets would each believe it was well under budget while together exceeding
 * it, and the failure would show up as someone else's crawl being throttled.
 *
 * Nothing here knows about markets, books, or JSON shapes. Endpoint-specific
 * behaviour belongs in the clients.
 */

/** A `Retry-After` beyond this is treated as a stuck edge, not an instruction. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** The slice of a pino logger these clients use. */
export interface PolymarketLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Real sleep, cancellable by the caller's signal. */
export const defaultSleep: Sleep = (ms, signal) => sleepFor(ms, undefined, { signal });

/**
 * Classic token bucket. `take()` resolves once a token is available, so callers
 * queue rather than burst.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #tokensPerMs: number;
  readonly #now: () => number;
  readonly #sleep: Sleep;

  #tokens: number;
  #updatedAt: number;

  constructor(requestsPerSecond: number, capacity: number, now: () => number, sleep: Sleep) {
    this.#capacity = Math.max(1, capacity);
    this.#tokensPerMs = requestsPerSecond / 1_000;
    this.#now = now;
    this.#sleep = sleep;
    this.#tokens = this.#capacity;
    this.#updatedAt = now();
  }

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.#now();
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + Math.max(0, now - this.#updatedAt) * this.#tokensPerMs,
      );
      this.#updatedAt = now;

      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }

      const waitMs = Math.max(1, Math.ceil((1 - this.#tokens) / this.#tokensPerMs));
      await this.#sleep(waitMs, signal);
    }
  }
}

/**
 * `Retry-After` as milliseconds. The header is either delta-seconds or an
 * HTTP-date; both are accepted, and both are capped.
 */
export function parseRetryAfter(header: string | null, now: () => number = Date.now): number | null {
  if (header === null) return null;

  const text = header.trim();
  if (text === '') return null;

  const seconds = Number(text);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(text) - now();

  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Full jitter: `random() * min(cap, base * 2^attempt)`, floored by `Retry-After`.
 *
 * Full rather than equal jitter because every caller shares one global budget,
 * and correlated retries are what turn a blip into an outage.
 */
export function fullJitterBackoff(
  attempt: number,
  retryAfterMs: number | null,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.ceil(Math.max(retryAfterMs ?? 0, random() * ceiling));
}

/** Per-attempt timeout, combined with the caller's cancellation. */
export function attemptSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
