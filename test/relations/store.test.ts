import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { events, markets, relations } from '../../src/db/schema.js';
import type { RelationEdge } from '../../src/relations/ladders.js';
import { saveRelationEdges } from '../../src/relations/store.js';

/**
 * The persistence contract: re-running extraction over an unchanged catalog
 * must not grow the table. That is a property of the unique constraint and the
 * conflict clause, so it can only be tested against a real database.
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
  console.warn(
    '\n  SKIPPED test/relations/store.test.ts — needs Postgres.' +
      '\n  Start Docker, or set TEST_DATABASE_URL to a throwaway database.\n',
  );
}

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

const edge = (from: string, to: string, rationale = 'because'): RelationEdge => ({
  fromConditionId: from,
  toConditionId: to,
  type: 'implies',
  source: 'ladder',
  confidence: 1,
  rationale,
});

describe.skipIf(!canRun)('saveRelationEdges', () => {
  beforeAll(async () => {
    let url = explicitUrl;
    if (url === undefined) {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const container = await new PostgreSqlContainer('postgres:16').start();
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
  }, 60_000);

  beforeEach(async () => {
    await client`truncate relations, markets, events restart identity cascade`;
    await database.insert(events).values({ id: 'e1', slug: 'e1', title: 'E1' });
    await database.insert(markets).values(
      ['a', 'b', 'c'].map((id) => ({
        conditionId: id,
        eventId: 'e1',
        question: `Q ${id}`,
        contentHash: `hash-${id}`,
      })),
    );
  });

  it('inserts new edges', async () => {
    const result = await saveRelationEdges([edge('a', 'b'), edge('b', 'c')], database);

    expect(result).toMatchObject({ submitted: 2, inserted: 2, refreshed: 0, rejected: 0 });
    expect(await database.select().from(relations)).toHaveLength(2);
  });

  it('is idempotent: re-running writes no new rows', async () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];

    const first = await saveRelationEdges(edges, database);
    const before = await database.select().from(relations);

    const second = await saveRelationEdges(edges, database);
    const after = await database.select().from(relations);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.refreshed).toBe(2);
    expect(after).toHaveLength(2);

    // Same rows, same identity — an upsert, not a delete and re-insert.
    expect(after.map((r) => r.id).toSorted()).toEqual(before.map((r) => r.id).toSorted());
  });

  it('keeps first_seen_at and moves last_seen_at', async () => {
    await saveRelationEdges([edge('a', 'b')], database);
    const [before] = await database.select().from(relations);

    await client`select pg_sleep(0.05)`;
    await saveRelationEdges([edge('a', 'b')], database);
    const [after] = await database.select().from(relations);

    expect(after?.firstSeenAt).toEqual(before?.firstSeenAt);
    expect(after?.lastSeenAt.getTime()).toBeGreaterThan(before?.lastSeenAt.getTime() ?? 0);
  });

  it('refreshes the rationale when the extractor changes its reasoning', async () => {
    await saveRelationEdges([edge('a', 'b', 'old reasoning')], database);
    await saveRelationEdges([edge('a', 'b', 'better reasoning')], database);

    const rows = await database.select().from(relations);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rationale).toBe('better reasoning');
  });

  it('treats a different relation type as a different edge', async () => {
    await saveRelationEdges([edge('a', 'b')], database);
    await saveRelationEdges([{ ...edge('a', 'b'), type: 'implies' as const }], database);

    // Same (from, to, type) — still one row.
    expect(await database.select().from(relations)).toHaveLength(1);

    // The unique key includes type, so another kind coexists.
    await database.insert(relations).values({
      fromConditionId: 'a',
      toConditionId: 'b',
      type: 'excludes',
      source: 'manual',
      confidence: '0.5000',
    });
    expect(await database.select().from(relations)).toHaveLength(2);
  });

  it('drops duplicates inside a single call rather than failing the statement', async () => {
    // Postgres rejects a statement whose rows conflict with each other, even
    // with ON CONFLICT — so the duplicate has to be removed before the write.
    const result = await saveRelationEdges([edge('a', 'b'), edge('a', 'b'), edge('b', 'c')], database);

    expect(result.rejected).toBe(1);
    expect(result.inserted).toBe(2);
    expect(await database.select().from(relations)).toHaveLength(2);
  });

  it('refuses a self-edge, and the database refuses one too', async () => {
    const result = await saveRelationEdges([edge('a', 'a')], database);
    expect(result.rejected).toBe(1);
    expect(await database.select().from(relations)).toHaveLength(0);

    await expect(
      database.insert(relations).values({
        fromConditionId: 'a',
        toConditionId: 'a',
        type: 'implies',
        source: 'ladder',
        confidence: '1.0000',
      }),
    ).rejects.toThrow();
  });

  it('writes nothing when handed nothing', async () => {
    const result = await saveRelationEdges([], database);
    expect(result).toMatchObject({ submitted: 0, inserted: 0, refreshed: 0 });
  });

  it('round-trips confidence as an exact decimal', async () => {
    await saveRelationEdges([edge('a', 'b')], database);
    const [row] = await database.select().from(relations);
    expect(Number(row?.confidence)).toBe(1);
  });

  it('cascades when a market disappears', async () => {
    await saveRelationEdges([edge('a', 'b'), edge('b', 'c')], database);
    await client`delete from markets where condition_id = 'b'`;

    // Both edges touched b, so both go. Relations are derived data; a market
    // that no longer exists cannot be an endpoint of an implication.
    expect(await database.select().from(relations)).toHaveLength(0);
  });

  it('handles a batch larger than one chunk', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
    await database.insert(markets).values(
      ids.map((id) => ({ conditionId: id, eventId: 'e1', question: `Q ${id}`, contentHash: id })),
    );

    const edges = ids.slice(0, -1).map((id, i) => edge(id, ids[i + 1] ?? ''));
    const first = await saveRelationEdges(edges, database);
    const second = await saveRelationEdges(edges, database);

    expect(first.inserted).toBe(59);
    expect(second.inserted).toBe(0);
    expect(second.refreshed).toBe(59);

    const [{ total } = { total: 0 }] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(relations);
    expect(total).toBe(59);
  });
});
