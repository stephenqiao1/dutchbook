import { describe, expect, it } from 'vitest';

import type { BookLevel } from '../../src/polymarket/clob.js';
import { DEFAULT_TAKER_FEE_RATE, takerFee } from '../../src/pricing/costs.js';
import {
  availableDepth,
  executableCost,
  maxSizeWithinSlippage,
} from '../../src/pricing/executable.js';

/**
 * The book walker exists to stop one specific mistake: quoting the top of book
 * as the price of a whole order. Every case below is a book where that mistake
 * gives a confidently wrong answer, so the assertions are mostly about the
 * difference between the touch and what the order really costs.
 *
 * Books are constructed already-normalised — bids descending, asks ascending —
 * because that is the invariant the client guarantees at the boundary. The
 * wire-order hazard is tested in `clob.test.ts`, where it belongs.
 */

const book = (bids: BookLevel[], asks: BookLevel[]): { bids: BookLevel[]; asks: BookLevel[] } => ({
  bids,
  asks,
});

/** No fees, so a test can assert on raw book arithmetic. */
const NO_FEE = { feeRate: 0 };

describe('executableCost — thin book, partial fill', () => {
  // 30 shares at 24¢, then 20 at 41¢. Total depth 50. Asking for 500.
  const thin = book([], [
    { price: 0.24, size: 30 },
    { price: 0.41, size: 20 },
  ]);

  it('fills only what is there and says so', () => {
    const cost = executableCost(thin, 'buy', 500, NO_FEE);

    expect(cost.filled).toBe(50);
    expect(cost.unfilled).toBe(450);
    expect(cost.partial).toBe(true);
    expect(cost.levelsConsumed).toBe(2);
  });

  it('averages across levels rather than quoting the touch', () => {
    const cost = executableCost(thin, 'buy', 500, NO_FEE);

    // (30 × 0.24) + (20 × 0.41) = 7.20 + 8.20 = 15.40 over 50 shares.
    expect(cost.notional).toBeCloseTo(15.4, 10);
    expect(cost.avgPrice).toBeCloseTo(0.308, 10);
    // Quoting the touch would have said 0.24 — 28% too cheap.
    expect(cost.avgPrice!).toBeGreaterThan(thin.asks[0]!.price);
    expect(cost.worstPrice).toBe(0.41);
  });

  it('reports slippage against the touch', () => {
    const cost = executableCost(thin, 'buy', 500, NO_FEE);
    // (0.308 - 0.24) / 0.24
    expect(cost.slippage).toBeCloseTo(0.283333333, 8);
  });

  it('does not slip when the first level absorbs the order', () => {
    const cost = executableCost(thin, 'buy', 10, NO_FEE);
    expect(cost.filled).toBe(10);
    expect(cost.avgPrice).toBeCloseTo(0.24, 10);
    expect(cost.slippage).toBeCloseTo(0, 10);
    expect(cost.partial).toBe(false);
    expect(cost.levelsConsumed).toBe(1);
  });

  it('takes a partial slice of a level rather than the whole level', () => {
    const cost = executableCost(thin, 'buy', 40, NO_FEE);
    // 30 @ 0.24 + 10 @ 0.41 = 7.2 + 4.1
    expect(cost.filled).toBe(40);
    expect(cost.notional).toBeCloseTo(11.3, 10);
    expect(cost.partial).toBe(false);
  });
});

describe('executableCost — wide spread', () => {
  // 20¢ bid against an 80¢ ask: the midpoint is 50¢ and nobody can trade there.
  const wide = book([{ price: 0.2, size: 1000 }], [{ price: 0.8, size: 1000 }]);

  it('buys at the ask, not the midpoint', () => {
    const cost = executableCost(wide, 'buy', 100, NO_FEE);
    expect(cost.avgPrice).toBeCloseTo(0.8, 10);
    expect(cost.notional).toBeCloseTo(80, 10);
  });

  it('sells at the bid, not the midpoint', () => {
    const cost = executableCost(wide, 'sell', 100, NO_FEE);
    expect(cost.avgPrice).toBeCloseTo(0.2, 10);
    expect(cost.notional).toBeCloseTo(20, 10);
  });

  it('reports zero slippage, because slippage is measured against the touch', () => {
    // The spread is enormous but the *fill* is exactly at the touch. Measuring
    // slippage against the midpoint would report 60% here and make a
    // perfectly-filled order look like a disaster.
    expect(executableCost(wide, 'buy', 100, NO_FEE).slippage).toBeCloseTo(0, 10);
    expect(executableCost(wide, 'sell', 100, NO_FEE).slippage).toBeCloseTo(0, 10);
  });

  it('round-tripping a share across the spread loses the spread', () => {
    const bought = executableCost(wide, 'buy', 100, NO_FEE);
    const sold = executableCost(wide, 'sell', 100, NO_FEE);
    expect(bought.notional - sold.notional).toBeCloseTo(60, 10);
  });
});

describe('executableCost — one-sided book', () => {
  const bidsOnly = book([{ price: 0.35, size: 500 }], []);
  const asksOnly = book([], [{ price: 0.65, size: 500 }]);

  it('cannot buy when there are no asks', () => {
    const cost = executableCost(bidsOnly, 'buy', 100);
    expect(cost.filled).toBe(0);
    expect(cost.unfilled).toBe(100);
    expect(cost.avgPrice).toBeNull();
    expect(cost.effectivePrice).toBeNull();
    expect(cost.slippage).toBeNull();
    // Nothing was requested that could fill, so this is not a "partial" fill of
    // an order that was going to work — it is a total failure to fill.
    expect(cost.notional).toBe(0);
  });

  it('can still sell into the bids', () => {
    const cost = executableCost(bidsOnly, 'sell', 100, NO_FEE);
    expect(cost.filled).toBe(100);
    expect(cost.avgPrice).toBeCloseTo(0.35, 10);
  });

  it('cannot sell when there are no bids', () => {
    const cost = executableCost(asksOnly, 'sell', 100);
    expect(cost.filled).toBe(0);
    expect(cost.avgPrice).toBeNull();
  });

  it('can still buy into the asks', () => {
    const cost = executableCost(asksOnly, 'buy', 100, NO_FEE);
    expect(cost.filled).toBe(100);
    expect(cost.avgPrice).toBeCloseTo(0.65, 10);
  });
});

describe('executableCost — empty book', () => {
  const empty = book([], []);

  it.each(['buy', 'sell'] as const)('fills nothing on a %s', (side) => {
    const cost = executableCost(empty, side, 500);
    expect(cost.filled).toBe(0);
    expect(cost.unfilled).toBe(500);
    expect(cost.avgPrice).toBeNull();
    expect(cost.slippage).toBeNull();
    expect(cost.fee).toBe(0);
    expect(cost.totalCost).toBe(0);
    expect(cost.levelsConsumed).toBe(0);
  });

  it('returns a zero fill rather than throwing', () => {
    // Total, not partial: this runs inside a sweep over thousands of markets,
    // and a throw here stops the sweep.
    expect(() => executableCost(empty, 'buy', 1)).not.toThrow();
  });
});

describe('executableCost — degenerate requests', () => {
  const deep = book([{ price: 0.5, size: 1000 }], [{ price: 0.5, size: 1000 }]);

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('returns nothing for size %p', (size) => {
    const cost = executableCost(deep, 'buy', size);
    expect(cost.filled).toBe(0);
    expect(cost.avgPrice).toBeNull();
  });

  it('never reports a negative unfilled amount', () => {
    expect(executableCost(deep, 'buy', 10).unfilled).toBe(0);
  });
});

describe('executableCost — fees', () => {
  const flat = book([{ price: 0.5, size: 1000 }], [{ price: 0.5, size: 1000 }]);

  it('charges the documented formula: shares × rate × p × (1 - p)', () => {
    const cost = executableCost(flat, 'buy', 100, { feeRate: 0.05 });
    // 100 × 0.05 × 0.5 × 0.5 = 1.25 USDC
    expect(cost.fee).toBeCloseTo(1.25, 10);
    expect(cost.notional).toBeCloseTo(50, 10);
    expect(cost.totalCost).toBeCloseTo(51.25, 10);
    expect(cost.effectivePrice).toBeCloseTo(0.5125, 10);
  });

  it('works against the taker on both sides', () => {
    const bought = executableCost(flat, 'buy', 100, { feeRate: 0.05 });
    const sold = executableCost(flat, 'sell', 100, { feeRate: 0.05 });

    // A buyer pays more than notional; a seller receives less.
    expect(bought.totalCost).toBeGreaterThan(bought.notional);
    expect(sold.totalCost).toBeLessThan(sold.notional);
    expect(bought.fee).toBeCloseTo(sold.fee, 10);
  });

  it('is symmetric about 0.5 in dollar terms', () => {
    const cheap = book([], [{ price: 0.3, size: 1000 }]);
    const dear = book([], [{ price: 0.7, size: 1000 }]);
    expect(executableCost(cheap, 'buy', 100, { feeRate: 0.05 }).fee).toBeCloseTo(
      executableCost(dear, 'buy', 100, { feeRate: 0.05 }).fee,
      10,
    );
  });

  it('accumulates per level, not once at the average price', () => {
    // p(1-p) is concave, so charging the fee once at the average understates
    // it. This book spans 0.1 to 0.9, where the gap is largest.
    const spread = book([], [
      { price: 0.1, size: 100 },
      { price: 0.9, size: 100 },
    ]);
    const cost = executableCost(spread, 'buy', 200, { feeRate: 0.05 });

    const perLevel = takerFee(100, 0.1, 0.05) + takerFee(100, 0.9, 0.05);
    const atAverage = takerFee(200, 0.5, 0.05);

    expect(cost.fee).toBeCloseTo(perLevel, 10);
    expect(cost.fee).toBeLessThan(atAverage);
  });

  it('defaults to the conservative rate when none is given', () => {
    const cost = executableCost(flat, 'buy', 100);
    expect(cost.fee).toBeCloseTo(100 * DEFAULT_TAKER_FEE_RATE * 0.25, 10);
  });
});

describe('executableCost — limit price', () => {
  const laddered = book([], [
    { price: 0.2, size: 50 },
    { price: 0.3, size: 50 },
    { price: 0.9, size: 1000 },
  ]);

  it('stops at the limit and reports the rest as unfilled', () => {
    const cost = executableCost(laddered, 'buy', 500, { ...NO_FEE, limitPrice: 0.3 });
    expect(cost.filled).toBe(100);
    expect(cost.unfilled).toBe(400);
    expect(cost.worstPrice).toBe(0.3);
    expect(cost.partial).toBe(true);
  });

  it('fills nothing when the limit is below the touch', () => {
    const cost = executableCost(laddered, 'buy', 500, { ...NO_FEE, limitPrice: 0.1 });
    expect(cost.filled).toBe(0);
  });

  it('applies in the opposite direction for a sell', () => {
    const bids = book(
      [
        { price: 0.8, size: 50 },
        { price: 0.7, size: 50 },
        { price: 0.1, size: 1000 },
      ],
      [],
    );
    const cost = executableCost(bids, 'sell', 500, { ...NO_FEE, limitPrice: 0.7 });
    expect(cost.filled).toBe(100);
    expect(cost.worstPrice).toBe(0.7);
  });
});

describe('availableDepth', () => {
  const deep = book(
    [
      { price: 0.4, size: 10 },
      { price: 0.3, size: 20 },
    ],
    [
      { price: 0.6, size: 5 },
      { price: 0.7, size: 15 },
    ],
  );

  it('sums the side an order would consume', () => {
    expect(availableDepth(deep, 'buy')).toBe(20);
    expect(availableDepth(deep, 'sell')).toBe(30);
  });

  it('respects a limit price', () => {
    expect(availableDepth(deep, 'buy', 0.6)).toBe(5);
    expect(availableDepth(deep, 'sell', 0.4)).toBe(10);
  });

  it('is zero on an empty side', () => {
    expect(availableDepth(book([], []), 'buy')).toBe(0);
  });
});

describe('maxSizeWithinSlippage', () => {
  const laddered = book([], [
    { price: 0.5, size: 100 },
    { price: 1.0, size: 100 },
  ]);

  it('returns the whole book when it all fits within the budget', () => {
    expect(maxSizeWithinSlippage(laddered, 'buy', 10, NO_FEE)).toBeCloseTo(200, 6);
  });

  it('stops at the first level when the next one blows the budget', () => {
    // Any share taken at 1.0 immediately drags the average above 0.5.
    expect(maxSizeWithinSlippage(laddered, 'buy', 0, NO_FEE)).toBeCloseTo(100, 6);
  });

  it('finds a boundary inside a level', () => {
    // 10% slippage on a 0.5 touch means an average of 0.55.
    // 100 @ 0.5 plus x @ 1.0 averages 0.55 when x = 100/9 ≈ 11.11.
    const size = maxSizeWithinSlippage(laddered, 'buy', 0.1, NO_FEE);
    expect(size).toBeCloseTo(111.111111, 4);

    const cost = executableCost(laddered, 'buy', size, NO_FEE);
    expect(cost.slippage!).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('is zero on an empty book', () => {
    expect(maxSizeWithinSlippage(book([], []), 'buy', 0.5)).toBe(0);
  });
});
