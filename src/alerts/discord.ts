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
} from '../polymarket/http.js';

/**
 * Discord webhook transport.
 *
 * Same rate-limit and backoff discipline as the Polymarket clients — shared
 * from `polymarket/http.ts` rather than reimplemented — with one Discord
 * speciality: a 429 carries `retry_after` in the JSON body as **float seconds**,
 * which is more precise than the integer `Retry-After` header beside it. Both
 * are read and the larger is honoured.
 *
 * Two endpoints, verified against the current API reference:
 *
 * - `POST /webhooks/{id}/{token}` — **`?wait=true` is not optional here.**
 *   Without it Discord answers 204 with no body, and the message id never
 *   exists. That id is what makes "edit the original message when the violation
 *   resolves" possible, so every send this client makes asks for it.
 * - `PATCH /webhooks/{id}/{token}/messages/{message.id}` — edit.
 */

const log = createLogger('alerts:discord');

/** Well under any per-route bucket; alerting is not a throughput problem. */
const DEFAULT_REQUESTS_PER_SECOND = 2;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Documented ceilings. Exceeding any of them is a 400, so formatting clamps. */
export const DISCORD_LIMITS = {
  content: 2000,
  embedsPerMessage: 10,
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  /** Sum across every text property of all embeds in one message. */
  embedTotal: 6000,
} as const;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  /** Decimal, not hex string. */
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  /** Reply to an earlier message, used for violation follow-ups. */
  message_reference?: { message_id: string; fail_if_not_exists?: boolean };
  allowed_mentions?: { parse: string[] };
}

export class DiscordError extends Error {
  readonly status: number | null;
  readonly body: string;

  constructor(message: string, status: number | null, body: string) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.body = body;
  }
}

export interface DiscordClientOptions {
  webhookUrl: string;
  fetch?: typeof globalThis.fetch;
  logger?: PolymarketLogger;
  requestsPerSecond?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: Sleep;
}

/** The subset of a sent message this service needs to remember. */
export interface SentMessage {
  readonly id: string;
}

export interface AlertTransport {
  send(message: DiscordMessage): Promise<SentMessage | null>;
  edit(messageId: string, message: DiscordMessage): Promise<boolean>;
}

export class DiscordClient implements AlertTransport {
  readonly #webhookUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: PolymarketLogger;
  readonly #bucket: TokenBucket;
  readonly #maxRetries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #random: () => number;
  readonly #sleep: Sleep;

  constructor(options: DiscordClientOptions) {
    const rps = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;

    this.#webhookUrl = options.webhookUrl.replace(/\?.*$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? log;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#bucket = new TokenBucket(rps, rps, options.now ?? (() => performance.now()), this.#sleep);
  }

  /** Posts a message and returns its id, or null when Discord withheld one. */
  async send(message: DiscordMessage): Promise<SentMessage | null> {
    // `wait=true` or there is no id, and without an id nothing can be edited.
    const body = await this.#request(`${this.#webhookUrl}?wait=true`, 'POST', message);
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? { id } : null;
  }

  /**
   * Edits an earlier message.
   *
   * Returns false rather than throwing on a 404: the message may have been
   * deleted by a human, and a missing original is not a reason to fail the run
   * that was only trying to append a lifetime to it.
   */
  async edit(messageId: string, message: DiscordMessage): Promise<boolean> {
    try {
      await this.#request(
        `${this.#webhookUrl}/messages/${encodeURIComponent(messageId)}`,
        'PATCH',
        message,
      );
      return true;
    } catch (error) {
      if (error instanceof DiscordError && error.status === 404) {
        this.#logger.warn({ messageId }, 'discord message gone; skipping edit');
        return false;
      }
      throw error;
    }
  }

  async #request(url: string, method: 'POST' | 'PATCH', payload: DiscordMessage): Promise<unknown> {
    const serialized = JSON.stringify({
      // Alerts never ping anyone. An @everyone in a market question — and
      // question text is attacker-influenced, since anyone can create a market
      // — would otherwise notify the whole server.
      allowed_mentions: { parse: [] },
      ...payload,
    });

    let attempt = 0;
    let lastStatus: number | null = null;
    let lastBody = '';
    let lastError: unknown = null;

    for (;;) {
      await this.#bucket.take();

      let response: Response | null = null;
      let retryAfterMs: number | null = null;

      try {
        response = await this.#fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: serialized,
          signal: attemptSignal(undefined, this.#timeoutMs),
        });
      } catch (error) {
        lastError = error;
        lastStatus = null;
      }

      if (response !== null) {
        const text = await response.text();

        if (response.ok) {
          try {
            return text === '' ? null : JSON.parse(text);
          } catch {
            return null;
          }
        }

        lastStatus = response.status;
        lastBody = truncate(text, 400);

        if (response.status === 429) {
          // Body wins when present: seconds as a float, finer than the header's
          // integer, and rounding down here is how you get a second 429.
          let bodySeconds: number | null = null;
          try {
            const parsed = JSON.parse(text) as { retry_after?: unknown };
            if (typeof parsed.retry_after === 'number' && Number.isFinite(parsed.retry_after)) {
              bodySeconds = parsed.retry_after;
            }
          } catch {
            bodySeconds = null;
          }
          const headerMs = parseRetryAfter(response.headers.get('retry-after'));
          retryAfterMs = Math.max(bodySeconds === null ? 0 : Math.ceil(bodySeconds * 1000), headerMs ?? 0);
          if (retryAfterMs === 0) retryAfterMs = null;
        } else if (response.status < 500) {
          // 400/401/404 are our bug or a revoked webhook. Retrying spends the
          // budget to be told the same thing.
          throw new DiscordError(`discord ${response.status}`, response.status, lastBody);
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
        { status: lastStatus, attempt: attempt + 1, waitMs, error: lastError === null ? null : describeError(lastError) },
        'discord request failed, retrying',
      );
      await this.#sleep(waitMs);
      attempt += 1;
    }

    throw new DiscordError(
      lastStatus === null
        ? `discord unreachable after ${attempt + 1} attempts: ${describeError(lastError)}`
        : `discord ${lastStatus} after ${attempt + 1} attempts`,
      lastStatus,
      lastBody,
    );
  }
}

/**
 * A transport that logs instead of posting.
 *
 * The default when no webhook is configured, so the whole alert pipeline —
 * thresholds, dedup, escalation, resolution — runs and is observable in
 * development without a Discord server. Silently doing nothing would make the
 * dedup logic untestable in exactly the environment where it is being written.
 */
export class LoggingTransport implements AlertTransport {
  #counter = 0;
  readonly sent: DiscordMessage[] = [];
  readonly edited: Array<{ messageId: string; message: DiscordMessage }> = [];

  send(message: DiscordMessage): Promise<SentMessage | null> {
    this.sent.push(message);
    this.#counter += 1;
    log.info(
      { title: message.embeds?.[0]?.title, content: message.content },
      'alert (no webhook configured, not sent)',
    );
    return Promise.resolve({ id: `local-${this.#counter}` });
  }

  edit(messageId: string, message: DiscordMessage): Promise<boolean> {
    this.edited.push({ messageId, message });
    log.info({ messageId, title: message.embeds?.[0]?.title }, 'alert edit (no webhook configured)');
    return Promise.resolve(true);
  }
}
