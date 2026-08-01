import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogJobStats,
  startCatalogJobs,
  type CatalogJobs,
} from '../../src/jobs/catalog-queue.js';
import { LockLostError, acquireLock, withLock } from '../../src/jobs/lock.js';
import type { IngestSummary } from '../../src/jobs/ingest-catalog.js';

/**
 * The scheduling guarantees, against real Redis.
 *
 * "Overlapping runs are impossible even across deployed instances" is a claim
 * about Redis semantics — SET NX, a compare-and-delete release, key expiry. A
 * mock would only assert that the code calls the functions it calls; it could
 * not catch a lock that frees someone else's key, or two workers both entering
 * the critical section.
 */

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const explicitUrl = process.env['TEST_REDIS_URL'];
const canRun = explicitUrl !== undefined || dockerAvailable();

if (!canRun) {
  console.warn(
    '\n  SKIPPED test/jobs/catalog-queue.test.ts — needs Redis.' +
      '\n  Start Docker, or set TEST_REDIS_URL to a throwaway instance.\n',
  );
}

let url: string;
let client: Redis;
let stopContainer: (() => Promise<void>) | undefined;

/** Connections BullMQ can drive: blocking reads need `maxRetriesPerRequest: null`. */
function connect(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

const summary = (): IngestSummary => ({
  runStartedAt: '2026-08-01T00:00:00.000Z',
  durationMs: 5,
  complete: true,
  batches: 1,
  events: { seen: 1 },
  markets: { seen: 1, created: 1, updated: 0, unchanged: 0, skipped: 0 },
  revisions: 0,
  rawPayloads: { archived: 1, duplicate: 0 },
  missing: 0,
  errors: 0,
});

const started: CatalogJobs[] = [];
const opened: Redis[] = [];

/** A worker wired to a fake ingest, isolated from every other test's keys. */
async function startWorker(
  options: Partial<Parameters<typeof startCatalogJobs>[0]> = {},
): Promise<CatalogJobs> {
  const connection = connect();
  opened.push(connection);

  const jobs = await startCatalogJobs({
    connection,
    schedule: false,
    prefix: `{test-${Math.trunc(Date.now() % 1e9)}-${started.length}}`,
    lockTtlMs: 5_000,
    timeoutMs: 5_000,
    attempts: 1,
    backoffMs: 10,
    run: async () => summary(),
    ...options,
  });

  started.push(jobs);
  return jobs;
}

describe.skipIf(!canRun)('catalog scheduling', () => {
  beforeAll(async () => {
    if (explicitUrl !== undefined) {
      url = explicitUrl;
    } else {
      const { GenericContainer } = await import('testcontainers');
      const container = await new GenericContainer('redis:7').withExposedPorts(6379).start();
      url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
      stopContainer = async () => {
        await container.stop();
      };
    }
    client = connect();
  }, 240_000);

  afterEach(async () => {
    await Promise.allSettled(started.map((jobs) => jobs.close(2_000)));
    started.length = 0;
    for (const connection of opened) connection.disconnect();
    opened.length = 0;
    await client.flushall();
  }, 30_000);

  afterAll(async () => {
    client?.disconnect();
    await stopContainer?.();
  }, 60_000);

  describe('the distributed lock', () => {
    it('admits one holder and turns the rest away', async () => {
      const first = await acquireLock(client, 'k', { ttlMs: 5_000 });
      expect(first).not.toBeNull();

      expect(await acquireLock(client, 'k', { ttlMs: 5_000 })).toBeNull();

      await first!.release();
      const second = await acquireLock(client, 'k', { ttlMs: 5_000 });
      expect(second).not.toBeNull();
      await second!.release();
    });

    it('never releases a lock that has moved on', async () => {
      // The holder stalls past its TTL, so the key expires and someone else
      // takes it. A naive DEL here would hand the catalog to two crawlers.
      const stalled = await acquireLock(client, 'k', { ttlMs: 200, renewEveryMs: 60_000 });
      expect(stalled).not.toBeNull();
      await delay(350);

      const next = await acquireLock(client, 'k', { ttlMs: 5_000 });
      expect(next).not.toBeNull();

      await stalled!.release();

      // The new holder still owns it: release compared tokens before deleting.
      expect(await client.get('k')).toBe(next!.token);
      expect(await acquireLock(client, 'k', { ttlMs: 1_000 })).toBeNull();
      await next!.release();
    });

    it('renews itself, so a long run outlives the TTL', async () => {
      const lock = await acquireLock(client, 'k', { ttlMs: 600, renewEveryMs: 100 });
      expect(lock).not.toBeNull();

      await delay(1_200);

      expect(await client.get('k')).toBe(lock!.token);
      expect(lock!.signal.aborted).toBe(false);
      await lock!.release();
    });

    it('aborts the work it guards when the lock is lost', async () => {
      const lock = await acquireLock(client, 'k', { ttlMs: 500, renewEveryMs: 100 });
      expect(lock).not.toBeNull();

      // Simulates a failover, an eviction, or an operator with redis-cli.
      await client.del('k');
      await delay(400);

      expect(lock!.signal.aborted).toBe(true);
      expect(lock!.signal.reason).toBeInstanceOf(LockLostError);
      await lock!.release();
    });

    it('reports withLock as not-run rather than throwing when held', async () => {
      const held = await acquireLock(client, 'k', { ttlMs: 5_000 });

      const outcome = await withLock(client, 'k', { ttlMs: 5_000 }, async () => 'worked');
      expect(outcome).toEqual({ ran: false });

      await held!.release();
      const second = await withLock(client, 'k', { ttlMs: 5_000 }, async () => 'worked');
      expect(second).toEqual({ ran: true, result: 'worked' });
    });

    it('releases the lock even when the work throws', async () => {
      await expect(
        withLock(client, 'k', { ttlMs: 5_000 }, async () => {
          throw new Error('ingest blew up');
        }),
      ).rejects.toThrow('ingest blew up');

      expect(await client.get('k')).toBeNull();
    });
  });

  describe('the worker', () => {
    it('runs an enqueued job and records the success', async () => {
      const jobs = await startWorker();
      await jobs.trigger('test');

      await waitFor(async () => (await catalogJobStats(jobs)).lastSuccessAt !== null, 20_000);

      const stats = await catalogJobStats(jobs);
      expect(stats.lastSuccessAt).not.toBeNull();
      expect(stats.deadLettered).toBe(0);
      expect(stats.lastFailure).toBeNull();
      expect(stats.queue.completed).toBe(1);
    }, 30_000);

    it('lets a job see the abort signal when it exceeds its timeout', async () => {
      let aborted = false;

      const jobs = await startWorker({
        timeoutMs: 200,
        run: async (signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          });
          throw new Error('aborted by deadline');
        },
      });

      await jobs.trigger('slow');
      await waitFor(() => aborted, 10_000);
      expect(aborted).toBe(true);
    }, 30_000);
  });

  describe('two deployed instances', () => {
    it('never lets both run the ingest at once', async () => {
      let inFlight = 0;
      let overlaps = 0;
      let completed = 0;

      // Each `startWorker` is a separate replica: its own connection, its own
      // worker. Only the Redis lock stands between them.
      const run = async (): Promise<IngestSummary> => {
        inFlight += 1;
        if (inFlight > 1) overlaps += 1;
        await delay(250);
        inFlight -= 1;
        completed += 1;
        return summary();
      };

      const prefix = '{shared-replicas}';
      const a = await startWorker({ prefix, run });
      const b = await startWorker({ prefix, run });

      // Both replicas share one queue, so four jobs spread across both workers.
      await Promise.all([
        a.trigger('one'),
        a.trigger('two'),
        b.trigger('three'),
        b.trigger('four'),
      ]);

      await waitFor(async () => {
        const counts = await a.queue.getJobCounts('waiting', 'active', 'delayed');
        return (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['delayed'] ?? 0) === 0;
      }, 20_000);

      expect(overlaps).toBe(0);
      // The jobs that found the lock held completed as skipped, not failed.
      expect(completed).toBeGreaterThan(0);
      const counts = await a.queue.getJobCounts('failed');
      expect(counts['failed'] ?? 0).toBe(0);
    }, 40_000);
  });

  describe('failures', () => {
    it('retries, then dead-letters, and reports the failure', async () => {
      let calls = 0;

      const jobs = await startWorker({
        attempts: 3,
        backoffMs: 10,
        run: async () => {
          calls += 1;
          throw new Error('gamma unreachable');
        },
      });

      await jobs.trigger('doomed');

      await waitFor(async () => (await jobs.deadLetterQueue.getJobCounts('waiting'))['waiting'] === 1, 20_000);

      // Three attempts, not one — the backoff ran between them.
      expect(calls).toBe(3);

      const [dead] = await jobs.deadLetterQueue.getJobs(['waiting']);
      expect(dead?.data).toMatchObject({ attemptsMade: 3 });
      expect(String(dead?.data.error)).toContain('gamma unreachable');

      const stats = await catalogJobStats(jobs);
      expect(stats.deadLettered).toBe(1);
      expect(stats.lastFailure?.error).toContain('gamma unreachable');
      expect(stats.lastSuccessAt).toBeNull();
    }, 40_000);

    it('does not dead-letter a job that succeeds on a retry', async () => {
      let calls = 0;

      const jobs = await startWorker({
        attempts: 3,
        backoffMs: 10,
        run: async () => {
          calls += 1;
          if (calls < 2) throw new Error('transient');
          return summary();
        },
      });

      await jobs.trigger('flaky');

      await waitFor(async () => (await catalogJobStats(jobs)).lastSuccessAt !== null, 20_000);

      expect(calls).toBe(2);
      expect((await catalogJobStats(jobs)).deadLettered).toBe(0);
    }, 40_000);
  });

  describe('graceful shutdown', () => {
    it('waits for an in-flight job before closing', async () => {
      let finished = false;

      const jobs = await startWorker({
        run: async () => {
          await delay(600);
          finished = true;
          return summary();
        },
      });

      await jobs.trigger('long');
      // Let the worker pick it up before we ask it to stop.
      await waitFor(async () => (await jobs.queue.getJobCounts('active'))['active'] === 1, 10_000);

      await jobs.close(10_000);
      expect(finished).toBe(true);

      started.length = 0; // already closed
    }, 30_000);
  });
});

/** Polls `check` until it is truthy, or throws at the deadline. */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await delay(50);
  }
}
