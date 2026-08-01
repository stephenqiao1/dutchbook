import { describe, expect, it } from 'vitest';

import { basketFor, type Constraint } from '../../src/coherence/constraints.js';
import { priceCorrectingTrade, type BookLookup } from '../../src/coherence/trade.js';
import { normalizeBook, type OrderBook } from '../../src/polymarket/clob.js';
import { executableCost } from '../../src/pricing/executable.js';

/**
 * Turning a violated constraint into a trade, and — the point of the whole
 * exercise — refusing to when the trade does not make money.
 *
 * Most of these are the refusals. A scanner that only tests the happy path
 * reports every midpoint gap as free money; the interesting behaviour here is
 * everything that stops that from happening.
 */

/** A book with one ask level, deep enough not to be the binding constraint. */
function ask(price: number, size = 100_000): OrderBook {
  return normalizeBook({
    asset_id: 'tok',
    bids: [{ price: String(Math.max(0.001, price - 0.01)), size: String(size) }],
    asks: [{ price: String(price), size: String(size) }],
  });
}

function laddered(levels: [number, number][]): OrderBook {
  return normalizeBook({
    asset_id: 'tok',
    bids: [],
    asks: levels.map(([price, size]) => ({ price: String(price), size: String(size) })),
  });
}

/** Books keyed by `conditionId:outcomeIndex`. */
function lookupFor(
  books: Record<string, OrderBook>,
  minOrderSizes: Record<string, number> = {},
): BookLookup {
  return {
    book: (conditionId, outcomeIndex) => books[`${conditionId}:${outcomeIndex}`] ?? null,
    tokenId: (conditionId, outcomeIndex) =>
      books[`${conditionId}:${outcomeIndex}`] === undefined
        ? null
        : `token-${conditionId}-${outcomeIndex}`,
    outcome: (_conditionId, outcomeIndex) => (outcomeIndex === 0 ? 'Yes' : 'No'),
    minOrderSize: (conditionId, outcomeIndex) =>
      minOrderSizes[`${conditionId}:${outcomeIndex}`] ?? null,
  };
}

const impliesConstraint: Constraint = {
  key: 'implies:1',
  kind: 'implies',
  relationIds: [1],
  groupId: null,
  members: [
    { conditionId: 'A', price: 0.7 },
    { conditionId: 'B', price: 0.4 },
  ],
};

const partitionConstraint = (n: number): Constraint => ({
  key: 'partition:9',
  kind: 'partition',
  relationIds: [],
  groupId: '9',
  members: Array.from({ length: n }, (_, i) => ({ conditionId: `M${i}`, price: 0.1 })),
});

const NO_FEE = { feeRate: 0, minSize: 1, minNetProfit: 0, minNetEdge: 0 };

/** Total cost of `size` units of the two-leg basket, for checking break-even. */
function executableCostOfBasket(books: BookLookup, size: number): number {
  let cost = 0;
  for (const [conditionId, outcomeIndex] of [['A', 1], ['B', 0]] as const) {
    const book = books.book(conditionId, outcomeIndex)!;
    cost += executableCost(book, 'buy', size, { feeRate: 0 }).totalCost;
  }
  return cost;
}

describe('a genuinely profitable correction', () => {
  // implies(A,B) violated. Basket is No(A) + Yes(B), payout 1.
  // No(A) at 0.25 and Yes(B) at 0.40 costs 0.65 for a guaranteed 1.
  const books = lookupFor({ 'A:1': ask(0.25), 'B:0': ask(0.4) });

  it('constructs the basket and prices it', () => {
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    expect(trade).not.toBeNull();
    expect(trade!.legs).toHaveLength(2);
    expect(trade!.guaranteedPayout).toBe(1);
    expect(trade!.netEdge).toBeCloseTo(0.35, 8);
  });

  it('buys — never sells — because the venue has no short', () => {
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);
    expect(trade!.legs.every((leg) => leg.side === 'buy')).toBe(true);
    // Selling A is expressed as buying its No leg.
    expect(trade!.legs[0]).toMatchObject({ conditionId: 'A', outcomeIndex: 1, outcome: 'No' });
    expect(trade!.legs[1]).toMatchObject({ conditionId: 'B', outcomeIndex: 0, outcome: 'Yes' });
  });

  it('reports net profit as edge times size', () => {
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);
    expect(trade!.netProfit).toBeCloseTo(trade!.netEdge * trade!.size, 6);
    expect(trade!.totalPayout).toBeCloseTo(trade!.size, 6);
  });

  it('charges fees against the edge', () => {
    const spec = basketFor(impliesConstraint, 'over');
    const free = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE).trade!;
    const paid = priceCorrectingTrade(impliesConstraint, 'over', spec, books, {
      feeRate: 0.07,
      minSize: 1,
    }).trade!;

    expect(paid.netEdge).toBeLessThan(free.netEdge);
    expect(paid.totalFees).toBeGreaterThan(0);
    expect(paid.grossEdge).toBeGreaterThan(paid.netEdge);
  });
});

describe('the refusals — why a screened violation is only apparent', () => {
  it('refuses when the spread has already eaten the gap', () => {
    // Screen saw P(A)=0.7 > P(B)=0.4 on midpoints. But No(A) asks 0.55 and
    // Yes(B) asks 0.50: the basket costs 1.05 for a guaranteed 1.
    const books = lookupFor({ 'A:1': ask(0.55), 'B:0': ask(0.5) });
    const spec = basketFor(impliesConstraint, 'over');

    const result = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    expect(result.trade).toBeNull();
    expect(result.failure).toBe('negative-edge');
    expect(result.reason).toContain('spread and fees');
    expect(result.maxSize).toBe(0);
  });

  it('refuses when fees alone flip a thin edge negative', () => {
    // Costs 0.98 for a guaranteed 1: 2¢ gross, which a 7% fee erases.
    const books = lookupFor({ 'A:1': ask(0.5), 'B:0': ask(0.48) });
    const spec = basketFor(impliesConstraint, 'over');

    expect(priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE).trade).not.toBeNull();
    const withFees = priceCorrectingTrade(impliesConstraint, 'over', spec, books, {
      feeRate: 0.07,
      minSize: 1,
    });
    expect(withFees.trade).toBeNull();
    expect(withFees.failure).toBe('negative-edge');
  });

  it('refuses when a leg has no book at all', () => {
    const books = lookupFor({ 'A:1': ask(0.25) });
    const spec = basketFor(impliesConstraint, 'over');
    const result = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    expect(result.failure).toBe('missing-token');
    expect(result.reason).toContain('B');
  });

  it('refuses when a leg has nothing offered', () => {
    const empty = normalizeBook({ asset_id: 'tok', bids: [{ price: '0.4', size: '10' }], asks: [] });
    const books = lookupFor({ 'A:1': ask(0.25), 'B:0': empty });
    const spec = basketFor(impliesConstraint, 'over');
    const result = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    expect(result.failure).toBe('empty-book');
    expect(result.reason).toContain('cannot be bought');
  });

  it('refuses when the whole edge is smaller than the venue minimum order', () => {
    // Only 3 shares of No(A) exist at any price, so the basket caps at 3 —
    // profitable, but under the 15-share minimum this market will accept. The
    // edge is real and untradeable, which is a different fact from no edge.
    const books = lookupFor(
      { 'A:1': laddered([[0.25, 3]]), 'B:0': ask(0.4) },
      { 'A:1': 15 },
    );
    const spec = basketFor(impliesConstraint, 'over');

    const result = priceCorrectingTrade(impliesConstraint, 'over', spec, books, {
      feeRate: 0,
      minSize: 1,
    });

    expect(result.trade).toBeNull();
    expect(result.failure).toBe('below-min-size');
    expect(result.reason).toContain('minimum order size');
  });

  it('reports negative-edge, not below-min-size, when the basket loses at the minimum', () => {
    // The distinction the fee-rounding threshold used to blur: below ~1e-5
    // USDC the venue rounds a fee to zero, so an infinitesimal basket looks
    // free. Probing at the minimum tradeable size instead makes the reported
    // reason match the truth.
    const books = lookupFor({ 'A:1': ask(0.5), 'B:0': ask(0.48) });
    const spec = basketFor(impliesConstraint, 'over');

    const result = priceCorrectingTrade(impliesConstraint, 'over', spec, books, {
      feeRate: 0.07,
      minSize: 5,
    });

    expect(result.failure).toBe('negative-edge');
    expect(result.reason).toContain('exceed the mispricing');
  });
});

describe('the thinnest leg caps the whole basket', () => {
  it('sizes to the leg that runs out first', () => {
    // No(A) has 40 shares, Yes(B) has 100_000. The basket cannot exceed 40.
    const books = lookupFor({ 'A:1': ask(0.25, 40), 'B:0': ask(0.4) });
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    expect(trade!.size).toBeCloseTo(40, 6);
    expect(trade!.legs.every((leg) => leg.size === trade!.size)).toBe(true);
  });

  it('NEVER returns a basket where a leg filled short', () => {
    // A partially-filled basket is not three quarters of an arbitrage — it is
    // an unhedged directional bet the checker never intended to take.
    const books = lookupFor({ 'A:1': ask(0.25, 40), 'B:0': ask(0.4, 100) });
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    const sizes = new Set(trade!.legs.map((leg) => leg.size));
    expect(sizes.size).toBe(1);
    expect(trade!.size).toBeLessThanOrEqual(40);
  });
});

describe('max executable size before the edge goes to zero', () => {
  it('stops where the ladder makes the basket break even', () => {
    // No(A): 100 @ 0.20, then unlimited @ 0.70. Yes(B): flat 0.40.
    // For N <= 100 the basket costs 0.60N and pays N.
    // Past 100, cost = 20 + 0.70(N-100) + 0.40N = 1.10N - 50, so profit is
    // N - (1.10N - 50) = 50 - 0.10N, which reaches zero at N = 500.
    const books = lookupFor({
      'A:1': laddered([[0.2, 100], [0.7, 1_000_000]]),
      'B:0': ask(0.4),
    });
    const spec = basketFor(impliesConstraint, 'over');
    const { trade, maxSize } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    expect(maxSize).toBeCloseTo(500, 2);

    // The trade is sized for maximum PROFIT, not maximum reach. All 100 cheap
    // shares and none of the dear ones: 100 units at 0.60 for a payout of 100.
    // Pricing at maxSize instead would report this real mispricing as a $0.00
    // opportunity — which is exactly what the first live run of this checker
    // did, confirming five violations all worth exactly nothing.
    expect(trade!.size).toBeCloseTo(100, 1);
    expect(trade!.netEdge).toBeCloseTo(0.4, 2);
    expect(trade!.netProfit).toBeCloseTo(40, 1);
    expect(trade!.maxExecutableSize).toBeCloseTo(500, 2);
  });

  it('profit at the max executable size is approximately zero', () => {
    // The definition of the number, stated as a test so nobody re-reads it as
    // "the size you should trade".
    const books = lookupFor({
      'A:1': laddered([[0.2, 100], [0.7, 1_000_000]]),
      'B:0': ask(0.4),
    });
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    const atMax = executableCostOfBasket(books, trade!.maxExecutableSize);
    expect(trade!.maxExecutableSize - atMax).toBeCloseTo(0, 3);
    expect(trade!.netProfit).toBeGreaterThan(atMax === 0 ? -1 : 0);
  });

  it('refuses a mispricing too thin to be worth taking', () => {
    // 2¢ gross on a book only 10 shares deep is 20¢ of profit. Real, and not
    // worth an order. Without a materiality floor every screened violation
    // confirms, because a break-even size always exists.
    const books = lookupFor({ 'A:1': ask(0.5, 10), 'B:0': ask(0.48, 10) });
    const spec = basketFor(impliesConstraint, 'over');

    const result = priceCorrectingTrade(impliesConstraint, 'over', spec, books, {
      feeRate: 0,
      minSize: 1,
      minNetProfit: 1,
    });

    expect(result.trade).toBeNull();
    expect(result.failure).toBe('immaterial-edge');
    expect(result.reason).toContain('too thin to be worth taking');
  });

  it('takes the whole book when every unit is profitable', () => {
    const books = lookupFor({ 'A:1': ask(0.25, 500), 'B:0': ask(0.4, 500) });
    const spec = basketFor(impliesConstraint, 'over');
    const { maxSize } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);
    expect(maxSize).toBeCloseTo(500, 6);
  });
});

describe('partition corrections', () => {
  it('underpriced: buying every Yes for less than 1', () => {
    // Three members at 0.30 each: 0.90 for a guaranteed 1.
    const constraint = partitionConstraint(3);
    const books = lookupFor({ 'M0:0': ask(0.3), 'M1:0': ask(0.3), 'M2:0': ask(0.3) });
    const spec = basketFor(constraint, 'under');
    const { trade } = priceCorrectingTrade(constraint, 'under', spec, books, NO_FEE);

    expect(trade!.legs).toHaveLength(3);
    expect(trade!.guaranteedPayout).toBe(1);
    expect(trade!.netEdge).toBeCloseTo(0.1, 8);
  });

  it('overpriced: buying every No, where n-1 of them pay', () => {
    // Five members whose Nos cost 0.75 each: 3.75 for a guaranteed 4.
    // Scoring this against a payout of 1 instead of n-1 would reject it.
    const constraint = partitionConstraint(5);
    const books = lookupFor(
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`M${i}:1`, ask(0.75)])),
    );
    const spec = basketFor(constraint, 'over');
    const { trade } = priceCorrectingTrade(constraint, 'over', spec, books, NO_FEE);

    expect(trade!.guaranteedPayout).toBe(4);
    expect(trade!.totalCost).toBeCloseTo(3.75 * trade!.size, 4);
    expect(trade!.netEdge).toBeCloseTo(0.25, 6);
  });

  it('a whole partition is refused when one member cannot be bought', () => {
    const constraint = partitionConstraint(3);
    const books = lookupFor({ 'M0:0': ask(0.3), 'M1:0': ask(0.3) });
    const spec = basketFor(constraint, 'under');
    const result = priceCorrectingTrade(constraint, 'under', spec, books, NO_FEE);

    expect(result.trade).toBeNull();
    expect(result.failure).toBe('missing-token');
  });
});

describe('the trade reads as instructions', () => {
  it('carries token ids, outcome labels, sizes and prices for every leg', () => {
    const books = lookupFor({ 'A:1': ask(0.25), 'B:0': ask(0.4) });
    const spec = basketFor(impliesConstraint, 'over');
    const { trade } = priceCorrectingTrade(impliesConstraint, 'over', spec, books, NO_FEE);

    for (const leg of trade!.legs) {
      expect(leg.tokenId).toMatch(/^token-/);
      expect(leg.outcome).toBeTruthy();
      expect(leg.size).toBeGreaterThan(0);
      expect(leg.avgPrice).toBeGreaterThan(0);
      expect(leg.touchPrice).toBeGreaterThan(0);
      expect(leg.availableDepth).toBeGreaterThan(0);
    }
    expect(trade!.summary).toContain('buy');
    expect(trade!.summary).toContain('pays at least');
  });
});
