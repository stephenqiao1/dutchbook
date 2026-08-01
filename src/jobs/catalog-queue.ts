import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { config } from '../config.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { redis } from '../redis.js';
import { ingestCatalog, type IngestSummary } from './ingest-catalog.js';
import { withLock } from './lock.js';

/**
 * Scheduling for the catalog ingest.
 *
 * Three layers keep two crawls from ever overlapping:
 *
 * 1. `concurrency: 1` — one job at a time within a worker.
 * 2. A BullMQ job scheduler — one *scheduled* job per interval, cluster-wide.
 * 3. A Redis lock — the backstop that actually holds across replicas, and the
 *    only one that helps when a run outlasts its own 10-minute interval.
 *
 * Layers 1 and 2 are optimisations. Layer 3 is the guarantee.
 */

const log = createLogger('catalog-queue');

export const CATALOG_QUEUE_NAME = 'catalog-ingest';
export const CATALOG_DLQ_NAME = 'catalog-ingest-dlq';

const SCHEDULER_ID = 'catalog-ingest-repeatable';
const JOB_NAME = 'ingest-catalog';

/** Redis keys. Shared state, so every replica reports the same health. */
const LOCK_KEY = 'dutchbook:catalog:lock';
const LAST_SUCCESS_KEY = 'dutchbook:catalog:last-success';
const LAST_FAILURE_KEY = 'dutchbook:catalog:last-failure';

/** Retained so `/health` and an operator can see recent history. */
const KEEP_COMPLETED = { count: 50 } as const;
const KEEP_FAILED = { count: 200 } as const;

export interface CatalogJobResult {
  /** False when another replica already held the lock; not a failure. */
  readonly ran: boolean;
  readonly summary?: IngestSummary;
}

export interface CatalogJobsOptions {
  /** Worker connection. Defaults to a duplicate of the shared client. */
  connection?: Redis;
  /** The work itself. Injected by tests; defaults to the real ingest. */
  run?: (signal: AbortSignal) => Promise<IngestSummary>;
  intervalMs?: number;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  lockTtlMs?: number;
  concurrency?: number;
  /** BullMQ key prefix. Tests use a unique one for isolation. */
  prefix?: string;
  /** Register the repeatable schedule. False leaves the queue manual-only. */
  schedule?: boolean;
}

export interface CatalogJobs {
  /** The worker's own connection — also where the run markers live. */
  readonly connection: Redis;
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;
  readonly worker: Worker;
  /** Enqueues one run now, outside the schedule. */
  trigger(reason: string): Promise<Job>;
  /** Waits for an in-flight job, then releases everything. */
  close(drainTimeoutMs?: number): Promise<void>;
}

export interface CatalogJobStats {
  readonly queue: {
    readonly waiting: number;
    readonly active: number;
    readonly delayed: number;
    readonly failed: number;
    readonly completed: number;
  };
  readonly deadLettered: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailure: { readonly at: string; readonly error: string } | null;
}

function jobOptions(attempts: number, backoffMs: number): JobsOptions {
  return {
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  };
}

/**
 * Runs one ingest under the distributed lock, bounded by a deadline.
 *
 * A job that finds the lock held returns `{ ran: false }` and completes. That
 * is the correct outcome, not an error: the catalog is being crawled right now
 * by someone, and retrying would only queue up behind them.
 */
async function runCatalogJob(
  connection: Redis,
  job: Job,
  options: Required<Pick<CatalogJobsOptions, 'timeoutMs' | 'lockTtlMs'>> & {
    run: (signal: AbortSignal) => Promise<IngestSummary>;
  },
): Promise<CatalogJobResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`catalog ingest exceeded ${options.timeoutMs}ms`));
  }, options.timeoutMs);

  try {
    const outcome = await withLock(
      connection,
      LOCK_KEY,
      { ttlMs: options.lockTtlMs },
      async (lockSignal) => {
        // Either the deadline or a lost lock stops the run; both must reach
        // the HTTP client, not just the loop between events.
        const signal = AbortSignal.any([deadline.signal, lockSignal]);
        return options.run(signal);
      },
    );

    if (!outcome.ran) {
      log.info({ jobId: job.id }, 'catalog ingest skipped: another run holds the lock');
      return { ran: false };
    }

    return { ran: true, summary: outcome.result };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the worker and registers the repeatable schedule.
 *
 * Nothing connects to Redis until this is called, so importing the module stays
 * free for the web-only replicas that never run jobs.
 */
export async function startCatalogJobs(options: CatalogJobsOptions = {}): Promise<CatalogJobs> {
  const intervalMs = options.intervalMs ?? config.CATALOG_INGEST_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? config.CATALOG_INGEST_TIMEOUT_MS;
  const attempts = options.attempts ?? config.CATALOG_INGEST_ATTEMPTS;
  const backoffMs = options.backoffMs ?? config.CATALOG_INGEST_BACKOFF_MS;
  const lockTtlMs = options.lockTtlMs ?? config.CATALOG_INGEST_LOCK_TTL_MS;
  const concurrency = options.concurrency ?? 1;
  const run =
    options.run ??
    ((signal: AbortSignal) =>
      ingestCatalog({ signal, gamma: { baseUrl: config.GAMMA_BASE_URL } }));

  // BullMQ workers issue blocking reads, so they need a connection of their
  // own — sharing the app's would stall every other command behind BRPOPLPUSH.
  const owned = options.connection === undefined;
  const connection = options.connection ?? redis.duplicate();

  const shared = { connection, ...(options.prefix === undefined ? {} : { prefix: options.prefix }) };

  const queue = new Queue(CATALOG_QUEUE_NAME, {
    ...shared,
    defaultJobOptions: jobOptions(attempts, backoffMs),
  });
  const deadLetterQueue = new Queue(CATALOG_DLQ_NAME, {
    ...shared,
    // Dead letters are evidence; they are removed by an operator, not by us.
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });

  const worker = new Worker(
    CATALOG_QUEUE_NAME,
    async (job) => runCatalogJob(connection, job, { timeoutMs, lockTtlMs, run }),
    {
      ...shared,
      concurrency,
      // Upstash bills per command and BullMQ idles on a blocking read. The
      // default 5s drain means ~17k commands a day doing nothing; 30s cuts
      // that by six with no effect on a ten-minute schedule.
      drainDelay: 30,
    },
  );

  worker.on('completed', (job, result: CatalogJobResult) => {
    if (result?.ran !== true) return;
    void connection.set(LAST_SUCCESS_KEY, new Date().toISOString());
    log.info(
      { jobId: job.id, markets: result.summary?.markets, revisions: result.summary?.revisions },
      'catalog ingest job completed',
    );
  });

  worker.on('failed', (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const allowed = job?.opts.attempts ?? attempts;
    const exhausted = attemptsMade >= allowed;

    log.warn(
      { jobId: job?.id, attemptsMade, allowed, exhausted, error: describeError(error) },
      exhausted ? 'catalog ingest job failed for the last time' : 'catalog ingest job failed, retrying',
    );

    if (!exhausted) return;

    void connection.set(
      LAST_FAILURE_KEY,
      JSON.stringify({ at: new Date().toISOString(), error: describeError(error) }),
    );

    // Dead letter: keep the payload and the reason where an operator will find
    // them, rather than letting the job age out of the failed set.
    void deadLetterQueue
      .add(
        JOB_NAME,
        {
          jobId: job?.id ?? null,
          name: job?.name ?? JOB_NAME,
          data: job?.data ?? null,
          attemptsMade,
          failedAt: new Date().toISOString(),
          error: describeError(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        { removeOnComplete: false, removeOnFail: false },
      )
      .catch((err: unknown) => {
        log.error({ error: describeError(err) }, 'could not dead-letter a failed catalog job');
      });
  });

  worker.on('error', (error) => {
    log.error({ error: describeError(error) }, 'catalog worker error');
  });

  if (options.schedule ?? true) {
    await queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: intervalMs },
      { name: JOB_NAME, opts: jobOptions(attempts, backoffMs) },
    );
    log.info({ intervalMs, timeoutMs, attempts, concurrency }, 'catalog ingest scheduled');
  }

  return {
    connection,
    queue,
    deadLetterQueue,
    worker,

    async trigger(reason: string) {
      return queue.add(JOB_NAME, { reason, triggeredAt: new Date().toISOString() });
    },

    async close(drainTimeoutMs = config.JOB_DRAIN_TIMEOUT_MS) {
      // `close()` without force waits for the in-flight job to finish.
      const drained = await Promise.race([
        worker.close().then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), drainTimeoutMs);
          timer.unref();
        }),
      ]);

      if (!drained) {
        log.warn(
          { drainTimeoutMs },
          'catalog job still running at drain deadline, returning it to the queue',
        );
        // Forced close releases the job's lock so another replica picks it up,
        // rather than leaving it stalled until BullMQ's stalled-check notices.
        await worker.close(true);
      }

      await Promise.allSettled([queue.close(), deadLetterQueue.close()]);
      if (owned) connection.disconnect();
    },
  };
}

/**
 * Queue depth and last run outcome, for `/health`.
 *
 * Read from Redis rather than process memory so every replica reports the same
 * answer — the instance serving the health check is usually not the one that
 * ran the job.
 */
export async function catalogJobStats(jobs?: CatalogJobs): Promise<CatalogJobStats> {
  const connection = jobs?.connection ?? redis;
  const queue = jobs?.queue ?? new Queue(CATALOG_QUEUE_NAME, { connection });
  const dlq = jobs?.deadLetterQueue ?? new Queue(CATALOG_DLQ_NAME, { connection });
  const ephemeral = jobs === undefined;

  try {
    const [counts, dlqCounts, lastSuccess, lastFailure] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      dlq.getJobCounts('waiting'),
      connection.get(LAST_SUCCESS_KEY),
      connection.get(LAST_FAILURE_KEY),
    ]);

    return {
      queue: {
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        delayed: counts['delayed'] ?? 0,
        failed: counts['failed'] ?? 0,
        completed: counts['completed'] ?? 0,
      },
      deadLettered: dlqCounts['waiting'] ?? 0,
      lastSuccessAt: lastSuccess,
      lastFailure: parseFailure(lastFailure),
    };
  } finally {
    if (ephemeral) await Promise.allSettled([queue.close(), dlq.close()]);
  }
}

function parseFailure(raw: string | null): CatalogJobStats['lastFailure'] {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { at, error } = parsed as { at?: unknown; error?: unknown };
    if (typeof at !== 'string' || typeof error !== 'string') return null;
    return { at, error };
  } catch {
    return null;
  }
}
