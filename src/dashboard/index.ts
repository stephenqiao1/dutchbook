import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import { describeError } from '../errors.js';
import type { CatalogJobStats } from '../jobs/catalog-queue.js';
import { CSS } from './css.js';
import { html } from './html.js';
import { JS } from './js.js';
import {
  MAX_RELATION_ROWS,
  MAX_VIOLATION_ROWS,
  readFamilies,
  readFamily,
  readLifetimes,
  readRelations,
  readStatus,
  readViolations,
  type StatusPayload,
} from './queries.js';

/**
 * The dashboard: a separate route tree, mounted as a plugin.
 *
 * Separate on purpose. `/health` and `/metrics` are contracts with the
 * orchestrator and the scrape pipeline; these routes are a public web page. They
 * have different audiences, different failure modes, and — importantly —
 * different appetite for load, so keeping them in one plugin means the caching
 * and the CORS policy live in one place and cannot leak onto the health check.
 *
 * Two things this must survive, given there is no authentication in front of it:
 *
 * - **Someone holding down refresh.** Every read is memoised with a short TTL,
 *   so request rate and database load are decoupled. Postgres sees at most one
 *   query per endpoint per TTL no matter how many people are looking.
 * - **Postgres being unreachable.** A failed panel returns 503 with a message
 *   the page can render, rather than an unhandled rejection that takes the
 *   process down.
 */

export interface DashboardOptions {
  /** Injected by tests. Defaults to the shared Drizzle client. */
  database?: typeof db;
  /** Ingest freshness for the status page. */
  jobStats?: () => Promise<CatalogJobStats>;
  version?: string;
  /** Memoisation window. Zero disables it, which is what the tests want. */
  cacheTtlMs?: number;
}

/**
 * Stale-while-revalidate, with single-flight.
 *
 * A plain TTL cache is not enough here, and production proved it: the status
 * query is a filtered aggregate over ~300k markets with no index on `closed`,
 * and on Fly's shared CPU it took between 6 and 25 seconds. With a 10-second
 * TTL and a page that loads slower than the TTL, *every* request was a miss —
 * the cache was pure overhead and every visitor waited on Postgres.
 *
 * So a stale value is served immediately and the refresh happens behind it.
 * Only a genuinely cold cache waits. The trade is that the page can show data
 * older than the TTL when the database is struggling, which is why the payload
 * carries `generatedAt` and the page renders it: stale is fine, silently stale
 * is not.
 *
 * Single-flight matters as much: ten simultaneous cold requests share one query
 * rather than starting ten.
 */
function memo<T>(ttlMs: number, fn: () => Promise<T>): { get: () => Promise<T>; prime: () => void } {
  let cached: { value: T } | null = null;
  let expires = 0;
  let inflight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    inflight ??= fn().then(
      (value) => {
        cached = { value };
        expires = Date.now() + ttlMs;
        inflight = null;
        return value;
      },
      (error: unknown) => {
        // Not cached: one blip must not blind the page for a whole TTL.
        inflight = null;
        throw error;
      },
    );
    return inflight;
  };

  return {
    get: async () => {
      if (cached === null) return refresh();
      // Refresh behind the response; a failure here is not the caller's problem
      // because the caller already has an answer.
      if (Date.now() >= expires) void refresh().catch(() => undefined);
      return cached.value;
    },
    prime: () => void refresh().catch(() => undefined),
  };
}

const assetTag = (body: string): string =>
  createHash('sha256').update(body).digest('hex').slice(0, 12);

const CSS_TAG = assetTag(CSS);
const JS_TAG = assetTag(JS);
/** One tag for the pair, so a change to either busts the cached HTML. */
const ASSET_TAG = assetTag(CSS_TAG + JS_TAG);

const gzipAsync = promisify(gzip);

/** Below this, the header overhead is most of what you would save. */
const COMPRESS_OVER_BYTES = 1_024;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

export const dashboard: FastifyPluginAsync<DashboardOptions> = async (
  app: FastifyInstance,
  options: DashboardOptions,
) => {
  const database = options.database ?? db;
  const version = options.version ?? '0.0.0';
  // Thirty seconds, not ten. With stale-while-revalidate the TTL sets how often
  // the database is asked, not how long anyone waits, and the status aggregate
  // is expensive enough that asking every ten seconds is a background load this
  // instance does not need to carry.
  const ttl = options.cacheTtlMs ?? 30_000;

  const primers: (() => void)[] = [];

  const withTtl = <T>(fn: () => Promise<T>, multiplier = 1): (() => Promise<T>) => {
    if (ttl <= 0) return fn;
    const cache = memo(ttl * multiplier, fn);
    primers.push(cache.prime);
    return cache.get;
  };

  const statusCache = withTtl(async (): Promise<StatusPayload & { ingest: unknown }> => {
    const [status, ingest] = await Promise.all([
      readStatus(database),
      // Ingest state lives in Redis, not Postgres. It is allowed to be missing
      // without taking the rest of the page with it.
      options.jobStats?.().catch((error: unknown) => ({ error: describeError(error) })) ??
        Promise.resolve(null),
    ]);
    return { ...status, ingest };
  });

  const lifetimeCache = withTtl(() => readLifetimes(database));
  const familyListCache = withTtl(() => readFamilies(database), 6);
  // Longer: 500 rows joined against `markets` is the heaviest read here, and
  // history by definition changes slowly.
  const violationsCache = withTtl(() => readViolations(database, {}), 4);

  /**
   * Fill the caches at boot so the first visitor is not the one who pays for
   * the cold query. Deliberately not awaited — a slow or unreachable database
   * must delay nothing, least of all readiness.
   */
  app.addHook('onReady', async () => {
    for (const prime of primers) prime();
  });

  /**
   * Compression, hand-rolled rather than pulled in as a plugin.
   *
   * The violation feed is ~276KB of JSON for 500 episodes, and this is meant to
   * be legible on a phone — over mobile data that is worth about ten times its
   * gzipped size. Node ships the compressor; the whole policy is four
   * conditions, so a dependency for it would be more surface than substance.
   *
   * `vary` matters: without it a shared cache can hand a gzipped body to a
   * client that did not ask for one.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string' || payload.length < COMPRESS_OVER_BYTES) return payload;
    if (!/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) return payload;
    if (reply.getHeader('content-encoding') !== undefined) return payload;

    const compressed = await gzipAsync(payload);
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'accept-encoding');
    // Fastify recomputes it from the buffer; a stale value here is a truncated
    // response in the browser.
    reply.removeHeader('content-length');
    return compressed;
  });

  /**
   * Anyone may read this from anywhere.
   *
   * The whole point of publishing the JSON is that someone else can build on
   * it, and a browser cannot fetch cross-origin without this. It is safe here
   * precisely because there is nothing to authorise: no cookies, no auth, and
   * every route is a read.
   */
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-methods', 'GET, OPTIONS');
      // Shared caches may serve this; it is public data by construction.
      reply.header('cache-control', 'public, max-age=10');
    }
  });

  // ---- the page ------------------------------------------------------------

  const page = html(version, ASSET_TAG);

  app.get('/', async (_request, reply) =>
    reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      // The document is tiny and references hashed assets; keeping it fresh is
      // what makes a redeploy visible without a hard refresh.
      .header('cache-control', 'no-cache')
      .send(page),
  );

  app.get('/app.css', async (_request, reply) =>
    reply
      .code(200)
      .header('content-type', 'text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', `"${CSS_TAG}"`)
      .send(CSS),
  );

  app.get('/app.js', async (_request, reply) =>
    reply
      .code(200)
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', `"${JS_TAG}"`)
      .send(JS),
  );

  // ---- JSON ----------------------------------------------------------------

  app.get('/api/status', async (_request, reply) => reply.send(await statusCache()));

  app.get('/api/lifetimes', async (_request, reply) => reply.send(await lifetimeCache()));

  /**
   * Public: the violation record.
   *
   * `limit` is clamped rather than rejected — a caller asking for 10,000 gets
   * 500 and a `limit` field telling them what they actually got, which is more
   * useful than a 400 for a read-only feed.
   */
  app.get('/api/violations', async (request, reply) => {
    const query = request.query as { limit?: string; status?: string };
    const limit = positiveInt(query.limit, MAX_VIOLATION_ROWS, MAX_VIOLATION_ROWS);
    const status = ['open', 'closed', 'confirmed', 'apparent'].includes(query.status ?? '')
      ? (query.status as 'open' | 'closed' | 'confirmed' | 'apparent')
      : 'all';

    // The default shape is the cached one; anything filtered goes to the
    // database, which is why the filters are a fixed enum rather than free text.
    const data =
      status === 'all' && limit === MAX_VIOLATION_ROWS
        ? await violationsCache()
        : await readViolations(database, { limit, status });

    return reply.send({ limit, status, total: data.total, violations: data.violations });
  });

  /** Public: the relation graph. */
  app.get('/api/relations', async (request, reply) => {
    const query = request.query as { limit?: string; source?: string; type?: string };
    const data = await readRelations(database, {
      limit: positiveInt(query.limit, 200, MAX_RELATION_ROWS),
      ...(typeof query.source === 'string' && query.source !== '' ? { source: query.source } : {}),
      ...(typeof query.type === 'string' && query.type !== '' ? { type: query.type } : {}),
    });
    return reply.send(data);
  });

  app.get('/api/families', async (_request, reply) =>
    reply.send({ families: await familyListCache() }),
  );

  app.get('/api/families/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const family = await readFamily(key, database);
    if (family === null) return reply.code(404).send({ error: 'no such family', key });
    return reply.send(family);
  });

  /**
   * Any database failure below this point is a 503 with a readable message.
   *
   * Without it a dropped connection surfaces as a 500 whose body is a stack
   * trace — on a public page, that is both unhelpful and more than anyone
   * outside needs to know about the schema.
   */
  app.setErrorHandler(async (error: unknown, request, reply) => {
    request.log.warn({ err: error, url: request.url }, 'dashboard request failed');

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const clientError = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
    const code = clientError ? statusCode : 503;

    return reply.code(code).send(
      clientError
        ? { error: describeError(error) }
        : { error: 'data unavailable', detail: 'the database did not answer in time' },
    );
  });
};
