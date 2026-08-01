import type { BookLevel, OrderBook } from '../polymarket/clob.js';
import { DEFAULT_TAKER_FEE_RATE, takerFee } from './costs.js';

/**
 * What an order would actually cost, walked level by level.
 *
 * The premise of this module is that the top of book is not a price. It is the
 * price of the *first* share, and quoting it for a whole order is the mistake
 * that makes a paper arbitrage disappear on execution. A book with 30 shares at
 * 24¢ and the next 500 at 41¢ does not fill 500 shares at 24¢, and it may not
 * fill 500 shares at all.
 *
 * So: no level is assumed to absorb the order, depth running out is reported as
 * a partial fill rather than an error or an extrapolation, and the caller is
 * told what fraction actually filled.
 *
 * Pure and total. No I/O, no clock, and no throwing — a nonsensical request
 * comes back as a zero fill, because a pricing function that throws inside a
 * scan over thousands of markets is a pricing function that stops the scan.
 */

export type Side = 'buy' | 'sell';

export interface ExecutableCost {
  /**
   * Volume-weighted average price per share actually filled, excluding fees.
   * Null when nothing filled — an average over zero shares is not zero.
   */
  readonly avgPrice: number | null;
  /** Shares filled. Less than requested when the book ran out. */
  readonly filled: number;
  /** Shares requested but not available at any price. */
  readonly unfilled: number;
  /**
   * Signed fraction by which the average price is worse than the touch.
   *
   * Positive means worse. For a buy, paying above the best ask; for a sell,
   * receiving below the best bid. Null when nothing filled, or when the book
   * has no touch to compare against.
   *
   * Relative to the *touch*, not the midpoint: the midpoint is not a price
   * anyone can trade at, so measuring slippage against it silently folds half
   * the spread into "slippage" and makes a wide market look like a deep one.
   */
  readonly slippage: number | null;
  /** Total USDC paid (buy) or received (sell), excluding fees. */
  readonly notional: number;
  /** Taker fee in USDC, accumulated per level. */
  readonly fee: number;
  /**
   * Notional including fees: what leaves the account on a buy, what arrives on
   * a sell. Fees always work against the taker, so this is `notional + fee` for
   * a buy and `notional - fee` for a sell.
   */
  readonly totalCost: number;
  /** `totalCost / filled` — the number to compare against a rival venue. */
  readonly effectivePrice: number | null;
  /** The price of the last level touched; how far the order reached. */
  readonly worstPrice: number | null;
  /** Levels consumed, whole or partial. */
  readonly levelsConsumed: number;
  /** True when the book could not fill the whole request. */
  readonly partial: boolean;
}

export interface ExecutableCostOptions {
  /**
   * Taker fee rate for this market's category. Defaults to the conservative
   * {@link DEFAULT_TAKER_FEE_RATE}.
   */
  readonly feeRate?: number;
  /**
   * Refuse to fill past this price (buy) or below it (sell), the way a limit
   * order would. Depth beyond it is left untouched and reported as unfilled.
   */
  readonly limitPrice?: number;
}

const EMPTY: ExecutableCost = {
  avgPrice: null,
  filled: 0,
  unfilled: 0,
  slippage: null,
  notional: 0,
  fee: 0,
  totalCost: 0,
  effectivePrice: null,
  worstPrice: null,
  levelsConsumed: 0,
  partial: false,
};

/**
 * Walks `book` to fill `size` shares on `side`.
 *
 * A **buy** consumes asks — you lift offers, cheapest first. A **sell** consumes
 * bids — you hit bids, highest first. Both sides of an {@link OrderBook} are
 * already sorted best-first by the client, and this function relies on that
 * rather than re-sorting: normalisation happens once, at the boundary.
 */
export function executableCost(
  book: Pick<OrderBook, 'bids' | 'asks'>,
  side: Side,
  size: number,
  options: ExecutableCostOptions = {},
): ExecutableCost {
  if (!Number.isFinite(size) || size <= 0) return EMPTY;

  const levels: readonly BookLevel[] = side === 'buy' ? book.asks : book.bids;
  if (levels.length === 0) return { ...EMPTY, unfilled: size };

  const feeRate = options.feeRate ?? DEFAULT_TAKER_FEE_RATE;
  const limit = options.limitPrice;
  const touch = levels[0]?.price ?? null;

  let remaining = size;
  let filled = 0;
  let notional = 0;
  let fee = 0;
  let levelsConsumed = 0;
  let worstPrice: number | null = null;

  for (const level of levels) {
    if (remaining <= 0) break;

    // A limit stops the walk rather than skipping the level: the book is
    // sorted, so every level after this one is worse too.
    if (limit !== undefined) {
      if (side === 'buy' && level.price > limit) break;
      if (side === 'sell' && level.price < limit) break;
    }

    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;

    filled += take;
    notional += take * level.price;
    // Per level, because the fee is per-share and p(1-p) is concave — charging
    // it once at the average price would understate it.
    fee += takerFee(take, level.price, feeRate);
    remaining -= take;
    levelsConsumed += 1;
    worstPrice = level.price;
  }

  if (filled <= 0) return { ...EMPTY, unfilled: size };

  const avgPrice = notional / filled;
  const totalCost = side === 'buy' ? notional + fee : notional - fee;

  return {
    avgPrice,
    filled,
    unfilled: Math.max(0, size - filled),
    slippage: slippageAgainstTouch(avgPrice, touch, side),
    notional,
    fee,
    totalCost,
    effectivePrice: totalCost / filled,
    worstPrice,
    levelsConsumed,
    partial: filled < size,
  };
}

/**
 * How much worse than the touch the fill came out, as a fraction.
 *
 * Sign is normalised so positive always means *worse for the taker*, on both
 * sides. A caller comparing slippage across buys and sells should not have to
 * remember which direction is bad.
 */
function slippageAgainstTouch(avgPrice: number, touch: number | null, side: Side): number | null {
  if (touch === null || touch <= 0) return null;
  return side === 'buy' ? (avgPrice - touch) / touch : (touch - avgPrice) / touch;
}

/**
 * Total shares available on a side, optionally out to a limit price.
 *
 * Useful for sizing before pricing: `executableCost` reports a partial fill,
 * but a caller sweeping many markets often wants to know the ceiling first.
 */
export function availableDepth(
  book: Pick<OrderBook, 'bids' | 'asks'>,
  side: Side,
  limitPrice?: number,
): number {
  const levels = side === 'buy' ? book.asks : book.bids;
  let total = 0;
  for (const level of levels) {
    if (limitPrice !== undefined) {
      if (side === 'buy' && level.price > limitPrice) break;
      if (side === 'sell' && level.price < limitPrice) break;
    }
    total += level.size;
  }
  return total;
}

/**
 * The largest order that fills without average price slipping past `maxSlippage`.
 *
 * Answers "how much can I actually do here", which is the question that matters
 * once a violation looks real. Returns whole levels only — the boundary is
 * found by walking, then the last level is bisected to the exact size that
 * holds the constraint.
 */
export function maxSizeWithinSlippage(
  book: Pick<OrderBook, 'bids' | 'asks'>,
  side: Side,
  maxSlippage: number,
  options: ExecutableCostOptions = {},
): number {
  const total = availableDepth(book, side, options.limitPrice);
  if (total <= 0 || !Number.isFinite(maxSlippage) || maxSlippage < 0) return 0;

  const within = (size: number): boolean => {
    const cost = executableCost(book, side, size, options);
    return cost.filled >= size && (cost.slippage ?? 0) <= maxSlippage;
  };

  if (within(total)) return total;

  // Slippage is monotone non-decreasing in size — each additional share is
  // filled at a price no better than the last — so bisection is sound.
  let low = 0;
  let high = total;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (within(mid)) low = mid;
    else high = mid;
  }
  return low;
}
