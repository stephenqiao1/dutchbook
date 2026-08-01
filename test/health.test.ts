import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { CatalogJobStats } from '../src/jobs/catalog-queue.js';
import { buildServer, version } from '../src/server.js';

const up = async (): Promise<void> => {};
const down = (message: string) => async (): Promise<void> => {
  throw new Error(message);
};
const hangs = () => new Promise<void>(() => {});

const idleJobs: CatalogJobStats = {
  queue: { waiting: 0, active: 0, delayed: 1, failed: 0, completed: 12 },
  deadLettered: 0,
  lastSuccessAt: '2026-08-01T02:50:00.000Z',
  lastFailure: null,
};

let app: FastifyInstance | undefined;

async function serve(
  probes: { postgres: () => Promise<void>; redis: () => Promise<void> },
  jobStats: () => Promise<CatalogJobStats> = async () => idleJobs,
) {
  app = buildServer({ probes, jobStats, healthcheckTimeoutMs: 200 });
  await app.ready();
  return app.inject({ method: 'GET', url: '/health' });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 when Postgres and Redis are both reachable', async () => {
    const res = await serve({ postgres: up, redis: up });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
      version,
      jobs: idleJobs,
    });
    expect(res.json().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when Postgres is down', async () => {
    const res = await serve({ postgres: down('ECONNREFUSED 127.0.0.1:5432'), redis: up });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.version).toBe(version);
    expect(body.checks.postgres).toContain('ECONNREFUSED');
    expect(body.checks.redis).toBe('ok');
  });

  it('returns 503 when Redis is down', async () => {
    const res = await serve({ postgres: up, redis: down('connection is closed') });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis).toContain('connection is closed');
    expect(res.json().checks.postgres).toBe('ok');
  });

  it('reports both failures when neither dependency is reachable', async () => {
    const res = await serve({ postgres: down('pg gone'), redis: down('redis gone') });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ postgres: 'pg gone', redis: 'redis gone' });
  });

  it('returns 503 rather than hanging when a probe never settles', async () => {
    const res = await serve({ postgres: hangs, redis: up });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.postgres).toMatch(/timed out after 200ms/);
  });

  it('does not leak probe internals into a healthy response', async () => {
    const res = await serve({ postgres: up, redis: up });

    expect(Object.keys(res.json()).toSorted()).toEqual(['jobs', 'status', 'uptimeSeconds', 'version']);
  });
});

describe('GET /health job metrics', () => {
  it('reports queue depth, last success, and last failure', async () => {
    const stats: CatalogJobStats = {
      queue: { waiting: 3, active: 1, delayed: 1, failed: 2, completed: 118 },
      deadLettered: 1,
      lastSuccessAt: '2026-08-01T02:50:00.000Z',
      lastFailure: { at: '2026-08-01T02:40:00.000Z', error: 'gamma 503 after 7 attempts' },
    };

    const res = await serve({ postgres: up, redis: up }, async () => stats);

    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toEqual(stats);
  });

  it('reports metrics on a degraded response too', async () => {
    const res = await serve({ postgres: down('pg gone'), redis: up });

    expect(res.statusCode).toBe(503);
    expect(res.json().jobs).toEqual(idleJobs);
  });

  it('does not let a failed ingest flip the process to degraded', async () => {
    // A dead-lettered job is an operational problem, not an unhealthy process.
    // Reporting it as 503 would have an orchestrator restart a pod that is
    // serving traffic perfectly well.
    const res = await serve({ postgres: up, redis: up }, async () => ({
      queue: { waiting: 0, active: 0, delayed: 1, failed: 9, completed: 4 },
      deadLettered: 9,
      lastSuccessAt: null,
      lastFailure: { at: '2026-08-01T02:40:00.000Z', error: 'everything is on fire' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().jobs.deadLettered).toBe(9);
  });

  it('degrades the jobs block rather than the whole check when Redis cannot answer', async () => {
    const res = await serve({ postgres: up, redis: up }, async () => {
      throw new Error('READONLY You cannot write against a read only replica');
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().jobs.error).toContain('READONLY');
  });

  it('bounds the job metrics read by the same deadline as the probes', async () => {
    const res = await serve({ postgres: up, redis: up }, () => new Promise(() => {}));

    expect(res.statusCode).toBe(200);
    expect(res.json().jobs.error).toMatch(/timed out after 200ms/);
  });
});
