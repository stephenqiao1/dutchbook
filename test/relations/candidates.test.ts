import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import {
  events,
  marketEmbeddings,
  markets,
  relationGroupMembers,
  relationGroups,
  relations,
} from '../../src/db/schema.js';
import { findCandidatePairs } from '../../src/relations/candidates.js';
import { recordVerdict, saveProposals } from '../../src/relations/proposals-store.js';
import type { RelationProposal } from '../../src/relations/proposer.js';

/**
 * Candidate generation is where the money is spent, so it is also where the
 * spending is prevented.
 *
 * The stated guarantee is that a full pipeline re-run costs zero model calls
 * for anything already decided. That is not a property of the CLI or of the
 * proposer — it is three anti-joins in one SQL query, and this is the file that
 * holds them to it.
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
    '\n  SKIPPED test/relations/candidates.test.ts — needs Postgres with pgvector.\n',
  );
}

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

const DIMENSIONS = 384;

/**
 * A unit vector whose first two components encode an angle, and whose rest are
 * zero. Cosine similarity between two of these is `cos(a - b)`, so a test can
 * ask for an exact similarity instead of hoping an embedding model produces one.
 */
function vectorAtAngle(radians: number): number[] {
  const v = Array.from({ length: DIMENSIONS }, () => 0);
  v[0] = Math.cos(radians);
  v[1] = Math.sin(radians);
  return v;
}

const proposal = (a: string, b: string): RelationProposal => ({
  aConditionId: a,
  bConditionId: b,
  relation: 'unrelated',
  rationale: 'no constraint',
  confidence: 0.9,
  model: 'test-model',
  similarity: 0.99,
});

const A = '0xaaa';
const B = '0xbbb';
const C = '0xccc';

describe.skipIf(!canRun)('findCandidatePairs', () => {
  beforeAll(async () => {
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
    await database.execute(sql`
      truncate relation_proposals, relations, relation_group_members, relation_groups,
               market_embeddings, markets, events restart identity cascade
    `);
    await database.insert(events).values([
      { id: 'e1', slug: 'e1', title: 'Event one' },
      { id: 'e2', slug: 'e2', title: 'Event two' },
    ]);
    // A, B, C all in event 1, mutually close: 0.1 rad apart is cos(0.1) ≈ 0.995.
    await database.insert(markets).values(
      [A, B, C].map((id, i) => ({
        conditionId: id,
        eventId: 'e1',
        question: `Question ${i}?`,
        contentHash: `hash-${i}`,
      })),
    );
    await database.insert(marketEmbeddings).values(
      [A, B, C].map((id, i) => ({
        conditionId: id,
        model: 'test',
        contentHash: `hash-${i}`,
        embedding: vectorAtAngle(i * 0.1),
      })),
    );
  });

  it('finds the near-neighbour pairs', async () => {
    const pairs = await findCandidatePairs(database, { threshold: 0.9 });
    expect(pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`).toSorted()).toEqual([
      `${A}/${B}`,
      `${A}/${C}`,
      `${B}/${C}`,
    ]);
  });

  it('honours the similarity floor', async () => {
    // A↔C are 0.2 rad apart: cos(0.2) ≈ 0.980. A floor above that drops them.
    const pairs = await findCandidatePairs(database, { threshold: 0.99 });
    const keys = pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`);
    expect(keys).not.toContain(`${A}/${C}`);
    expect(keys).toContain(`${A}/${B}`);
  });

  it('excludes a pair a deterministic extractor already explains, in either direction', async () => {
    await database.insert(relations).values({
      // Stored high→low deliberately: the anti-join must be direction-blind.
      fromConditionId: B,
      toConditionId: A,
      type: 'implies',
      source: 'ladder',
      confidence: '1',
      rationale: 'ladder',
    });

    const pairs = await findCandidatePairs(database, { threshold: 0.9 });
    expect(pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`)).not.toContain(`${A}/${B}`);
  });

  it('excludes a pair connected only by a CHAIN of deterministic edges', async () => {
    // The case that matters: ladders store adjacent rungs only, so A→C exists
    // as a path (A→B→C) and never as an edge. Testing direct edges alone let
    // 45% of a real 220-pair sample through as "uncovered" — pairs the
    // deterministic layer already implied, billed at one model call each.
    await database.insert(relations).values([
      {
        fromConditionId: A,
        toConditionId: B,
        type: 'implies',
        source: 'ladder',
        confidence: '1',
        rationale: 'rung',
      },
      {
        fromConditionId: B,
        toConditionId: C,
        type: 'implies',
        source: 'ladder',
        confidence: '1',
        rationale: 'rung',
      },
    ]);

    const pairs = await findCandidatePairs(database, { threshold: 0.9 });
    const keys = pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`);
    expect(keys).not.toContain(`${A}/${C}`);
    // And the direct edges stay excluded too.
    expect(keys).not.toContain(`${A}/${B}`);
    expect(keys).not.toContain(`${B}/${C}`);
    expect(pairs).toEqual([]);
  });

  it('excludes a pair that already shares a partition', async () => {
    const [group] = await database
      .insert(relationGroups)
      .values({
        key: 'g1',
        type: 'partition',
        source: 'neg-risk-event',
        confidence: '1',
        rationale: 'negRisk event',
      })
      .returning({ id: relationGroups.id });
    await database.insert(relationGroupMembers).values([
      { groupId: group!.id, conditionId: A },
      { groupId: group!.id, conditionId: B },
    ]);

    const pairs = await findCandidatePairs(database, { threshold: 0.9 });
    expect(pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`)).not.toContain(`${A}/${B}`);
  });

  it('never crosses events when scoped to one', async () => {
    await database.insert(markets).values({
      conditionId: '0xddd',
      eventId: 'e2',
      question: 'Question 3?',
      contentHash: 'hash-3',
    });
    await database.insert(marketEmbeddings).values({
      conditionId: '0xddd',
      model: 'test',
      contentHash: 'hash-3',
      embedding: vectorAtAngle(0.01), // essentially identical to A
    });

    const scoped = await findCandidatePairs(database, { threshold: 0.9 });
    expect(scoped.flatMap((p) => [p.lowConditionId, p.highConditionId])).not.toContain('0xddd');

    const unscoped = await findCandidatePairs(database, { threshold: 0.9, sameEventOnly: false });
    expect(unscoped.flatMap((p) => [p.lowConditionId, p.highConditionId])).toContain('0xddd');
  });

  describe('the re-run guarantee', () => {
    it.each(['accepted', 'rejected', 'skipped'] as const)(
      'never re-proposes a pair whose verdict was %s',
      async (status) => {
        await saveProposals([proposal(A, B)], database);
        const rows = await database.execute<{ id: number }>(
          sql`select id from relation_proposals limit 1`,
        );
        await recordVerdict(
          { proposalId: Number(rows[0]!.id), status, reviewedBy: 'reviewer' },
          database,
        );

        const pairs = await findCandidatePairs(database, { threshold: 0.9 });
        expect(pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`)).not.toContain(
          `${A}/${B}`,
        );
      },
    );

    it('never re-proposes a pair still awaiting review', async () => {
      await saveProposals([proposal(A, B)], database);
      const pairs = await findCandidatePairs(database, { threshold: 0.9 });
      expect(pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`)).not.toContain(`${A}/${B}`);
    });

    it('costs zero calls on a full re-run once every pair has been proposed', async () => {
      const first = await findCandidatePairs(database, { threshold: 0.9 });
      expect(first.length).toBeGreaterThan(0);

      await saveProposals(
        first.map((p) => proposal(p.lowConditionId, p.highConditionId)),
        database,
      );

      // This is the headline claim, reduced to an assertion: nothing left to
      // ask, so nothing to spend.
      expect(await findCandidatePairs(database, { threshold: 0.9 })).toEqual([]);
    });

    it('is direction-blind about which way the pair was originally proposed', async () => {
      // The model saw (B, A); storage canonicalises to (A, B); the anti-join
      // must still recognise it.
      await saveProposals([proposal(B, A)], database);
      const pairs = await findCandidatePairs(database, { threshold: 0.9 });
      expect(pairs.map((p) => `${p.lowConditionId}/${p.highConditionId}`)).not.toContain(`${A}/${B}`);
    });
  });

  describe('ordering', () => {
    it('returns the most similar first by default', async () => {
      const pairs = await findCandidatePairs(database, { threshold: 0.9 });
      const sims = pairs.map((p) => p.similarity);
      expect(sims).toEqual([...sims].toSorted((x, y) => y - x));
    });

    it('draws the same sample twice under `spread`', async () => {
      // Deterministic sampling, so a measured acceptance rate is reproducible.
      const a = await findCandidatePairs(database, { threshold: 0.9, order: 'spread', limit: 2 });
      const b = await findCandidatePairs(database, { threshold: 0.9, order: 'spread', limit: 2 });
      expect(a).toEqual(b);
    });
  });
});
