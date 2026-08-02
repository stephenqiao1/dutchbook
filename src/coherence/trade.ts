import type { OrderBook } from '../polymarket/clob.js';
import { DEFAULT_TAKER_FEE_RATE, FALLBACK_MIN_ORDER_SIZE } from '../pricing/costs.js';
import { availableDepth, executableCost } from '../pricing/executable.js';
import type { BasketSpec, Constraint, Direction } from './constraints.js';

/**
 * Turning a violated constraint into a concrete trade, and finding out whether
 * it is worth doing.
 *
 * The rule this module exists to enforce: **an incomplete basket is not an
 * arbitrage.** Every leg has to fill in full at the same size, because the
 * guaranteed payout is a property of the whole basket. Filling three legs of a
 * four-leg partition does not leave you with three quarters of a risk-free
 * profit; it leaves you with an unhedged directional bet that the checker never
 * intended to take. So a leg that cannot fill kills the size rather than
 * reducing the profit.
 *
 * Pure: books in, trade out. No I/O, no clock.
 */

export interface TradeLeg {
  readonly conditionId: string;
  readonly tokenId: string;
  /** Index into `markets.outcomes` — 0 is the outcome relations are written about. */
  readonly outcomeIndex: 0 | 1;
  /** The outcome's label, e.g. `Yes`, `No`, `Over`, `Kings`. For reading by hand. */
  readonly outcome: string | null;
  /** Always `buy`: Polymarket has no short, so selling Yes means buying No. */
  readonly side: 'buy';
  readonly size: number;
  readonly avgPrice: number;
  readonly notional: number;
  readonly fee: number;
  readonly cost: number;
  /** Best price on the side being taken, for comparison with the fill. */
  readonly touchPrice: number | null;
  readonly slippage: number | null;
  readonly levelsConsumed: number;
  /** Total shares resting on the side this leg takes from. */
  readonly availableDepth: number;
}

export interface CorrectingTrade {
  readonly constraintKey: string;
  readonly kind: Constraint['kind'];
  readonly direction: Direction;
  /** Human-readable statement of what is being done and why it is riskless. */
  readonly summary: string;
  readonly legs: readonly TradeLeg[];
  /**
   * Units of the basket, chosen to maximise total net profit — not the largest
   * profitable size, which by definition earns nothing.
   */
  readonly size: number;
  /**
   * The largest size at which average net edge is still positive: the brief's
   * "max executable size before edge goes to zero". Always >= {@link size},
   * and the profit there is approximately zero.
   */
  readonly maxExecutableSize: number;
  /** USDC one unit pays in the worst state the constraint permits. */
  readonly guaranteedPayout: number;
  /** `size × guaranteedPayout` — the minimum the basket returns at resolution. */
  readonly totalPayout: number;
  readonly totalNotional: number;
  readonly totalFees: number;
  readonly totalCost: number;
  /** Payout − notional, per unit. What a scanner that ignores fees would report. */
  readonly grossEdge: number;
  /** Payout − cost, per unit. What is actually left after fees and slippage. */
  readonly netEdge: number;
  /** `netEdge × size`. The dollars on the table. */
  readonly netProfit: number;
  /** Return on capital deployed. */
  readonly returnOnCost: number;
}

export interface BookLookup {
  /** The order book for a market's outcome leg, or null when unavailable. */
  book(conditionId: string, outcomeIndex: 0 | 1): OrderBook | null;
  tokenId(conditionId: string, outcomeIndex: 0 | 1): string | null;
  outcome(conditionId: string, outcomeIndex: 0 | 1): string | null;
  /** Venue minimum order size for the leg, when known. */
  minOrderSize?(conditionId: string, outcomeIndex: 0 | 1): number | null;
}

export interface PriceTradeOptions {
  readonly feeRate?: number;
  /** Below this many shares a trade is not worth recording. Default 5. */
  readonly minSize?: number;
  /**
   * Net profit, in USDC, below which a violation stays `apparent`.
   *
   * The brief's "positive net edge at a meaningful size" needs a definition of
   * meaningful, and zero is not it: the break-even size always exists whenever
   * the touch is mispriced at all, so without a floor every screened violation
   * would confirm at $0.00. Default $1 — small enough not to hide real
   * opportunities, large enough to exclude rounding.
   */
  readonly minNetProfit?: number;
  /** Net edge per unit below which a violation stays `apparent`. Default 0.5¢. */
  readonly minNetEdge?: number;
}

export type TradeFailure =
  | 'immaterial-edge'
  | 'missing-book'
  | 'missing-token'
  | 'empty-book'
  | 'insufficient-depth'
  | 'below-min-size'
  | 'negative-edge';

export interface TradeAttempt {
  readonly trade: CorrectingTrade | null;
  /** Why no trade was constructed. Null on success. */
  readonly failure: TradeFailure | null;
  /** Prose for the violation record, so an `apparent` row explains itself. */
  readonly reason: string | null;
  /**
   * The largest size at which net edge stays positive, before the min-size and
   * profitability gates. Zero when the basket is never profitable.
   */
  readonly maxSize: number;
}

/**
 * The most any single leg can absorb, which caps the whole basket.
 *
 * Every leg buys the *same* number of units, so the basket is bounded by its
 * thinnest leg. This is usually the binding constraint on a real opportunity:
 * the mispricing is often in the least liquid member of a partition, which is
 * exactly the member that cannot fill.
 */
function basketDepth(spec: BasketSpec, books: BookLookup): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (const leg of spec.legs) {
    const book = books.book(leg.conditionId, leg.outcomeIndex);
    if (book === null) return 0;
    smallest = Math.min(smallest, availableDepth(book, 'buy'));
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

/** Cost of `size` units of the basket, or null when any leg cannot fill it. */
function basketCost(
  spec: BasketSpec,
  books: BookLookup,
  size: number,
  feeRate: number,
): { cost: number; notional: number; fees: number } | null {
  let cost = 0;
  let notional = 0;
  let fees = 0;

  for (const leg of spec.legs) {
    const book = books.book(leg.conditionId, leg.outcomeIndex);
    if (book === null) return null;

    const filled = executableCost(book, 'buy', size, { feeRate });
    // Partial is fatal, not merely worse: see the module note.
    if (filled.filled < size - 1e-9) return null;

    cost += filled.totalCost;
    notional += filled.notional;
    fees += filled.fee;
  }

  return { cost, notional, fees };
}

/**
 * The largest basket size whose net edge is still positive.
 *
 * Net edge per unit is non-increasing in size — each additional unit is filled
 * at a price no better than the last on every leg — so the profitable region is
 * a prefix and bisection is sound. Sixty iterations is far more than the
 * precision of a share count needs; it costs nothing and removes any question
 * about convergence.
 */
function maxProfitableSize(
  spec: BasketSpec,
  books: BookLookup,
  feeRate: number,
  ceiling: number,
  floor: number,
): number {
  const profitableAt = (size: number): boolean => {
    if (size <= 0) return false;
    const priced = basketCost(spec, books, size, feeRate);
    if (priced === null) return false;
    return size * spec.guaranteedPayout - priced.cost > 0;
  };

  // Probe at the smallest *tradeable* size, not at an infinitesimal one.
  //
  // The venue rounds any fee below 0.00001 USDC to zero, so at a size of 1e-6
  // the fee vanishes and almost any basket looks profitable. Bisecting from
  // there converges on a microscopic "profitable" region that exists only
  // because of that rounding, and the caller then reports the honest failure
  // ("no profitable size") as the misleading one ("profitable, but below the
  // minimum order size"). Starting at the floor makes the answer and the
  // explanation agree.
  if (ceiling < floor) return 0;
  if (!profitableAt(floor)) return 0;
  if (profitableAt(ceiling)) return ceiling;

  let low = floor;
  let high = ceiling;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (profitableAt(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * The size that makes the most money, which is *not* the largest profitable one.
 *
 * `maxProfitableSize` finds where the average edge reaches zero — by
 * construction, the point at which the trade earns nothing. Pricing the trade
 * there reports a real mispricing as a $0.00 opportunity, which is how the
 * first live run of this checker confirmed five violations all worth exactly
 * nothing.
 *
 * Total profit is `N·G − cost(N)`. Cost is convex, because each additional unit
 * fills at a price no better than the last, so profit is concave in N and has a
 * single interior maximum: the size at which the *marginal* unit stops paying
 * for itself. Ternary search finds it. The two numbers answer different
 * questions and both are reported — "how much should I do" and "how far could
 * I go before this stops working at all".
 */
function optimalSize(
  spec: BasketSpec,
  books: BookLookup,
  feeRate: number,
  floor: number,
  ceiling: number,
): number {
  const profitAt = (size: number): number => {
    if (size <= 0) return Number.NEGATIVE_INFINITY;
    const priced = basketCost(spec, books, size, feeRate);
    if (priced === null) return Number.NEGATIVE_INFINITY;
    return size * spec.guaranteedPayout - priced.cost;
  };

  let low = floor;
  let high = ceiling;
  for (let i = 0; i < 80; i += 1) {
    const third = (high - low) / 3;
    const a = low + third;
    const b = high - third;
    if (profitAt(a) < profitAt(b)) low = a;
    else high = b;
  }

  // The optimum sits on a level boundary, and ternary search only approaches
  // it. Take the better of the converged point and the endpoints.
  const candidates = [low, high, (low + high) / 2, floor, ceiling];
  let best = floor;
  let bestProfit = Number.NEGATIVE_INFINITY;
  for (const size of candidates) {
    if (size < floor || size > ceiling) continue;
    const profit = profitAt(size);
    if (profit > bestProfit) {
      bestProfit = profit;
      best = size;
    }
  }
  return best;
}

function describe(
  kind: Constraint['kind'],
  direction: Direction,
  legs: readonly TradeLeg[],
  payout: number,
): string {
  const parts = legs.map((leg) => `buy ${leg.size.toFixed(2)} × ${leg.outcome ?? '?'}`);
  const claim =
    kind === 'implies'
      ? 'the entailment excludes the state where this basket pays less'
      : direction === 'under'
        ? 'exactly one member resolves Yes, so the Yes legs pay exactly 1'
        : 'exactly one member resolves Yes, so every other No leg pays';
  return `${parts.join(' + ')} — ${claim}, so the basket pays at least ${payout.toFixed(2)} per unit`;
}

/**
 * Prices the correcting basket and decides whether it is a real opportunity.
 *
 * Returns a {@link TradeAttempt} rather than throwing or returning null, because
 * *why* a screened violation is not executable is the interesting output. A
 * scanner that silently drops these reports a much better hit rate than it has
 * earned.
 */
export function priceCorrectingTrade(
  constraint: Constraint,
  direction: Direction,
  spec: BasketSpec,
  books: BookLookup,
  options: PriceTradeOptions = {},
): TradeAttempt {
  const feeRate = options.feeRate ?? DEFAULT_TAKER_FEE_RATE;
  const minSize = options.minSize ?? FALLBACK_MIN_ORDER_SIZE;
  const minNetProfit = options.minNetProfit ?? 1;
  const minNetEdge = options.minNetEdge ?? 0.005;

  if (spec.legs.length === 0) {
    return { trade: null, failure: 'missing-book', reason: 'constraint had no legs', maxSize: 0 };
  }

  // Every leg needs a token and a book before anything can be priced.
  for (const leg of spec.legs) {
    if (books.tokenId(leg.conditionId, leg.outcomeIndex) === null) {
      return {
        trade: null,
        failure: 'missing-token',
        reason: `no clob token id for ${leg.conditionId} outcome ${leg.outcomeIndex}`,
        maxSize: 0,
      };
    }
    const book = books.book(leg.conditionId, leg.outcomeIndex);
    if (book === null) {
      return {
        trade: null,
        failure: 'missing-book',
        reason: `no order book returned for ${leg.conditionId} outcome ${leg.outcomeIndex}`,
        maxSize: 0,
      };
    }
    if (book.asks.length === 0) {
      return {
        trade: null,
        failure: 'empty-book',
        reason: `nothing offered on ${leg.conditionId} outcome ${leg.outcomeIndex}: the leg cannot be bought at any price`,
        maxSize: 0,
      };
    }
  }

  const ceiling = basketDepth(spec, books);
  if (ceiling <= 0) {
    return {
      trade: null,
      failure: 'insufficient-depth',
      reason: 'at least one leg has no depth on the side the basket must take',
      maxSize: 0,
    };
  }

  // Venue minimums, per leg. A basket below any leg's minimum cannot be sent,
  // so it is also the smallest size worth asking about.
  const venueMin = spec.legs.reduce((largest, leg) => {
    const min = books.minOrderSize?.(leg.conditionId, leg.outcomeIndex) ?? null;
    return min === null ? largest : Math.max(largest, min);
  }, 0);
  const floor = Math.max(minSize, venueMin);

  const maxSize = maxProfitableSize(spec, books, feeRate, ceiling, floor);

  if (maxSize <= 0) {
    // The common and most important case: the screen saw a gap, and the spread
    // plus fees ate all of it. This is what "apparent" means.
    if (ceiling < floor) {
      return {
        trade: null,
        failure: 'below-min-size',
        reason: `only ${ceiling.toFixed(2)} shares are available, below the ${floor} minimum order size`,
        maxSize: 0,
      };
    }
    const probe = basketCost(spec, books, floor, feeRate);
    const perUnit = probe === null ? null : spec.guaranteedPayout - probe.cost / floor;
    return {
      trade: null,
      failure: 'negative-edge',
      reason:
        perUnit === null
          ? 'no size fills every leg'
          : `net edge is ${(perUnit * 100).toFixed(2)}¢ per unit at the minimum size — the spread and fees exceed the mispricing`,
      maxSize: 0,
    };
  }

  if (maxSize < floor) {
    return {
      trade: null,
      failure: 'below-min-size',
      reason: `only ${maxSize.toFixed(2)} units are profitable, below the ${floor} minimum order size — the edge exists but cannot be traded`,
      maxSize,
    };
  }

  // Size for maximum profit, not maximum reach.
  const size = optimalSize(spec, books, feeRate, floor, maxSize);

  const priced = basketCost(spec, books, size, feeRate);
  if (priced === null) {
    return {
      trade: null,
      failure: 'insufficient-depth',
      reason: `a leg could not fill ${size.toFixed(2)} units`,
      maxSize,
    };
  }

  const netProfitAtSize = size * spec.guaranteedPayout - priced.cost;
  const netEdgeAtSize = netProfitAtSize / size;

  if (netProfitAtSize < minNetProfit || netEdgeAtSize < minNetEdge) {
    return {
      trade: null,
      failure: 'immaterial-edge',
      reason:
        `best net profit is ${netProfitAtSize.toFixed(4)} USDC at ${size.toFixed(2)} units ` +
        `(${(netEdgeAtSize * 100).toFixed(3)}¢ per unit) — a real gap at the touch, but too thin to be worth taking`,
      maxSize,
    };
  }

  const legs: TradeLeg[] = [];
  for (const leg of spec.legs) {
    const book = books.book(leg.conditionId, leg.outcomeIndex)!;
    const filled = executableCost(book, 'buy', size, { feeRate });
    legs.push({
      conditionId: leg.conditionId,
      tokenId: books.tokenId(leg.conditionId, leg.outcomeIndex)!,
      outcomeIndex: leg.outcomeIndex,
      outcome: books.outcome(leg.conditionId, leg.outcomeIndex),
      side: 'buy',
      size,
      avgPrice: filled.avgPrice ?? 0,
      notional: filled.notional,
      fee: filled.fee,
      cost: filled.totalCost,
      touchPrice: book.asks[0]?.price ?? null,
      slippage: filled.slippage,
      levelsConsumed: filled.levelsConsumed,
      availableDepth: availableDepth(book, 'buy'),
    });
  }

  const totalPayout = size * spec.guaranteedPayout;
  const netProfit = totalPayout - priced.cost;

  const trade: CorrectingTrade = {
    constraintKey: constraint.key,
    kind: constraint.kind,
    direction,
    summary: describe(constraint.kind, direction, legs, spec.guaranteedPayout),
    legs,
    size,
    maxExecutableSize: maxSize,
    guaranteedPayout: spec.guaranteedPayout,
    totalPayout,
    totalNotional: priced.notional,
    totalFees: priced.fees,
    totalCost: priced.cost,
    grossEdge: spec.guaranteedPayout - priced.notional / size,
    netEdge: netProfit / size,
    netProfit,
    returnOnCost: priced.cost > 0 ? netProfit / priced.cost : 0,
  };

  return { trade, failure: null, reason: null, maxSize };
}
