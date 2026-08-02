import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { Alerter } from '../alerts/index.js';
import { runCoherenceCheck, type CheckResult, type StagePriceFeed } from '../coherence/check.js';
import { recordViolations, type RecordResult } from '../coherence/violations-store.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import {
  coherenceDuration,
  coherenceRuns,
  constraintsEvaluated,
  violationsConfirmed,
  violationsOpen,
  violationsScreened,
} from '../metrics.js';
import { redis } from '../redis.js';
import { withLock } from './lock.js';

/**
 * Scheduling for the coherence check.
 *
 * A separate queue, worker, and lock from the catalog ingest, on purpose. They
 * run at wildly different cadences — 60 seconds against 10 minutes — and share
 * nothing but the database. Putting them on one queue would let a 20-minute
 * catalog crawl block sixty consecutive coherence checks behind it, which is
 * exactly the window a short-lived violation lives and dies in.
 *
 * The same three-layer exclusion as the ingest: worker concurrency, a BullMQ
 * scheduler, and a Redis lock that actually holds across replicas. The lock
 * matters more here than there. At a 60-second interval a check that takes 70
 * seconds would otherwise overlap itself, and two concurrent checkers racing on
 * the same violation episode is precisely what the partial unique index on
 * `violations` exists to prevent — better not to rely on it.
 */

const log = createLogger('coherence-queue');

export const COHERENCE_QUEUE_NAME = 'coherence-check';
export const COHERENCE_DLQ_NAME = 'coherence-check-dlq';

const SCHEDULER_ID = 'coherence-check-repeatable';
const JOB_NAME = 'check-coherence';

const LOCK_KEY = 'dutchbook:coherence:lock';
const LAST_SUCCESS_KEY = 'dutchbook:coherence:last-success';
const LAST_FAILURE_KEY = 'dutchbook:coherence:last-failure';

const KEEP_COMPLETED = { count: 100 } as const;
const KEEP_FAILED = { count: 200 } as const;

export interface CoherenceJobResult {
  readonly ran: boolean;
  readonly screened?: number;
  readonly confirmed?: number;
  readonly apparent?: number;
}

export interface CoherenceJobsOptions {
  connection?: Redis;
  /** The work itself. Injected by tests. */
  run?: (signal: AbortSignal) => Promise<CheckResult>;
  /**
   * Live books for stage 1, resolved per run rather than captured once.
   *
   * A getter because the feed and this queue are mutually dependent — the feed
   * queues checks, the checks read the feed — and one of the two has to be
   * constructed first. Resolving at job time rather than at wiring time breaks
   * that without a placeholder object.
   *
   * It matters that this is wired at all: a check triggered by the feed but
   * screening on cached Gamma quotes can re-screen the very constraint that
   * caused the trigger and conclude nothing is wrong, because the quote has not
   * caught up yet. The trigger would then be work that reliably finds nothing.
   */
  feed?: () => StagePriceFeed | undefined;
  /** Persistence. Injected by tests; defaults to writing episodes to Postgres. */
  persist?: (result: CheckResult) => Promise<RecordResult>;
  /** Alerting. Injected by tests; defaults to the Discord-or-log alerter. */
  alerter?: Alerter;
  announce?: (result: CheckResult) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  lockTtlMs?: number;
  concurrency?: number;
  prefix?: string;
  schedule?: boolean;
}

export interface CoherenceJobs {
  readonly connection: Redis;
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;
  readonly worker: Worker;
  trigger(reason: string): Promise<Job>;
  close(drainTimeoutMs?: number): Promise<void>;
}

function jobOptions(attempts: number, backoffMs: number) {
  return {
    attempts,
    backoff: { type: 'exponential' as const, delay: backoffMs },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  };
}

/**
 * One check: screen, confirm, persist, close what stopped violating.
 *
 * The `stillViolating` set is built from the screen rather than from stage 2,
 * and that is deliberate. A constraint still violated on Gamma but rejected by
 * stage 2 has not stopped violating — it has stopped being *profitable*, which
 * is a different fact and belongs in `reason`, not in `resolved_at`. Closing an
 * episode because the trade got too thin would make lifetimes measure liquidity
 * rather than mispricing.
 */
export async function runCoherenceJob(
  connection: Redis,
  job: Job,
  options: {
    timeoutMs: number;
    lockTtlMs: number;
    run: (signal: AbortSignal) => Promise<CheckResult>;
    /** Injected so the schedule can be tested without a database. */
    persist: (result: CheckResult) => Promise<RecordResult>;
    /**
     * Alerting. Runs *after* persistence, never before: an alert names a
     * violation episode by its database id, and the id does not exist until the
     * episode is written. It is also allowed to fail without failing the check —
     * a broken webhook must not stop the checker from checking.
     */
    announce?: (result: CheckResult) => Promise<void>;
  },
): Promise<CoherenceJobResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('coherence check timed out')), options.timeoutMs);
  timer.unref();

  const started = Date.now();

  try {
    const outcome = await withLock(
      connection,
      LOCK_KEY,
      { ttlMs: options.lockTtlMs },
      async (lockSignal) => {
        // Either the deadline or a lost lock stops the check; both must reach
        // the HTTP clients, not just the loop between stages.
        const signal = AbortSignal.any([controller.signal, lockSignal]);
        return options.run(signal);
      },
    );

    if (!outcome.ran) {
      log.info({ jobId: job.id }, 'coherence check skipped: another run holds the lock');
      coherenceRuns.inc({ result: 'skipped' });
      return { ran: false };
    }

    const result = outcome.result;

    const recorded = await options.persist(result);

    if (options.announce !== undefined) {
      try {
        await options.announce(result);
      } catch (error) {
        log.error({ error: describeError(error) }, 'alerting failed; the check itself succeeded');
      }
    }

    coherenceRuns.inc({ result: 'success' });
    coherenceDuration.observe((Date.now() - started) / 1000);
    constraintsEvaluated.set(result.screened.evaluated);
    violationsScreened.set(result.screened.violated);
    // Only newly-opened and newly-upgraded episodes count: re-observing the
    // same violation every 60s would otherwise inflate this by the run rate.
    violationsConfirmed.inc({}, recorded.opened + recorded.upgraded);
    violationsOpen.set(result.confirmations.filter((c) => c.status === 'confirmed').length);

    log.info(
      {
        jobId: job.id,
        evaluated: result.screened.evaluated,
        screened: result.screened.violated,
        confirmed: result.confirmed,
        apparent: result.apparent,
        books: result.booksFetched,
        ...recorded,
        durationMs: Date.now() - started,
      },
      'coherence check complete',
    );

    return {
      ran: true,
      screened: result.screened.violated,
      confirmed: result.confirmed,
      apparent: result.apparent,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function startCoherenceJobs(
  options: CoherenceJobsOptions = {},
): Promise<CoherenceJobs> {
  const intervalMs = options.intervalMs ?? config.COHERENCE_CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? config.COHERENCE_CHECK_TIMEOUT_MS;
  const attempts = options.attempts ?? 2;
  const backoffMs = options.backoffMs ?? 5_000;
  const lockTtlMs = options.lockTtlMs ?? config.COHERENCE_CHECK_LOCK_TTL_MS;
  const concurrency = options.concurrency ?? 1;

  const run =
    options.run ??
    ((signal: AbortSignal) => {
      const feed = options.feed?.();
      return runCoherenceCheck(db, {
        signal,
        epsilon: config.COHERENCE_EPSILON,
        maxConfirmations: config.COHERENCE_MAX_CONFIRMATIONS,
        ...(feed === undefined ? {} : { feed }),
      });
    });

  /**
   * `stillViolating` comes from the screen, not from stage 2. A constraint that
   * is still violated but no longer profitable has not stopped violating — it
   * has stopped being *worth taking*, which belongs in `reason`, not in
   * `resolved_at`. Closing on profitability would make lifetimes measure
   * liquidity rather than mispricing.
   */
  const persist =
    options.persist ??
    (async (result: CheckResult) =>
      recordViolations(
        result.confirmations,
        new Set(result.confirmations.map((c) => c.constraint.key)),
        db,
      ));

  const alerter = options.alerter ?? new Alerter();
  const announce =
    options.announce ??
    (async (result: CheckResult) => {
      await alerter.afterCheck(result);
      // Safe on every tick: the hour bucket is the dedup key, so only the first
      // call in each hour sends anything.
      await alerter.digest();
    });

  const owned = options.connection === undefined;
  const connection = options.connection ?? redis.duplicate();

  const shared = { connection, ...(options.prefix === undefined ? {} : { prefix: options.prefix }) };

  const queue = new Queue(COHERENCE_QUEUE_NAME, {
    ...shared,
    defaultJobOptions: jobOptions(attempts, backoffMs),
  });
  const deadLetterQueue = new Queue(COHERENCE_DLQ_NAME, {
    ...shared,
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });

  const worker = new Worker(
    COHERENCE_QUEUE_NAME,
    async (job) => runCoherenceJob(connection, job, { timeoutMs, lockTtlMs, run, persist, announce }),
    {
      ...shared,
      concurrency,
      // Much shorter than the ingest worker's 30s: at a 60-second cadence a
      // long blocking read would delay the next check by a meaningful fraction
      // of its own interval.
      drainDelay: 5,
    },
  );

  worker.on('completed', (_job, result: CoherenceJobResult) => {
    if (result?.ran !== true) return;
    void connection.set(LAST_SUCCESS_KEY, new Date().toISOString());
  });

  worker.on('failed', (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const allowed = job?.opts.attempts ?? attempts;
    const exhausted = attemptsMade >= allowed;

    coherenceRuns.inc({ result: 'failure' });
    log.warn(
      { jobId: job?.id, attemptsMade, allowed, exhausted, error: describeError(error) },
      exhausted ? 'coherence check failed for the last time' : 'coherence check failed, retrying',
    );

    if (!exhausted) return;

    void connection.set(
      LAST_FAILURE_KEY,
      JSON.stringify({ at: new Date().toISOString(), error: describeError(error) }),
    );

    void deadLetterQueue
      .add(
        JOB_NAME,
        {
          jobId: job?.id ?? null,
          attemptsMade,
          failedAt: new Date().toISOString(),
          error: describeError(error),
        },
        { removeOnComplete: false, removeOnFail: false },
      )
      .catch((err: unknown) => {
        log.error({ error: describeError(err) }, 'could not dead-letter a failed coherence job');
      });
  });

  worker.on('error', (error) => {
    log.error({ error: describeError(error) }, 'coherence worker error');
  });

  if (options.schedule ?? true) {
    await queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: intervalMs },
      { name: JOB_NAME, opts: jobOptions(attempts, backoffMs) },
    );
    log.info({ intervalMs, timeoutMs, concurrency }, 'coherence check scheduled');
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
      const drained = await Promise.race([
        worker.close().then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), drainTimeoutMs);
          timer.unref();
        }),
      ]);

      if (!drained) {
        log.warn({ drainTimeoutMs }, 'coherence worker did not drain in time; forcing close');
        await worker.close(true);
      }

      await queue.close();
      await deadLetterQueue.close();
      if (owned) connection.disconnect();
    },
  };
}
