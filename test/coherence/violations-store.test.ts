import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Confirmation } from '../../src/coherence/check.js';
import type { Constraint } from '../../src/coherence/constraints.js';
import type { CorrectingTrade } from '../../src/coherence/trade.js';
import {
  lifetimeStats,
  recordViolations,
  resolveDisappeared,
} from '../../src/coherence/violations-store.js';
import * as schema from '../../src/db/schema.js';
import { events, markets, violations } from '../../src/db/schema.js';

/**
 * Episodes and lifetime.
 *
 * The headline metric of the whole service is the median time a confirmed
 * violation survives, and that number is only as trustworthy as the episode
 * bookkeeping underneath it. So these tests are mostly about boundaries: when
 * an episode opens, when it does *not* re-open, when it closes, and what
 * happens to a constraint the run never looked at.
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
  console.warn('\n  SKIPPED test/coherence/violations-store.test.ts — needs Postgres.\n');
}

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

const constraint: Constraint = {
  key: 'implies:1',
  kind: 'implies',
  relationIds: [1],
  groupId: null,
  members: [
    { conditionId: '0xa', price: 0.7 },
    { conditionId: '0xb', price: 0.4 },
  ],
};

function trade(netEdge: number, size: number): CorrectingTrade {
  return {
    constraintKey: constraint.key,
    kind: 'implies',
    direction: 'over',
    summary: 'buy No(A) + Yes(B)',
    legs: [],
    size,
    maxExecutableSize: size * 2,
    guaranteedPayout: 1,
    totalPayout: size,
    totalNotional: size * (1 - netEdge),
    totalFees: 0,
    totalCost: size * (1 - netEdge),
    grossEdge: netEdge,
    netEdge,
    netProfit: netEdge * size,
    returnOnCost: 1,
  };
}

function confirmation(over: Partial<Confirmation> = {}): Confirmation {
  return {
    constraint,
    evaluation: {
      constraint,
      magnitude: 0.3,
      direction: 'over',
      violated: true,
      unscreenable: false,
      prices: [0.7, 0.4],
      sum: null,
    },
    liveMagnitude: 0.3,
    trade: null,
    failure: 'negative-edge',
    reason: 'the spread and fees exceed the mispricing',
    status: 'apparent',
    ...over,
  };
}

const seed = async (): Promise<void> => {
  await database.execute(sql`truncate violations, markets, events restart identity cascade`);
  await database.insert(events).values({ id: 'e1', slug: 'e1', title: 'E' });
  await database.insert(markets).values(
    ['0xa', '0xb'].map((id) => ({
      conditionId: id,
      eventId: 'e1',
      question: `q ${id}`,
      contentHash: `h ${id}`,
    })),
  );
};

// Container setup is file-scoped: two describes sharing one database, so the
// first block's teardown does not pull the socket out from under the second.
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
}, 240_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await stopContainer?.();
});

beforeEach(async () => {
  if (canRun) await seed();
});

describe.skipIf(!canRun)('violation episodes', () => {
  it('opens an apparent episode with its reason', async () => {
    const result = await recordViolations([confirmation()], new Set(['implies:1']), database);

    expect(result.opened).toBe(1);
    const [row] = await database.select().from(violations);
    expect(row).toMatchObject({
      constraintKey: 'implies:1',
      kind: 'implies',
      status: 'apparent',
      everConfirmed: false,
      relationIds: [1],
      conditionIds: ['0xa', '0xb'],
    });
    expect(row?.reason).toContain('spread and fees');
    expect(row?.resolvedAt).toBeNull();
    expect(row?.trade).toBeNull();
  });

  it('opens a confirmed episode with the full trade construction', async () => {
    await recordViolations(
      [confirmation({ status: 'confirmed', trade: trade(0.3, 200), failure: null, reason: null })],
      new Set(['implies:1']),
      database,
    );

    const [row] = await database.select().from(violations);
    expect(row).toMatchObject({ status: 'confirmed', everConfirmed: true });
    expect(Number(row?.peakNetEdge)).toBeCloseTo(0.3, 6);
    expect(Number(row?.peakSize)).toBeCloseTo(200, 6);
    expect(Number(row?.peakNetProfit)).toBeCloseTo(60, 6);
    expect(row?.trade).toMatchObject({ summary: 'buy No(A) + Yes(B)', guaranteedPayout: 1 });
  });

  it('updates the SAME episode rather than opening a second one', async () => {
    const still = new Set(['implies:1']);
    await recordViolations([confirmation()], still, database);
    await recordViolations([confirmation()], still, database);
    await recordViolations([confirmation()], still, database);

    const rows = await database.select().from(violations);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.checks)).toBe(3);
  });

  it('upgrades apparent to confirmed, keeping the original detection time', async () => {
    const still = new Set(['implies:1']);
    await recordViolations([confirmation()], still, database);
    const [before] = await database.select().from(violations);

    const result = await recordViolations(
      [confirmation({ status: 'confirmed', trade: trade(0.2, 100), failure: null, reason: null })],
      still,
      database,
    );

    expect(result.upgraded).toBe(1);
    const [after] = await database.select().from(violations);
    expect(after).toMatchObject({ status: 'confirmed', everConfirmed: true });
    // Lifetime runs from when the violation started, not from when it became
    // executable — otherwise every lifetime is measured from the wrong end.
    expect(after?.detectedAt.getTime()).toBe(before?.detectedAt.getTime());
    expect(after?.reason).toBeNull();
  });

  it('keeps the PEAK trade, not the latest', async () => {
    const still = new Set(['implies:1']);
    const confirmed = (edge: number, size: number): Confirmation =>
      confirmation({ status: 'confirmed', trade: trade(edge, size), failure: null, reason: null });

    await recordViolations([confirmed(0.3, 200)], still, database); // $60
    await recordViolations([confirmed(0.05, 100)], still, database); // $5 — worse

    const [row] = await database.select().from(violations);
    expect(Number(row?.peakNetProfit)).toBeCloseTo(60, 6);
    expect(Number(row?.peakSize)).toBeCloseTo(200, 6);
  });

  it('ranks the peak on total profit, not per-unit edge', async () => {
    // A huge edge on two shares is worth less than a small edge on thousands,
    // and it is the dollars that decide whether an episode mattered.
    const still = new Set(['implies:1']);
    await recordViolations(
      [confirmation({ status: 'confirmed', trade: trade(0.5, 2), failure: null, reason: null })],
      still,
      database,
    );
    await recordViolations(
      [confirmation({ status: 'confirmed', trade: trade(0.01, 5000), failure: null, reason: null })],
      still,
      database,
    );

    const [row] = await database.select().from(violations);
    expect(Number(row?.peakNetProfit)).toBeCloseTo(50, 6);
    expect(Number(row?.peakNetEdge)).toBeCloseTo(0.01, 6);
  });

  it('a confirmed episode that degrades stays confirmed', async () => {
    const still = new Set(['implies:1']);
    await recordViolations(
      [confirmation({ status: 'confirmed', trade: trade(0.3, 200), failure: null, reason: null })],
      still,
      database,
    );
    await recordViolations([confirmation()], still, database); // back to apparent

    const [row] = await database.select().from(violations);
    // Still violating, just no longer profitable. `ever_confirmed` is the
    // permanent record that it once was; it is not re-litigated each tick.
    expect(row?.everConfirmed).toBe(true);
    expect(row?.status).toBe('confirmed');
    expect(row?.resolvedAt).toBeNull();
  });
});

describe.skipIf(!canRun)('resolution and lifetime', () => {
  it('closes an episode when the constraint stops violating', async () => {
    const detected = new Date('2026-08-01T12:00:00Z');
    const resolved = new Date('2026-08-01T12:05:00Z');

    await recordViolations([confirmation()], new Set(['implies:1']), database, detected);
    const closed = await resolveDisappeared(new Set(), database, resolved);

    expect(closed).toBe(1);
    const [row] = await database.select().from(violations);
    expect(row?.status).toBe('closed');
    expect(row?.resolvedAt?.toISOString()).toBe(resolved.toISOString());
  });

  it('does NOT close an episode the run never examined', async () => {
    // The critical failure mode: a truncated stage 2, or a screen that skipped
    // a market for want of a quote, would otherwise resolve every episode it
    // simply did not look at — and every one of those lifetimes would be wrong.
    await recordViolations([confirmation()], new Set(['implies:1']), database);
    const closed = await resolveDisappeared(new Set(['implies:1']), database);

    expect(closed).toBe(0);
    const [row] = await database.select().from(violations);
    expect(row?.resolvedAt).toBeNull();
  });

  it('a constraint violating again opens a NEW episode', async () => {
    const t0 = new Date('2026-08-01T12:00:00Z');
    await recordViolations([confirmation()], new Set(['implies:1']), database, t0);
    await resolveDisappeared(new Set(), database, new Date('2026-08-01T12:01:00Z'));
    await recordViolations(
      [confirmation()],
      new Set(['implies:1']),
      database,
      new Date('2026-08-01T14:00:00Z'),
    );

    const rows = await database.select().from(violations);
    // Two separate opportunities, hours apart. Merging them into one episode
    // would report a two-hour lifetime for a violation that lasted a minute.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.resolvedAt === null)).toHaveLength(1);
  });

  it('refuses a second OPEN episode for the same constraint', async () => {
    await recordViolations([confirmation()], new Set(['implies:1']), database);

    // Two checkers racing: the partial unique index is the last line of defence
    // behind the Redis lock.
    await expect(
      database.insert(violations).values({
        constraintKey: 'implies:1',
        kind: 'implies',
        relationIds: [1],
        conditionIds: ['0xa', '0xb'],
        status: 'apparent',
      }),
    ).rejects.toThrow();
  });

  it('computes the median lifetime over CONFIRMED episodes', async () => {
    // Three closed confirmed episodes lasting 60s, 120s, and 600s → median 120.
    // Plus an apparent-only episode of 5s that must not drag the median down.
    const base = Date.UTC(2026, 7, 1, 12, 0, 0);
    const episodes: [string, number, boolean][] = [
      ['implies:1', 60, true],
      ['implies:2', 120, true],
      ['implies:3', 600, true],
      ['implies:4', 5, false],
    ];

    for (const [key, seconds, confirmed] of episodes) {
      await database.insert(violations).values({
        constraintKey: key,
        kind: 'implies',
        relationIds: [],
        conditionIds: ['0xa'],
        status: 'closed',
        everConfirmed: confirmed,
        detectedAt: new Date(base),
        resolvedAt: new Date(base + seconds * 1000),
        peakNetProfit: confirmed ? '42' : null,
      });
    }

    const stats = await lifetimeStats(database);
    expect(stats.closedEpisodes).toBe(4);
    expect(stats.closedConfirmed).toBe(3);
    expect(stats.medianConfirmedLifetimeSeconds).toBeCloseTo(120, 3);
    // The all-episodes median includes the 5s apparent one: (60+120)/2 = 90.
    expect(stats.medianAllLifetimeSeconds).toBeCloseTo(90, 3);
    expect(stats.bestNetProfit).toBeCloseTo(42, 6);
  });

  it('reports a null median before any confirmed episode has closed', async () => {
    await recordViolations([confirmation()], new Set(['implies:1']), database);
    const stats = await lifetimeStats(database);

    expect(stats.medianConfirmedLifetimeSeconds).toBeNull();
    expect(stats.openEpisodes).toBe(1);
    expect(stats.totalConfirmedEver).toBe(0);
  });
});
