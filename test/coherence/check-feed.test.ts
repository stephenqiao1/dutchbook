import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';

import { runCoherenceCheck } from '../../src/coherence/check.js';
import type * as schema from '../../src/db/schema.js';
import { ClobClient } from '../../src/polymarket/clob.js';

/**
 * Stage 1 reading the live feed instead of the quote cache.
 *
 * The case that matters is the one that motivated wiring it through at all: a
 * check *triggered by the feed* must screen on the same prices the feed saw. If
 * it re-screens on cached Gamma quotes, it can look at the very constraint that
 * caused the trigger, find the stale quote still satisfying it, and conclude
 * nothing is wrong — turning every trigger into work that reliably finds
 * nothing.
 */

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Answers the four reads a check performs. `select` is shared between the quote
 * cache, the token mapping and the stage-2 market lookup, so the rows carry
 * every column all three ask for and each takes what it needs.
 */
function fakeDatabase(): Database {
  let call = 0;
  const rows = [
    { conditionId: 'A', yesPrice: '0.40', clobTokenIds: ['tokA', 'tokA2'], outcomes: ['Yes', 'No'] },
    { conditionId: 'B', yesPrice: '0.60', clobTokenIds: ['tokB', 'tokB2'], outcomes: ['Yes', 'No'] },
  ];

  return {
    execute: () => {
      call += 1;
      return Promise.resolve(
        call % 2 === 1
          ? [{ id: 1, from_condition_id: 'A', to_condition_id: 'B', type: 'implies', rationale: null }]
          : [],
      );
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Database;
}

/** A CLOB that knows no books, so stage 2 always declines. Stage 1 is the subject. */
function emptyClob(): ClobClient {
  let clock = 0;
  return new ClobClient({
    now: () => clock,
    random: () => 0,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    logger: { debug: () => {}, warn: () => {} },
    fetch: () =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })),
  });
}

const run = (feed?: { mid: (t: string) => number | null }) =>
  runCoherenceCheck(fakeDatabase(), {
    skipQuoteRefresh: true,
    snapshot: false,
    clob: emptyClob(),
    epsilon: 0.005,
    ...(feed === undefined ? {} : { feed }),
  });

describe('stage 1 price source', () => {
  it('screens satisfied on the cached quotes alone', async () => {
    // 0.40 <= 0.60. The entailment holds, as far as Gamma knows.
    const result = await run();
    expect(result.screened).toMatchObject({ evaluated: 1, violated: 0 });
  });

  it('finds the violation the cached quote is too stale to show', async () => {
    // The live book has A at 0.90 while the cache still says 0.40. This is the
    // whole point: the feed sees it, so a check driven by the feed must too.
    const result = await run({ mid: (token) => (token === 'tokA' ? 0.9 : 0.6) });
    expect(result.screened).toMatchObject({ evaluated: 1, violated: 1 });
  });

  it('falls back to the cache for a market with no live book', async () => {
    // Only B has a book. A is priced from the cache at 0.40, so the constraint
    // is still screenable rather than silently dropped.
    const result = await run({ mid: (token) => (token === 'tokB' ? 0.6 : null) });
    expect(result.screened).toMatchObject({ evaluated: 1, violated: 0, unscreenable: 0 });
  });

  it('does not confirm on a midpoint alone', async () => {
    // Stage 1 raises a hypothesis; with no depth to price a basket, stage 2
    // declines it. A midpoint is never enough to call something executable.
    const result = await run({ mid: (token) => (token === 'tokA' ? 0.9 : 0.6) });
    expect(result.confirmed).toBe(0);
    expect(result.confirmations[0]).toMatchObject({ status: 'apparent' });
  });
});
