import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../src/coherence/check.js';
import { startCoherenceJobs, type CoherenceJobs } from '../../src/jobs/coherence-queue.js';

/**
 * The coherence schedule, against real Redis.
 *
 * The claim under test is that this runs on its own 60-second cadence,
 * independently of the ten-minute catalog ingest, and that two replicas cannot
 * check concurrently. The second half matters more than it does for the ingest:
 * at a 60-second interval a check that takes 70 seconds would overlap itself,
 * and two checkers racing on the same violation episode is exactly what the
 * partial unique index on `violations` exists to catch — which is not a thing
 * to rely on when a lock can prevent it.
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
  console.warn('\n  SKIPPED test/jobs/coherence-queue.test.ts — needs Redis.\n');
}

let url: string;
let client: Redis;
let stopContainer: (() => Promise<void>) | undefined;

function connect(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

const emptyResult = (): CheckResult => ({
  startedAt: new Date(),
  finishedAt: new Date(),
  screened: { evaluated: 3, satisfied: 3, violated: 0, unscreenable: 0 },
  confirmations: [],
  confirmed: 0,
  apparent: 0,
  booksFetched: 0,
});

const started: CoherenceJobs[] = [];
const opened: Redis[] = [];

async function startWorker(
  options: Partial<Parameters<typeof startCoherenceJobs>[0]> = {},
): Promise<CoherenceJobs> {
  const connection = connect();
  opened.push(connection);

  const jobs = await startCoherenceJobs({
    connection,
    schedule: false,
    prefix: `{coh-${Math.trunc(Date.now() % 1e9)}-${started.length}}`,
    lockTtlMs: 5_000,
    timeoutMs: 5_000,
    attempts: 1,
    backoffMs: 10,
    run: async () => emptyResult(),
    persist: async () => ({ opened: 0, updated: 0, upgraded: 0, resolved: 0 }),
    ...options,
  });

  started.push(jobs);
  return jobs;
}

describe.skipIf(!canRun)('coherence scheduling', () => {
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

  it('runs a triggered check', async () => {
    const runs: number[] = [];
    const jobs = await startWorker({
      run: async () => {
        runs.push(Date.now());
        return emptyResult();
      },
    });

    await jobs.trigger('test');
    for (let i = 0; i < 100; i += 1) {
      if (runs.length > 0) break;
      await delay(50);
    }

    expect(runs).toHaveLength(1);
  });

  it('registers a repeatable schedule at the configured interval', async () => {
    const jobs = await startWorker({ schedule: true, intervalMs: 60_000 });
    const schedulers = await jobs.queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(Number(schedulers[0]?.every)).toBe(60_000);
  });

  it('uses a queue and a lock key of its own, separate from the ingest', async () => {
    // Sharing either would let a twenty-minute catalog crawl block sixty
    // consecutive coherence checks — the exact window a short-lived violation
    // lives and dies in.
    const jobs = await startWorker();
    expect(jobs.queue.name).toBe('coherence-check');
    expect(jobs.queue.name).not.toBe('catalog-ingest');

    await jobs.trigger('t');
    for (let i = 0; i < 60; i += 1) await delay(50);

    const keys = await client.keys('dutchbook:*');
    expect(keys.some((k) => k.startsWith('dutchbook:coherence:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('dutchbook:catalog:'))).toBe(false);
  });

  it('a second replica skips rather than checking concurrently', async () => {
    let concurrent = 0;
    let peak = 0;

    const slow = async (): Promise<CheckResult> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await delay(400);
      concurrent -= 1;
      return emptyResult();
    };

    const prefix = '{coh-shared}';
    const a = await startWorker({ prefix, run: slow });
    const b = await startWorker({ prefix, run: slow });

    await Promise.all([a.trigger('one'), b.trigger('two')]);
    for (let i = 0; i < 60; i += 1) await delay(50);

    // Two jobs, at most one running at a time.
    expect(peak).toBe(1);
  });

  it('records the last success where health can read it', async () => {
    const jobs = await startWorker();
    await jobs.trigger('t');
    for (let i = 0; i < 100; i += 1) {
      if ((await client.get('dutchbook:coherence:last-success')) !== null) break;
      await delay(50);
    }
    expect(await client.get('dutchbook:coherence:last-success')).not.toBeNull();
  });

  it('dead-letters a check that exhausts its attempts', async () => {
    const jobs = await startWorker({
      attempts: 1,
      run: async () => {
        throw new Error('screen exploded');
      },
    });

    await jobs.trigger('t');
    for (let i = 0; i < 100; i += 1) {
      if (((await jobs.deadLetterQueue.getJobCounts()).waiting ?? 0) > 0) break;
      await delay(50);
    }

    const counts = await jobs.deadLetterQueue.getJobCounts();
    expect(counts.waiting ?? 0).toBeGreaterThan(0);

    const failure = await client.get('dutchbook:coherence:last-failure');
    expect(failure).toContain('screen exploded');
  });
});
