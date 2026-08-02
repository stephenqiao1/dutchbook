import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dashboard } from '../../src/dashboard/index.js';
import { JS } from '../../src/dashboard/js.js';
import * as schema from '../../src/db/schema.js';
import {
  events,
  marketQuotes,
  markets,
  relationGroupMembers,
  relationGroups,
  relations,
  violations,
} from '../../src/db/schema.js';

/**
 * The public dashboard, against a real database.
 *
 * Real Postgres rather than a stubbed client because the substance of this
 * feature *is* the SQL — percentile windows, a jsonb array length, three
 * outer joins. A fake `execute` would assert that the routes call the queries
 * and prove nothing about whether the queries run.
 *
 * The other half is what the routes must never do: leak a stack trace, forget
 * that market questions are attacker-controlled text, or let one unauthenticated
 * request ask Postgres for the whole catalog.
 */

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const explicitUrl = process.env['TEST_DATABASE_URL'];
const canRun = explicitUrl !== undefined || dockerAvailable();

if (!canRun) {
  console.warn('\n  SKIPPED test/dashboard/dashboard.test.ts — needs Postgres.\n');
}

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

/** A question containing markup, because someone will eventually create one. */
const HOSTILE = 'Will <img src=x onerror=alert(1)> happen by 2027?';

async function seed(): Promise<void> {
  await database.execute(
    sql`truncate violations, relation_group_members, relation_groups, relations, market_quotes, markets, events restart identity cascade`,
  );

  await database.insert(events).values([
    { id: 'ev-ladder', slug: 'ladder', title: 'Ladder event' },
    { id: 'ev-part', slug: 'part', title: 'Partition event' },
  ]);

  await database.insert(markets).values([
    { conditionId: '0xa', eventId: 'ev-ladder', question: 'Above 30?', slug: 'above-30', contentHash: 'h1' },
    { conditionId: '0xb', eventId: 'ev-ladder', question: 'Above 20?', slug: 'above-20', contentHash: 'h2' },
    { conditionId: '0xc', eventId: 'ev-ladder', question: 'Above 10?', slug: 'above-10', contentHash: 'h3' },
    { conditionId: '0xp1', eventId: 'ev-part', question: HOSTILE, slug: 'p1', contentHash: 'h4' },
    { conditionId: '0xp2', eventId: 'ev-part', question: 'Candidate B wins', slug: 'p2', contentHash: 'h5' },
  ]);

  // A ladder priced so the middle rung breaks its entailment: 0.30 > 0.24.
  await database.insert(marketQuotes).values([
    { conditionId: '0xa', yesPrice: '0.10' },
    { conditionId: '0xb', yesPrice: '0.30' },
    { conditionId: '0xc', yesPrice: '0.24' },
    { conditionId: '0xp1', yesPrice: '0.70' },
    { conditionId: '0xp2', yesPrice: '0.45' },
  ]);

  await database.insert(relations).values([
    { fromConditionId: '0xa', toConditionId: '0xb', type: 'implies', source: 'ladder', confidence: '1' },
    { fromConditionId: '0xb', toConditionId: '0xc', type: 'implies', source: 'ladder', confidence: '1' },
    { fromConditionId: '0xp1', toConditionId: '0xp2', type: 'complement', source: 'negation', confidence: '1' },
  ]);

  const [group] = await database
    .insert(relationGroups)
    .values({ key: 'ev-part:winner', type: 'partition', source: 'event-partition', confidence: '1' })
    .returning({ id: relationGroups.id });

  await database.insert(relationGroupMembers).values([
    { groupId: group!.id, conditionId: '0xp1' },
    { groupId: group!.id, conditionId: '0xp2' },
  ]);

  const now = Date.now();
  await database.insert(violations).values([
    {
      constraintKey: 'implies:2',
      kind: 'implies',
      relationIds: [2],
      conditionIds: ['0xb', '0xc'],
      status: 'confirmed',
      everConfirmed: true,
      detectedAt: new Date(now - 600_000),
      peakNetEdge: '0.0400',
      peakNetProfit: '42.00',
      peakSize: '1050',
    },
    {
      constraintKey: 'partition:1',
      kind: 'partition',
      relationIds: [],
      groupId: '1',
      conditionIds: ['0xp1', '0xp2'],
      status: 'apparent',
      everConfirmed: false,
      reason: 'the spread and fees exceed the mispricing',
      detectedAt: new Date(now - 7_200_000),
      resolvedAt: new Date(now - 7_000_000),
      peakMagnitude: '0.1500',
    },
    {
      constraintKey: 'implies:1',
      kind: 'implies',
      relationIds: [1],
      conditionIds: ['0xa', '0xb'],
      status: 'confirmed',
      everConfirmed: true,
      detectedAt: new Date(now - 86_400_000),
      resolvedAt: new Date(now - 86_100_000),
      peakNetEdge: '0.0900',
      peakNetProfit: '180.00',
    },
  ]);
}

function buildApp() {
  const app = Fastify({ logger: false });
  void app.register(dashboard, {
    database,
    version: '9.9.9',
    // Off, so each test observes the database as it actually is.
    cacheTtlMs: 0,
    jobStats: async () => ({ lastSuccessAt: new Date().toISOString() }) as never,
  });
  return app;
}

beforeAll(async () => {
  if (!canRun) return;

  let url = explicitUrl;
  if (url === undefined) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    url = container.getConnectionUri();
    stopContainer = async () => {
      await container.stop();
    };
  }

  client = postgres(url, { max: 4, onnotice: () => {} });
  database = drizzle(client, { schema });

  const dir = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).toSorted()) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed !== '') await client.unsafe(trimmed);
    }
  }

  await seed();
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await stopContainer?.();
});

describe.skipIf(!canRun)('the page', () => {
  it('serves one HTML document', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>dutchbook');
    expect(res.body).toContain('viewport');
    await app.close();
  });

  it('pins the chart library with an integrity hash', async () => {
    // A CDN is the one external dependency on this page. Pinned version plus
    // SRI means the CDN can serve a different file and the browser will not
    // run it.
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.body).toContain('chart.js@4.4.7');
    expect(res.body).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(res.body).toContain('crossorigin="anonymous"');
    await app.close();
  });

  it('serves the assets as immutable with a content-derived etag', async () => {
    const app = buildApp();
    const css = await app.inject({ method: 'GET', url: '/app.css' });
    const js = await app.inject({ method: 'GET', url: '/app.js' });

    expect(css.headers['content-type']).toContain('text/css');
    expect(js.headers['content-type']).toContain('javascript');
    for (const res of [css, js]) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toContain('immutable');
      expect(res.headers['etag']).toMatch(/^"[0-9a-f]{12}"$/);
    }
    await app.close();
  });

  it('serves JavaScript that actually parses', async () => {
    // The client is a string in a TypeScript module, so `tsc` never looks
    // inside it. Without this, a stray brace ships and the only symptom is a
    // blank page in someone's browser.
    expect(() => new Function(JS)).not.toThrow();
  });

  it('never assigns server data to innerHTML', async () => {
    // Market questions are attacker-controlled — anyone can create a market —
    // and this page renders them. Building nodes and setting textContent is the
    // invariant that keeps that safe, so it is asserted rather than remembered.
    expect(JS).not.toMatch(/\.innerHTML\s*=/);
    expect(JS).not.toContain('insertAdjacentHTML');
    expect(JS).not.toContain('document.write');
  });
});

describe.skipIf(!canRun)('/api/status', () => {
  it('reports the catalog, the graph and what is open', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();

    expect(body.markets.tracked).toBe(5);
    expect(body.relations.edges).toBe(3);
    expect(body.relations.groups).toBe(1);
    expect(body.violations.openConfirmed).toBe(1);
    expect(body.violations.total).toBe(3);
    expect(body.ingest.lastSuccessAt).toBeTypeOf('string');
    await app.close();
  });

  it('counts edges by source and type', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();

    const ladder = body.relations.bySource.find(
      (r: { source: string; type: string }) => r.source === 'ladder' && r.type === 'implies',
    );
    expect(ladder.count).toBe(2);
    await app.close();
  });

  it('takes the median lifetime from closed confirmed episodes only', async () => {
    // The open one has no lifetime, and the closed apparent one is not a
    // confirmed opportunity. Only the 300s episode qualifies.
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();

    expect(body.violations.medianLifetimeSeconds).toBeGreaterThan(290);
    expect(body.violations.medianLifetimeSeconds).toBeLessThan(310);
    await app.close();
  });

  it('lists open violations with an age and puts confirmed first', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();

    expect(body.open).toHaveLength(1);
    expect(body.open[0]).toMatchObject({ constraintKey: 'implies:2', netEdge: 0.04 });
    expect(body.open[0].ageSeconds).toBeGreaterThan(500);
    await app.close();
  });
});

describe.skipIf(!canRun)('/api/violations', () => {
  it('returns the history with lifetimes and peak edge', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/violations' })).json();

    expect(body.total).toBe(3);
    expect(body.violations).toHaveLength(3);

    const open = body.violations.find((v: { constraintKey: string }) => v.constraintKey === 'implies:2');
    expect(open).toMatchObject({ open: true, everConfirmed: true, peakNetEdge: 0.04 });
    // An open episode reports age so far; `open` is what says which it is.
    expect(open.lifetimeSeconds).toBeGreaterThan(500);
    await app.close();
  });

  it('carries the market question through verbatim', async () => {
    // Escaping belongs in the browser, at the point of insertion. Mangling it
    // here would corrupt the data for every other consumer of this feed.
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/violations' })).json();

    const partition = body.violations.find((v: { kind: string }) => v.kind === 'partition');
    expect(partition.question).toBe(HOSTILE);
    await app.close();
  });

  it('filters by status', async () => {
    const app = buildApp();
    const open = (await app.inject({ method: 'GET', url: '/api/violations?status=open' })).json();
    const apparent = (await app.inject({ method: 'GET', url: '/api/violations?status=apparent' })).json();

    expect(open.violations).toHaveLength(1);
    expect(apparent.violations).toHaveLength(1);
    expect(apparent.violations[0].reason).toContain('spread and fees');
    await app.close();
  });

  it('clamps an absurd limit instead of running it', async () => {
    // No authentication in front of this, so a caller must not be able to ask
    // Postgres for a million rows.
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/violations?limit=999999' })).json();

    expect(body.limit).toBe(500);
    await app.close();
  });

  it('ignores a nonsense limit rather than failing', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/violations?limit=drop%20table' })).json();

    expect(body.limit).toBe(500);
    expect(body.violations).toHaveLength(3);
    await app.close();
  });
});

describe.skipIf(!canRun)('/api/relations', () => {
  it('publishes the graph with both questions resolved', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/relations' })).json();

    expect(body.total).toBe(3);
    const edge = body.relations.find((r: { type: string }) => r.type === 'complement');
    expect(edge).toMatchObject({ from: '0xp1', to: '0xp2', source: 'negation' });
    expect(edge.fromQuestion).toBe(HOSTILE);
    await app.close();
  });

  it('filters by source and by type', async () => {
    const app = buildApp();
    const ladder = (await app.inject({ method: 'GET', url: '/api/relations?source=ladder' })).json();
    const complements = (await app.inject({ method: 'GET', url: '/api/relations?type=complement' })).json();

    expect(ladder.total).toBe(2);
    expect(complements.total).toBe(1);
    await app.close();
  });

  it('caps the page size', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/relations?limit=100000' })).json();
    expect(body.limit).toBe(2000);
    await app.close();
  });
});

describe.skipIf(!canRun)('/api/families', () => {
  it('lists both partitions and ladders', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/families' })).json();

    const kinds = body.families.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain('partition');
    expect(kinds).toContain('ladder');
    await app.close();
  });

  it('draws a partition against its sum-to-one constraint', async () => {
    const app = buildApp();
    const list = (await app.inject({ method: 'GET', url: '/api/families' })).json();
    const key = list.families.find((f: { kind: string }) => f.kind === 'partition').key;
    const body = (await app.inject({ method: 'GET', url: `/api/families/${encodeURIComponent(key)}` })).json();

    // 0.70 + 0.45 = 1.15, so the constraint is broken by 0.15.
    expect(body.sum).toBeCloseTo(1.15, 6);
    expect(body.magnitude).toBeCloseTo(0.15, 6);
    expect(body.violated).toBe(true);
    expect(body.members).toHaveLength(2);
    await app.close();
  });

  it('reports a ladder edge that is priced above what it entails', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/families/event%3Aev-ladder' })).json();

    expect(body.kind).toBe('ladder');
    expect(body.members).toHaveLength(3);

    // implies(b, c) with P(b)=0.30 and P(c)=0.24 breaks by 0.06.
    const broken = body.edges.filter((e: { satisfied: boolean }) => e.satisfied === false);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ from: '0xb', to: '0xc' });
    expect(broken[0].slack).toBeCloseTo(0.06, 6);
    expect(body.violated).toBe(true);
    await app.close();
  });

  it('404s an unknown family rather than guessing', async () => {
    const app = buildApp();
    const missing = await app.inject({ method: 'GET', url: '/api/families/event%3Anope' });
    const malformed = await app.inject({ method: 'GET', url: '/api/families/nonsense' });

    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    await app.close();
  });
});

describe.skipIf(!canRun)('/api/lifetimes', () => {
  it('buckets closed episodes and reports the quantiles', async () => {
    const app = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/lifetimes' })).json();

    expect(body.closed).toBe(2);
    expect(body.buckets.map((b: { label: string }) => b.label)).toContain('1–5m');

    const total = body.buckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0);
    expect(total).toBe(2);
    // Only one of the two closed episodes was ever confirmed.
    const confirmed = body.buckets.reduce((sum: number, b: { confirmed: number }) => sum + b.confirmed, 0);
    expect(confirmed).toBe(1);
    await app.close();
  });
});

describe.skipIf(!canRun)('caching', () => {
  /** The real database, with every `execute` held behind a gate we control. */
  function gated() {
    let gate: Promise<void> | null = null;
    let open: (() => void) | undefined;

    const proxy = {
      execute: async (...args: unknown[]) => {
        if (gate !== null) await gate;
        return (database as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute(
          ...args,
        );
      },
      select: (...args: unknown[]) =>
        (database as unknown as { select: (...a: unknown[]) => unknown }).select(...args),
    };

    return {
      database: proxy as never,
      block: () => {
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
      },
      release: () => {
        gate = null;
        open?.();
      },
    };
  }

  it('serves a stale value immediately rather than waiting on a slow query', async () => {
    // The reason this exists: on production the status aggregate scans ~300k
    // markets and took 6-25s. With a plain TTL cache and a page slower than the
    // TTL, every request was a miss and every visitor waited on Postgres.
    const g = gated();
    const app = Fastify({ logger: false });
    void app.register(dashboard, { database: g.database, cacheTtlMs: 1 });
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/api/status' });
    expect(first.statusCode).toBe(200);

    // Now the database stops answering. The TTL has already lapsed, so this
    // request triggers a refresh that cannot finish — and must still answer.
    g.block();
    const second = await app.inject({ method: 'GET', url: '/api/status' });

    expect(second.statusCode).toBe(200);
    expect(second.json().markets.tracked).toBe(5);

    g.release();
    await app.close();
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const flaky = {
      execute: (...args: unknown[]) =>
        fail
          ? Promise.reject(new Error('nope'))
          : (database as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute(
              ...args,
            ),
      select: (...args: unknown[]) =>
        (database as unknown as { select: (...a: unknown[]) => unknown }).select(...args),
    };

    const app = Fastify({ logger: false });
    void app.register(dashboard, { database: flaky as never, cacheTtlMs: 60_000 });

    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(503);

    // A blip must not blind the page for a whole TTL.
    fail = false;
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
    await app.close();
  });
});

describe.skipIf(!canRun)('serving it publicly', () => {
  it('gzips a large response for a client that asks', async () => {
    // 500 episodes is ~276KB of JSON. Over mobile data that is worth about ten
    // times its compressed size.
    const app = buildApp();
    const plain = await app.inject({ method: 'GET', url: '/api/violations' });
    const zipped = await app.inject({
      method: 'GET',
      url: '/api/violations',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(zipped.headers['content-encoding']).toBe('gzip');
    // Without `vary`, a shared cache hands the gzipped body to a client that
    // did not ask for one.
    expect(zipped.headers['vary']).toContain('accept-encoding');
    await app.close();
  });

  it('leaves a small response alone', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/lifetimes',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });


  it('allows cross-origin reads of the JSON', async () => {
    // The point of publishing this is that someone else can build on it, and a
    // browser cannot fetch cross-origin without the header.
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    await app.close();
  });

  it('does not put that header on anything outside /api', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('answers a database failure with 503 and no stack trace', async () => {
    const app = Fastify({ logger: false });
    void app.register(dashboard, {
      database: {
        execute: () => Promise.reject(new Error('connection terminated: pgbouncer said no')),
      } as never,
      cacheTtlMs: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/api/status' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'data unavailable',
      detail: 'the database did not answer in time',
    });
    expect(res.body).not.toContain('pgbouncer');
    await app.close();
  });
});
