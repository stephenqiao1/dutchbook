import { describe, expect, it } from 'vitest';

import { screenPrices } from '../../src/coherence/load.js';

/**
 * Which price stage 1 screens with.
 *
 * The fallback is the whole substance here. A market whose shard is
 * disconnected, whose book never seeded, or which is simply one-sided has no
 * live midpoint — and dropping it would quietly shrink the constraint set, so a
 * feed outage would present as the graph getting smaller rather than as an
 * outage. The counts exist so that shrinkage is visible in a log line.
 */

const feedWith = (mids: Record<string, number | null>) => ({
  mid: (tokenId: string) => mids[tokenId] ?? null,
});

const TOKENS = new Map([
  ['A', 'tokA'],
  ['B', 'tokB'],
]);

describe('screenPrices', () => {
  it('prefers the live midpoint over the cached quote', () => {
    const { prices, live, fallback } = screenPrices(
      ['A'],
      new Map([['A', 0.5]]),
      TOKENS,
      feedWith({ tokA: 0.42 }),
    );

    expect(prices.get('A')).toBe(0.42);
    expect({ live, fallback }).toEqual({ live: 1, fallback: 0 });
  });

  it('falls back per market, not wholesale', () => {
    // One dead book must not cost the other market its live price.
    const { prices, live, fallback } = screenPrices(
      ['A', 'B'],
      new Map([
        ['A', 0.5],
        ['B', 0.7],
      ]),
      TOKENS,
      feedWith({ tokA: 0.42, tokB: null }),
    );

    expect([prices.get('A'), prices.get('B')]).toEqual([0.42, 0.7]);
    expect({ live, fallback }).toEqual({ live: 1, fallback: 1 });
  });

  it('falls back for a market with no token mapping', () => {
    const { prices, fallback } = screenPrices(['Z'], new Map([['Z', 0.3]]), TOKENS, feedWith({}));

    expect(prices.get('Z')).toBe(0.3);
    expect(fallback).toBe(1);
  });

  it('omits a market with neither a live book nor a cached quote', () => {
    // Absent, not zero. A missing price makes the constraint unscreenable, which
    // is a different thing from a market priced at nothing.
    const { prices } = screenPrices(['A'], new Map(), TOKENS, feedWith({ tokA: null }));

    expect(prices.has('A')).toBe(false);
  });

  it('uses the cache alone when there is no feed at all', () => {
    const { prices, live, fallback } = screenPrices(['A'], new Map([['A', 0.5]]), null, null);

    expect(prices.get('A')).toBe(0.5);
    expect({ live, fallback }).toEqual({ live: 0, fallback: 1 });
  });

  it('rejects a non-finite live midpoint rather than screening on it', () => {
    const { prices } = screenPrices(
      ['A'],
      new Map([['A', 0.5]]),
      TOKENS,
      feedWith({ tokA: Number.NaN }),
    );

    expect(prices.get('A')).toBe(0.5);
  });
});
