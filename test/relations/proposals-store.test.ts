import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { events, markets, relationProposals, relations } from '../../src/db/schema.js';
import {
  loadPendingProposals,
  proposalPrecision,
  proposalToEdge,
  recordVerdict,
  saveProposals,
} from '../../src/relations/proposals-store.js';
import type { RelationProposal } from '../../src/relations/proposer.js';

/**
 * The one guarantee this whole subsystem exists to provide:
 *
 *   an LLM's output never becomes an edge without a recorded human verdict,
 *   and a verdict once recorded is never quietly overturned.
 *
 * Both halves live in the database — a unique constraint, a conflict clause,
 * and a transaction — so neither can be tested without one.
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
    '\n  SKIPPED test/relations/proposals-store.test.ts — needs Postgres with pgvector.' +
      '\n  Start Docker, or set TEST_DATABASE_URL to a throwaway database.\n',
  );
}

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

/** Ids are ordered so `0xa < 0xb < 0xc`, which is what canonicalisation keys on. */
const A = '0xaaa';
const B = '0xbbb';
const C = '0xccc';

const proposal = (over: Partial<RelationProposal> = {}): RelationProposal => ({
  aConditionId: A,
  bConditionId: B,
  relation: 'implies',
  rationale: 'A entails B.',
  confidence: 0.9,
  model: 'test-model',
  similarity: 0.93,
  ...over,
});

describe.skipIf(!canRun)('relation proposals', () => {
  beforeAll(async () => {
    let url = explicitUrl;
    if (url === undefined) {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      // pgvector, not plain postgres: the migrations create a vector column.
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
    await database.execute(
      sql`truncate relation_proposals, relations, markets, events restart identity cascade`,
    );
    await database.insert(events).values({ id: 'e1', slug: 'e1', title: 'Test event' });
    await database.insert(markets).values(
      [A, B, C].map((id, i) => ({
        conditionId: id,
        eventId: 'e1',
        question: `Question ${i}?`,
        description: `Criteria ${i}.`,
        contentHash: `hash-${i}`,
      })),
    );
  });

  describe('saveProposals', () => {
    it('stores one row per pair, canonically ordered', async () => {
      const result = await saveProposals([proposal()], database);
      expect(result).toMatchObject({ inserted: 1, duplicate: 0 });

      const [row] = await database.select().from(relationProposals);
      expect(row).toMatchObject({
        lowConditionId: A,
        highConditionId: B,
        proposedType: 'implies',
        status: 'pending',
      });
    });

    it('swaps the direction when canonical ordering swaps the pair', async () => {
      // The model was asked about (B, A) and said "A implies B" in its own
      // frame — i.e. B implies A. Storage orders by id, so the stored row must
      // read `implied_by` for the relation to survive the reordering.
      await saveProposals([proposal({ aConditionId: B, bConditionId: A })], database);

      const [row] = await database.select().from(relationProposals);
      expect(row).toMatchObject({
        lowConditionId: A,
        highConditionId: B,
        proposedType: 'implied_by',
      });
    });

    it.each(['complement', 'mutually_exclusive', 'unrelated'] as const)(
      'leaves the symmetric relation %s alone when the pair is swapped',
      async (relation) => {
        await saveProposals(
          [proposal({ aConditionId: B, bConditionId: A, relation })],
          database,
        );
        const [row] = await database.select().from(relationProposals);
        expect(row?.proposedType).toBe(relation);
      },
    );

    it('deduplicates a pair proposed twice within one batch', async () => {
      const result = await saveProposals([proposal(), proposal({ confidence: 0.4 })], database);
      expect(result).toMatchObject({ submitted: 2, inserted: 1 });
    });

    it('drops a self-pair rather than violating the check constraint', async () => {
      const result = await saveProposals([proposal({ bConditionId: A })], database);
      expect(result.inserted).toBe(0);
      expect(await database.select().from(relationProposals)).toHaveLength(0);
    });

    it('NEVER overwrites an existing verdict on a re-run', async () => {
      // This is the idempotency guarantee. A second pipeline run that reached
      // the same pair must not reopen a decision a reviewer already made.
      await saveProposals([proposal()], database);
      const [stored] = await database.select().from(relationProposals);
      await recordVerdict(
        { proposalId: stored!.id, status: 'rejected', reviewedBy: 'reviewer' },
        database,
      );

      const again = await saveProposals(
        [proposal({ relation: 'complement', rationale: 'Different answer this time.' })],
        database,
      );

      expect(again).toMatchObject({ inserted: 0, duplicate: 1 });
      const [after] = await database.select().from(relationProposals);
      expect(after).toMatchObject({
        status: 'rejected',
        proposedType: 'implies',
        rationale: 'A entails B.',
      });
    });
  });

  describe('proposalToEdge', () => {
    const base = { lowConditionId: A, highConditionId: B, rationale: 'r', model: 'm' };

    it('points an `implies` from low to high', () => {
      expect(proposalToEdge({ ...base, proposedType: 'implies' })).toMatchObject({
        fromConditionId: A,
        toConditionId: B,
        type: 'implies',
        source: 'llm_reviewed',
      });
    });

    it('reverses an `implied_by`', () => {
      expect(proposalToEdge({ ...base, proposedType: 'implied_by' })).toMatchObject({
        fromConditionId: B,
        toConditionId: A,
        type: 'implies',
      });
    });

    it('maps `complement` to a complement edge', () => {
      expect(proposalToEdge({ ...base, proposedType: 'complement' })?.type).toBe('complement');
    });

    it.each(['mutually_exclusive', 'unrelated'] as const)('yields no edge for %s', (type) => {
      // Deliberate. Pairwise exclusivity is weaker than a partition, and the
      // `relations` table has no honest encoding for it — inventing one would
      // put a constraint in the graph that a solver would misread.
      expect(proposalToEdge({ ...base, proposedType: type })).toBeNull();
    });
  });

  describe('recordVerdict', () => {
    async function pending(over: Partial<RelationProposal> = {}): Promise<number> {
      await saveProposals([proposal(over)], database);
      const [row] = await database
        .select()
        .from(relationProposals)
        .where(sql`status = 'pending'`);
      return row!.id;
    }

    it('accepting writes the verdict and the edge together', async () => {
      const id = await pending();
      const result = await recordVerdict(
        { proposalId: id, status: 'accepted', reviewedBy: 'reviewer', note: 'checked' },
        database,
      );

      expect(result).toEqual({ applied: true, edgeWritten: true });

      const [row] = await database.select().from(relationProposals);
      expect(row).toMatchObject({ status: 'accepted', reviewedBy: 'reviewer', reviewNote: 'checked' });
      expect(row?.reviewedAt).not.toBeNull();

      const [edge] = await database.select().from(relations);
      expect(edge).toMatchObject({
        fromConditionId: A,
        toConditionId: B,
        type: 'implies',
        source: 'llm_reviewed',
      });
    });

    it('rejecting records the verdict and writes NO edge', async () => {
      const id = await pending();
      const result = await recordVerdict(
        { proposalId: id, status: 'rejected', reviewedBy: 'reviewer' },
        database,
      );

      expect(result).toEqual({ applied: true, edgeWritten: false });
      expect(await database.select().from(relations)).toHaveLength(0);
    });

    it('skipping writes no edge and leaves the pair un-reproposable', async () => {
      const id = await pending();
      await recordVerdict({ proposalId: id, status: 'skipped', reviewedBy: 'reviewer' }, database);
      expect(await database.select().from(relations)).toHaveLength(0);
    });

    it('accepting a `mutually_exclusive` records the verdict but writes no edge', async () => {
      const id = await pending({ relation: 'mutually_exclusive' });
      const result = await recordVerdict(
        { proposalId: id, status: 'accepted', reviewedBy: 'reviewer' },
        database,
      );

      expect(result).toEqual({ applied: true, edgeWritten: false });
      expect(await database.select().from(relations)).toHaveLength(0);
    });

    it('refuses to re-decide a proposal that already has a verdict', async () => {
      const id = await pending();
      await recordVerdict({ proposalId: id, status: 'rejected', reviewedBy: 'first' }, database);

      const second = await recordVerdict(
        { proposalId: id, status: 'accepted', reviewedBy: 'second' },
        database,
      );

      // A rejection is permanent; a second pass must not overturn it, and in
      // particular must not smuggle an edge in behind it.
      expect(second).toEqual({ applied: false, edgeWritten: false });
      expect(await database.select().from(relations)).toHaveLength(0);
      const [row] = await database.select().from(relationProposals);
      expect(row).toMatchObject({ status: 'rejected', reviewedBy: 'first' });
    });

    it('is a no-op for an id that does not exist', async () => {
      expect(
        await recordVerdict({ proposalId: 987_654, status: 'accepted', reviewedBy: 'x' }, database),
      ).toEqual({ applied: false, edgeWritten: false });
    });
  });

  describe('loadPendingProposals', () => {
    it('joins both questions and hides `unrelated` by default', async () => {
      await saveProposals(
        [
          proposal(),
          proposal({ aConditionId: A, bConditionId: C, relation: 'unrelated', confidence: 0.99 }),
        ],
        database,
      );

      const visible = await loadPendingProposals(database);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({
        lowQuestion: 'Question 0?',
        highQuestion: 'Question 1?',
        proposedType: 'implies',
      });

      const all = await loadPendingProposals(database, { includeUnrelated: true });
      expect(all).toHaveLength(2);
    });

    it('shows the most confident proposals first', async () => {
      await saveProposals(
        [
          proposal({ confidence: 0.55 }),
          proposal({ aConditionId: A, bConditionId: C, confidence: 0.98 }),
        ],
        database,
      );

      const rows = await loadPendingProposals(database);
      expect(rows.map((r) => r.modelConfidence)).toEqual([0.98, 0.55]);
    });
  });

  describe('proposalPrecision', () => {
    it('is null before anything is decided', async () => {
      await saveProposals([proposal()], database);
      const stats = await proposalPrecision(database);
      expect(stats).toMatchObject({ pending: 1, precision: null });
    });

    it('counts accepted over decided, excluding skips', async () => {
      await saveProposals(
        [
          proposal(),
          proposal({ aConditionId: A, bConditionId: C }),
          proposal({ aConditionId: B, bConditionId: C }),
        ],
        database,
      );
      const rows = await database.select().from(relationProposals).orderBy(relationProposals.id);

      await recordVerdict({ proposalId: rows[0]!.id, status: 'accepted', reviewedBy: 'r' }, database);
      await recordVerdict({ proposalId: rows[1]!.id, status: 'rejected', reviewedBy: 'r' }, database);
      await recordVerdict({ proposalId: rows[2]!.id, status: 'skipped', reviewedBy: 'r' }, database);

      const stats = await proposalPrecision(database);
      expect(stats).toMatchObject({ accepted: 1, rejected: 1, skipped: 1, precision: 0.5 });
      expect(stats.byType).toEqual([
        { proposedType: 'implies', accepted: 1, rejected: 1, precision: 0.5 },
      ]);
    });
  });
});
