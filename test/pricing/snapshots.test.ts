import { describe, expect, it } from 'vitest';

import { normalizeBook, type OrderBook } from '../../src/polymarket/clob.js';
import { executableCost } from '../../src/pricing/executable.js';
import { bookFromSnapshot, snapshotRow } from '../../src/pricing/snapshots.js';

/**
 * The point of storing depth rather than a midpoint is that a historical row
 * has to re-price exactly like a live book. The round-trip test at the bottom
 * is the one that matters — everything above it is there to make that one
 * trustworthy.
 */

const TS = new Date('2026-08-01T12:00:00.000Z');

function deepBook(levels = 15): OrderBook {
  return normalizeBook({
    asset_id: 'token-1',
    market: '0xcondition',
    timestamp: '1785617461736',
    hash: 'abc123',
    // Worst-first, as the venue sends them.
    bids: Array.from({ length: levels }, (_, i) => ({
      price: (0.4 - (levels - 1 - i) * 0.01).toFixed(3),
      size: String(10 + i),
    })),
    asks: Array.from({ length: levels }, (_, i) => ({
      price: (0.6 + (levels - 1 - i) * 0.01).toFixed(3),
      size: String(10 + i),
    })),
  });
}

describe('snapshotRow', () => {
  it('stores the scalar quotes alongside the depth', () => {
    const row = snapshotRow(deepBook(3), TS)!;

    expect(row.conditionId).toBe('0xcondition');
    expect(row.tokenId).toBe('token-1');
    expect(row.ts).toBe(TS);
    expect(Number(row.bid)).toBeCloseTo(0.4, 8);
    expect(Number(row.ask)).toBeCloseTo(0.6, 8);
    expect(Number(row.mid)).toBeCloseTo(0.5, 8);
    expect(Number(row.spread)).toBeCloseTo(0.2, 8);
  });

  it('keeps depth best-first, matching a live book', () => {
    const row = snapshotRow(deepBook(5), TS)!;

    expect(row.bids!.map((l) => l.price)).toEqual([0.4, 0.39, 0.38, 0.37, 0.36]);
    expect(row.asks!.map((l) => l.price)).toEqual([0.6, 0.61, 0.62, 0.63, 0.64]);
  });

  it('truncates to ten levels per side', () => {
    const row = snapshotRow(deepBook(15), TS)!;
    expect(row.bids).toHaveLength(10);
    expect(row.asks).toHaveLength(10);
  });

  it('counts total depth over the WHOLE book, so truncation is visible', () => {
    // 15 levels sized 10..24 sum to 255. Storing ten levels but reporting the
    // full depth is what tells a later reader the snapshot was truncated.
    const row = snapshotRow(deepBook(15), TS)!;
    const storedBidSize = row.bids!.reduce((sum, l) => sum + l.size, 0);

    expect(Number(row.bidDepth)).toBeCloseTo(255, 6);
    expect(storedBidSize).toBeLessThan(Number(row.bidDepth));
  });

  it('records the venue book time separately from the capture time', () => {
    const row = snapshotRow(deepBook(3), TS)!;
    // The gap between these two is the staleness that makes Gamma unusable;
    // collapsing them would make it unmeasurable.
    expect(row.bookTs).toEqual(new Date(1_785_617_461_736));
    expect(row.ts).toBe(TS);
    expect(row.bookHash).toBe('abc123');
  });

  it('drops a book with no condition id rather than inventing an attribution', () => {
    const orphan = normalizeBook({ asset_id: 'token-1', bids: [{ price: '0.4', size: '1' }] });
    expect(snapshotRow(orphan, TS)).toBeNull();
  });

  it('stores an empty book as empty arrays, not nulls', () => {
    const row = snapshotRow(normalizeBook({ asset_id: 't', market: '0xc' }), TS)!;
    expect(row.bids).toEqual([]);
    expect(row.asks).toEqual([]);
    expect(row.bid).toBeNull();
    expect(row.mid).toBeNull();
    expect(Number(row.bidDepth)).toBe(0);
  });

  it('stores a one-sided book with no midpoint', () => {
    const oneSided = normalizeBook({
      asset_id: 't',
      market: '0xc',
      bids: [{ price: '0.4', size: '10' }],
    });
    const row = snapshotRow(oneSided, TS)!;

    expect(Number(row.bid)).toBeCloseTo(0.4, 8);
    expect(row.ask).toBeNull();
    expect(row.mid).toBeNull();
    expect(row.spread).toBeNull();
    expect(row.asks).toEqual([]);
  });

  it('honours a custom depth', () => {
    const row = snapshotRow(deepBook(15), TS, { depth: 3 })!;
    expect(row.bids).toHaveLength(3);
  });
});

describe('bookFromSnapshot — the reason depth is stored', () => {
  it('re-prices a stored book identically to the live one', () => {
    const live = deepBook(10);
    const row = snapshotRow(live, TS)!;

    const restored = bookFromSnapshot({
      tokenId: row.tokenId,
      conditionId: row.conditionId,
      bids: row.bids ?? null,
      asks: row.asks ?? null,
      bookTs: row.bookTs ?? null,
      bookHash: row.bookHash ?? null,
    });

    // 145 shares spans several levels, so this exercises the walk rather than
    // just the touch.
    const fromLive = executableCost(live, 'buy', 145, { feeRate: 0.05 });
    const fromStored = executableCost(restored, 'buy', 145, { feeRate: 0.05 });

    expect(fromStored.filled).toBe(fromLive.filled);
    expect(fromStored.avgPrice).toBeCloseTo(fromLive.avgPrice!, 10);
    expect(fromStored.fee).toBeCloseTo(fromLive.fee, 10);
    expect(fromStored.totalCost).toBeCloseTo(fromLive.totalCost, 10);
    expect(fromStored.levelsConsumed).toBe(fromLive.levelsConsumed);
  });

  it('a midpoint-only history could not have answered that question', () => {
    // The counterfactual this table exists to defeat: pricing 145 shares at the
    // stored midpoint claims a far better fill than the depth allows.
    const live = deepBook(10);
    const midpoint = 0.5;
    const real = executableCost(live, 'buy', 145, { feeRate: 0 });

    expect(real.avgPrice!).toBeGreaterThan(midpoint);
    expect(real.notional).toBeGreaterThan(145 * midpoint);
  });

  it('reports a partial fill when the stored depth ran out', () => {
    // A truncated snapshot must under-promise, never over-promise: the levels
    // beyond ten are not in the row, so a re-price sees less depth than existed.
    const row = snapshotRow(deepBook(15), TS)!;
    const restored = bookFromSnapshot({
      tokenId: row.tokenId,
      conditionId: row.conditionId,
      bids: row.bids ?? null,
      asks: row.asks ?? null,
      bookTs: null,
      bookHash: null,
    });

    const stored = executableCost(restored, 'buy', 10_000, { feeRate: 0 });
    expect(stored.partial).toBe(true);
    expect(stored.filled).toBeLessThan(Number(row.askDepth));
  });
});
