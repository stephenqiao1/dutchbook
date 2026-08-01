import type { FastifyInstance } from 'fastify';

import { config } from './config.js';
import { closeDatabase } from './db/client.js';
import { describeError } from './errors.js';
import { startCatalogJobs, type CatalogJobs } from './jobs/catalog-queue.js';
import { startCoherenceJobs, type CoherenceJobs } from './jobs/coherence-queue.js';
import { logger } from './logger.js';
import { closeRedis } from './redis.js';
import { start, version } from './server.js';

let app: FastifyInstance;
let jobs: CatalogJobs | undefined;
let coherence: CoherenceJobs | undefined;

try {
  app = await start();

  // Web-only replicas run with this off, so scaling HTTP does not multiply
  // crawlers. The lock would make that safe anyway, but idle workers competing
  // for a lock they will not get is noise nobody needs.
  if (config.CATALOG_INGEST_ENABLED) {
    jobs = await startCatalogJobs();
  }

  // Independent of the ingest, and independently switchable: the check is
  // cheap enough to keep running while a full catalog crawl is paused.
  if (config.COHERENCE_CHECK_ENABLED) {
    coherence = await startCoherenceJobs();
  }

  logger.info(
    {
      version,
      nodeEnv: config.NODE_ENV,
      catalogIngest: config.CATALOG_INGEST_ENABLED,
      coherenceCheck: config.COHERENCE_CHECK_ENABLED,
    },
    'dutchbook started',
  );
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  // Deliberately not unref'd: this must keep the loop alive so a stuck close
  // reports a timeout and exits non-zero, rather than exiting 0 in silence.
  // The job drain gets its own budget on top — a catalog crawl takes minutes,
  // and killing one mid-batch every deploy would be worse than a slow deploy.
  const runningJobs = jobs !== undefined || coherence !== undefined;
  const budgetMs = config.SHUTDOWN_TIMEOUT_MS + (runningJobs ? config.JOB_DRAIN_TIMEOUT_MS : 0);
  setTimeout(() => {
    logger.error({ timeoutMs: budgetMs }, 'shutdown timed out, forcing exit');
    process.exit(1);
  }, budgetMs);

  try {
    // Stop accepting requests first. Then let the in-flight job finish: it
    // holds the lock and a database transaction, and interrupting it wastes
    // the crawl, where waiting costs only the rest of one batch.
    await app.close();

    if (runningJobs) {
      logger.info({ drainTimeoutMs: config.JOB_DRAIN_TIMEOUT_MS }, 'draining in-flight jobs');
      // Settled, not all: a coherence worker that will not drain must not stop
      // the catalog worker from finishing its transaction.
      const drains = await Promise.allSettled([jobs?.close(), coherence?.close()]);
      for (const drain of drains) {
        if (drain.status === 'rejected') {
          logger.warn({ error: describeError(drain.reason) }, 'job drain did not complete cleanly');
        }
      }
    }

    await Promise.allSettled([closeDatabase(), closeRedis()]);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('SIGTERM');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('SIGTERM');
});
