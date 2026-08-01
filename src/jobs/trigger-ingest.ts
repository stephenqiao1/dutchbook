import { Queue, QueueEvents } from 'bullmq';

import { config } from '../config.js';
import { closeDatabase } from '../db/client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { closeRedis, redis } from '../redis.js';
import { CATALOG_QUEUE_NAME } from './catalog-queue.js';
import { ingestCatalog } from './ingest-catalog.js';

/**
 * `pnpm job:ingest` — run the catalog ingest on demand.
 *
 * Two modes, because "trigger a run" means different things depending on
 * whether the service is deployed:
 *
 *   pnpm job:ingest            enqueue a job and wait for a worker to run it
 *   pnpm job:ingest --inline   run it here, in this process
 *
 * Enqueuing is the default because it goes through the same lock, retries, and
 * dead-lettering as a scheduled run — what you want against a live deployment.
 * `--inline` is for a laptop with no worker running; it still takes the lock,
 * so it cannot collide with a deployed crawl.
 */

const log = createLogger('job:ingest');

/** How long to wait for some worker to pick the job up before giving up. */
const PICKUP_TIMEOUT_MS = 30_000;

async function runInline(): Promise<number> {
  log.info('running the catalog ingest in this process');
  const summary = await ingestCatalog({ gamma: { baseUrl: config.GAMMA_BASE_URL } });
  return summary.complete ? 0 : 1;
}

async function runQueued(): Promise<number> {
  // A Queue, not `startCatalogJobs` — this process enqueues and watches; it
  // must not spin up a worker that would race the deployed one, nor install or
  // reset the repeatable schedule as a side effect of a manual trigger.
  const queue = new Queue(CATALOG_QUEUE_NAME, { connection: redis.duplicate() });
  const queueEvents = new QueueEvents(CATALOG_QUEUE_NAME, { connection: redis.duplicate() });

  try {
    await queueEvents.waitUntilReady();
    const job = await queue.add(
      'ingest-catalog',
      { reason: 'manual: pnpm job:ingest', triggeredAt: new Date().toISOString() },
      {
        attempts: config.CATALOG_INGEST_ATTEMPTS,
        backoff: { type: 'exponential', delay: config.CATALOG_INGEST_BACKOFF_MS },
      },
    );
    log.info({ jobId: job.id }, 'enqueued a catalog ingest');

    type Outcome = { kind: 'done'; result: unknown } | { kind: 'timeout' };

    const outcome = await Promise.race<Outcome>([
      job.waitUntilFinished(queueEvents).then((result: unknown) => ({ kind: 'done', result })),
      new Promise<Outcome>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), PICKUP_TIMEOUT_MS).unref();
      }),
    ]);

    if (outcome.kind === 'timeout') {
      log.warn(
        { jobId: job.id, pickupTimeoutMs: PICKUP_TIMEOUT_MS },
        'job is queued but no worker finished it — is one running? ' +
          'Use --inline to run it here instead. The job stays queued.',
      );
      return 1;
    }

    log.info({ jobId: job.id, result: outcome.result }, 'catalog ingest finished');
    return 0;
  } finally {
    await Promise.allSettled([queueEvents.close(), queue.close()]);
  }
}

const inline = process.argv.includes('--inline');
let code = 1;

try {
  code = inline ? await runInline() : await runQueued();
} catch (error) {
  log.error({ error: describeError(error) }, 'catalog ingest failed');
  code = 1;
} finally {
  await Promise.allSettled([closeDatabase(), closeRedis()]);
}

process.exit(code);
