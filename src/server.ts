import { readFileSync } from 'node:fs';

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { config } from './config.js';
import { dashboard } from './dashboard/index.js';
import { countCatalog, pingDatabase } from './db/client.js';
import { catalogJobStats, type CatalogJobStats } from './jobs/catalog-queue.js';
import { describeError } from './errors.js';
import { logger } from './logger.js';
import {
  METRICS_CONTENT_TYPE,
  apiRequests,
  buildInfo,
  lastIngestSuccess,
  marketsMissing,
  marketsTracked,
  renderMetrics,
  revisionsTotal,
  type MetricsCollector,
} from './metrics.js';
import { pingRedis } from './redis.js';

/** Resolves to the repo root from both `src/` (tsx) and `dist/` (built). */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: string };

export const version: string = pkg.version ?? '0.0.0';

/** A dependency probe: resolves if healthy, rejects otherwise. */
export type HealthProbe = () => Promise<void>;

export interface BuildServerOptions {
  /** Override the dependency probes. Tests inject fakes here. */
  probes?: {
    postgres: HealthProbe;
    redis: HealthProbe;
  };
  /** Per-probe deadline. Defaults to `HEALTHCHECK_TIMEOUT_MS`. */
  healthcheckTimeoutMs?: number;
  /** Job metrics source. Defaults to reading the catalog queue. */
  jobStats?: () => Promise<CatalogJobStats>;
  /** Refreshes scrape-time gauges. Defaults to querying Postgres and Redis. */
  metricsCollector?: MetricsCollector;
  /** Mount the public dashboard. Default true. */
  dashboard?: boolean;
}

type ProbeResult = { ok: true } | { ok: false; error: string };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} probe timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function runProbe(label: string, probe: HealthProbe, ms: number): Promise<ProbeResult> {
  try {
    await withTimeout(probe(), ms, label);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Job metrics for the health payload.
 *
 * Reported but never allowed to change `status`: a failed ingest is an
 * operational problem, not an unhealthy process, and letting it flip the
 * readiness probe would have an orchestrator restart a pod that is serving
 * traffic perfectly well. Alert on `lastSuccessAt` going stale instead.
 */
async function readJobStats(
  stats: () => Promise<CatalogJobStats>,
  ms: number,
): Promise<CatalogJobStats | { error: string }> {
  try {
    return await withTimeout(stats(), ms, 'jobs');
  } catch (err) {
    return { error: describeError(err) };
  }
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const probes = options.probes ?? { postgres: pingDatabase, redis: pingRedis };
  const timeoutMs = options.healthcheckTimeoutMs ?? config.HEALTHCHECK_TIMEOUT_MS;
  const stats = options.jobStats ?? ((): Promise<CatalogJobStats> => catalogJobStats());
  const collectMetrics = options.metricsCollector ?? defaultMetricsCollector(stats);

  // Widened deliberately: handing Fastify the concrete pino type would bind its
  // logger generic to it and make `FastifyInstance` unassignable everywhere else.
  const fastifyLogger: FastifyBaseLogger = logger;

  const app = Fastify({
    loggerInstance: fastifyLogger,
    trustProxy: true,
    // Health checks must not be starved by a slow probe holding the socket.
    requestTimeout: 30_000,
  });

  app.get('/health', async (request, reply) => {
    const [postgres, redis, jobs] = await Promise.all([
      runProbe('postgres', probes.postgres, timeoutMs),
      runProbe('redis', probes.redis, timeoutMs),
      readJobStats(stats, timeoutMs),
    ]);

    const uptimeSeconds = Math.round(process.uptime());

    if (postgres.ok && redis.ok) {
      return reply.code(200).send({ status: 'ok', uptimeSeconds, version, jobs });
    }

    const checks = {
      postgres: postgres.ok ? 'ok' : postgres.error,
      redis: redis.ok ? 'ok' : redis.error,
    };
    request.log.warn({ checks }, 'health check failed');

    return reply.code(503).send({ status: 'degraded', uptimeSeconds, version, checks, jobs });
  });

  /**
   * Prometheus scrape endpoint.
   *
   * Not logged: a scrape every 15s would otherwise dominate the log, and it
   * carries no information a failed scrape would not already show.
   */
  app.get('/metrics', { logLevel: 'silent' }, async (_request, reply) => {
    const body = await renderMetrics(collectMetrics);
    return reply.code(200).header('content-type', METRICS_CONTENT_TYPE).send(body);
  });

  // The public dashboard, as its own route tree. Registered last so its error
  // handler is scoped to the plugin and cannot swallow a health-check failure —
  // `/health` must keep returning its own 503 shape for the orchestrator.
  if (options.dashboard !== false) {
    void app.register(dashboard, { jobStats: stats, version });
  }

  // Counted here rather than per route: `url` would be unbounded cardinality
  // once ids appear in paths, and the status code is what alerts fire on.
  app.addHook('onResponse', async (request, reply) => {
    apiRequests.inc({ method: request.method, status: reply.statusCode });
  });

  return app;
}

/**
 * The gauges that live outside this process.
 *
 * Each source is read independently and a failure clears only its own gauges:
 * a scrape that reports HTTP metrics while Postgres is unreachable is more
 * useful than one that returns 500 and reports nothing.
 */
function defaultMetricsCollector(stats: () => Promise<CatalogJobStats>): MetricsCollector {
  return async () => {
    buildInfo.set(1, { version, node_env: config.NODE_ENV });

    try {
      const counts = await countCatalog();
      marketsTracked.set(counts.tracked);
      marketsMissing.set(counts.missing);
      revisionsTotal.set(counts.revisions);
    } catch (err) {
      logger.debug({ err }, 'metrics: could not read catalog counts');
      marketsTracked.clear();
      marketsMissing.clear();
      revisionsTotal.clear();
    }

    try {
      const { lastSuccessAt } = await stats();
      if (lastSuccessAt === null) lastIngestSuccess.clear();
      else lastIngestSuccess.set(Date.parse(lastSuccessAt) / 1_000);
    } catch (err) {
      logger.debug({ err }, 'metrics: could not read job state');
      lastIngestSuccess.clear();
    }
  };
}

/** Builds the app and binds the socket. */
export async function start(): Promise<FastifyInstance> {
  const app = buildServer();
  await app.listen({ host: config.HOST, port: config.PORT });
  return app;
}
