/**
 * Every cost assumption in one auditable place.
 *
 * Nothing else in the pricing path is allowed to hardcode a fee, a slippage
 * allowance, or a gas estimate. The point is that a reader can check each
 * number against its cited source in one sitting, and that changing an
 * assumption is a one-line edit rather than a search-and-replace across the
 * codebase.
 *
 * Every constant below carries: what it is, where the number came from, and
 * when it was last checked. A number without a source is a guess, and a guess
 * in a cost model is how a strategy comes to look profitable on paper.
 *
 * ⚠️ These are *modelling* assumptions, not quotes. The venue is the authority
 * on what it will actually charge; this module only has to be close enough that
 * a violation which survives it is worth looking at by hand.
 */

/** When the figures below were last verified against their sources. */
const VERIFIED_ON = '2026-08-01';

// ---------------------------------------------------------------------------
// Trading fees
// ---------------------------------------------------------------------------

/**
 * Polymarket's taker fee formula.
 *
 * ```
 * fee = C × feeRate × p × (1 - p)
 * ```
 *
 * where `C` is shares traded and `p` is the share price, denominated in USDC.
 *
 * Three properties of this formula matter for anything built on top:
 *
 * - **Takers only.** "Makers are never charged fees." A resting order pays
 *   nothing; a marketable order pays. Everything this codebase prices is a
 *   taker order — crossing the book is the whole point of pricing against real
 *   depth — so the maker rate never appears in a cost estimate here.
 * - **It is symmetric about 0.5 and vanishes at the extremes.** `p(1-p)` peaks
 *   at 0.25 when `p = 0.5` and tends to 0 as `p` approaches 0 or 1. A trade at
 *   30¢ costs the same *in dollars* as one at 70¢. As a fraction of notional it
 *   is `feeRate × (1 - p)`, which means cheap shares are proportionally far
 *   more expensive to trade: at `p = 0.05` and a 5% rate the fee is 4.75% of
 *   the amount staked.
 * - **It is per-share, so it must be applied level by level** when an order
 *   walks the book, not once at the average price. Applying it at the average
 *   is not merely imprecise; because `p(1-p)` is concave, it systematically
 *   *understates* the fee on an order that spans a range of prices.
 *
 * Source: https://docs.polymarket.com/trading/fees (checked 2026-08-01)
 */
export const FEE_FORMULA = 'fee = shares × feeRate × price × (1 - price)' as const;

/**
 * Market categories with distinct taker fee rates.
 *
 * These are Polymarket's own categories, not ours. The mapping from a market to
 * its category is not exposed on the market objects this service ingests, which
 * is why {@link DEFAULT_TAKER_FEE_RATE} exists and why it is the conservative
 * end of the range.
 */
export type FeeCategory =
  | 'crypto'
  | 'sports'
  | 'finance'
  | 'politics'
  | 'economics'
  | 'culture'
  | 'weather'
  | 'mentions'
  | 'tech'
  | 'geopolitics'
  | 'other';

/**
 * Taker fee rate by category. Maker rate is 0 across the board.
 *
 * Source: https://docs.polymarket.com/trading/fees (checked 2026-08-01)
 */
export const TAKER_FEE_RATES: Readonly<Record<FeeCategory, number>> = {
  crypto: 0.07,
  sports: 0.05,
  finance: 0.04,
  politics: 0.04,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  mentions: 0.04,
  tech: 0.04,
  /** "Geopolitical and world events markets are fee-free." */
  geopolitics: 0,
  other: 0.05,
};

/**
 * Used when a market's category is unknown — which, in practice, is always.
 *
 * **The public API does not expose a market's fee category.** Neither the CLOB
 * market object nor Gamma carries one. Gamma has free-form `tags` — a Fed
 * market carries `Fed`, `Economic Policy`, `Jerome Powell`, `CPI Release` —
 * and none of those is one of the eleven categories in the schedule above.
 * Inferring the category from tags would be pattern-matching dressed up as
 * data, and it would be wrong silently.
 *
 * So the category has to come from the caller, and this is what applies when it
 * does not: 0.07, the crypto rate and the highest in the schedule, rather than
 * the 0.05 modal rate. An unknown category should make an opportunity look
 * *worse* than it is, never better — overstating fees costs a missed trade,
 * understating them costs a losing one.
 *
 * The practical consequence: a total cost computed with this default is an
 * upper bound, and on a 0.04-rate market it overstates the fee by ~75%. The
 * notional and average price are exact regardless; only the fee line moves.
 */
export const DEFAULT_TAKER_FEE_RATE = 0.07;

/** Makers are never charged. Present so the asymmetry is explicit rather than assumed. */
export const MAKER_FEE_RATE = 0;

/**
 * ⚠️ **Do not compute a fee rate from the API's `base_fee`.**
 *
 * `GET /fee-rate/{token_id}` and the `taker_base_fee` field on `/markets` both
 * return an integer the OpenAPI spec describes as "Base fee in basis points".
 * Read literally, the observed value of 1000 means 10% — between 1.4× and 2.5×
 * every rate in {@link TAKER_FEE_RATES}, and applied through the wrong formula
 * it is wronger still.
 *
 * Sampling 2,000 live markets on 2026-08-01 found the field takes exactly two
 * values: `0` (84 markets) and `1000` (1,916). The zeros are precisely the
 * documented carve-out — Russian Duma seats, Trump acquiring Greenland, Maduro,
 * the Iranian regime — while the 1000s span crypto, politics, and US elections,
 * which the published schedule prices at three *different* rates (0.07, 0.04,
 * 0.04). A field that cannot distinguish 0.04 from 0.07 is not carrying the
 * category rate.
 *
 * So it is treated as what it demonstrably is: a **fee-enabled flag**. Its zero
 * is authoritative, because that is the venue itself saying this market is
 * fee-free. Its magnitude is ignored in favour of the published schedule.
 */
export const FEE_ENABLED_SENTINEL_BPS = 1000;

/**
 * The rate to charge, combining the venue's flag with the published schedule.
 *
 * `baseFeeBps` comes from the API and settles *whether* there is a fee;
 * `category` settles *how much*. When the category is unknown the conservative
 * default applies, so an unknown market never looks cheaper than it is.
 */
export function resolveFeeRate(input: {
  readonly baseFeeBps?: number | null;
  readonly category?: FeeCategory | string | null;
}): number {
  if (input.baseFeeBps === 0) return 0;
  return feeRateFor(input.category);
}

/**
 * Below this the venue rounds a fee to zero.
 *
 * Source: https://docs.polymarket.com/trading/fees (checked 2026-08-01)
 */
export const MIN_FEE_USDC = 0.00001;

/**
 * The taker fee on `shares` filled at `price`, in USDC.
 *
 * Call this **per level**, not on an order's average price — see the concavity
 * note on {@link FEE_FORMULA}.
 */
export function takerFee(shares: number, price: number, feeRate = DEFAULT_TAKER_FEE_RATE): number {
  if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0) return 0;
  const fee = shares * feeRate * price * (1 - price);
  return fee < MIN_FEE_USDC ? 0 : fee;
}

/** The taker fee rate for a category, falling back to the conservative default. */
export function feeRateFor(category: FeeCategory | string | null | undefined): number {
  if (category === null || category === undefined) return DEFAULT_TAKER_FEE_RATE;
  const key = category.toLowerCase() as FeeCategory;
  return Object.hasOwn(TAKER_FEE_RATES, key) ? TAKER_FEE_RATES[key] : DEFAULT_TAKER_FEE_RATE;
}

// ---------------------------------------------------------------------------
// Non-fee costs
// ---------------------------------------------------------------------------

/**
 * Gas, in USDC, for one on-chain settlement.
 *
 * Zero, and that is a real modelling decision rather than an omission:
 * Polymarket relays matched orders on Polygon and does not pass gas to the
 * taker, so an order that fills costs no gas to the trader. It is a named
 * constant so that the assumption is visible and so that a future
 * self-relaying path has somewhere to put a real number.
 *
 * Source: orders are matched and settled by the operator; the CLOB API takes no
 * gas parameter and the taker signs an off-chain order.
 */
export const GAS_COST_USDC = 0;

/**
 * Deposit and withdrawal costs, in USDC.
 *
 * "There are also no Polymarket fees to deposit or withdraw USDC (though
 * intermediaries like Coinbase or MoonPay may charge their own fees)." Modelled
 * as zero because the intermediary cost is per-user and not knowable here.
 *
 * Source: https://docs.polymarket.com/trading/fees (checked 2026-08-01)
 */
export const DEPOSIT_COST_USDC = 0;

/**
 * Minimum order size, in shares, below which the venue rejects an order.
 *
 * Per-market and reported on each order book as `min_order_size`, so this is
 * only the fallback for when a book has not been fetched. Live sampling showed
 * 5 and 15; 5 is the common case.
 *
 * Prefer `book.minOrderSize` whenever a book is in hand.
 */
export const FALLBACK_MIN_ORDER_SIZE = 5;

/**
 * Price granularity, in USDC, when a book is not in hand.
 *
 * Per-market and reported as `tick_size`. Live sampling of 1,000 markets found
 * only two values: 0.01 (613 markets) and 0.001 (387). The coarser one is the
 * fallback, since assuming finer granularity than exists would let a model
 * "trade" at prices the venue cannot represent.
 *
 * Prefer `book.tickSize` whenever a book is in hand.
 */
export const FALLBACK_TICK_SIZE = 0.01;

// ---------------------------------------------------------------------------
// Execution assumptions
// ---------------------------------------------------------------------------

/**
 * How stale a book may be before a price derived from it is untrustworthy.
 *
 * The reason this whole module exists is that Gamma's midpoints lag the book by
 * seconds. A CLOB book carries the venue's own `timestamp`, so staleness is
 * measurable rather than assumed — but only if something checks it. Five
 * seconds is a judgement call, not a sourced figure: it is roughly the lag that
 * made Gamma prices unusable, and it is deliberately tight.
 */
export const MAX_BOOK_AGE_MS = 5_000;

/**
 * The register, as data.
 *
 * Every assumption above, in one array the report prints verbatim. This is what
 * stops the register rotting: a constant nothing reads is prose pretending to be
 * code, and prose drifts from the model it claims to describe. Rendering it into
 * §7 of the report means an assumption cannot change without the published
 * document changing with it.
 *
 * `enforced` is the uncomfortable column. `MAX_BOOK_AGE_MS` is defined, sourced
 * and reasoned about, and nothing in the pricing path currently checks it —
 * saying so here is better than a constant that implies a guard exists.
 */
export interface CostComponent {
  readonly name: string;
  readonly value: number | string;
  readonly unit: string;
  readonly source: string;
  /** False when the value is recorded but no code acts on it. */
  readonly enforced: boolean;
}

export const COST_MODEL_VERIFIED_ON = VERIFIED_ON;

export const COST_MODEL: readonly CostComponent[] = [
  {
    name: 'Taker fee rate (applied)',
    value: DEFAULT_TAKER_FEE_RATE,
    unit: 'fraction',
    source: 'docs.polymarket.com/trading/fees — highest published band, applied to everything because the per-market category is not published',
    enforced: true,
  },
  {
    name: 'Maker fee',
    value: 0,
    unit: 'USDC',
    source: 'docs.polymarket.com/trading/fees — makers are not charged; the correcting basket is modelled as all-taker',
    enforced: true,
  },
  {
    name: 'Gas per settlement',
    value: GAS_COST_USDC,
    unit: 'USDC',
    source: 'orders are matched and settled by the operator; the taker signs off-chain and pays no gas',
    enforced: true,
  },
  {
    name: 'Deposit / withdrawal',
    value: DEPOSIT_COST_USDC,
    unit: 'USDC',
    source: 'docs.polymarket.com/trading/fees — no Polymarket fee; third-party on-ramp costs are per-user and not knowable here',
    enforced: false,
  },
  {
    name: 'Minimum order size (fallback)',
    value: FALLBACK_MIN_ORDER_SIZE,
    unit: 'shares',
    source: 'per-market `min_order_size`; live sampling saw 5 and 15. Used only when no book is in hand',
    enforced: true,
  },
  {
    name: 'Tick size (fallback)',
    value: FALLBACK_TICK_SIZE,
    unit: 'USDC',
    source: 'per-market `tick_size`; 1,000-market sample found 0.01 (613) and 0.001 (387). The coarser is the fallback',
    enforced: false,
  },
  {
    name: 'Maximum book age',
    value: MAX_BOOK_AGE_MS,
    unit: 'ms',
    source: 'judgement, not a published figure — roughly the Gamma lag that made midpoints unusable',
    enforced: false,
  },
  {
    name: 'Capital cost of holding to resolution',
    value: 'not modelled',
    unit: '—',
    source: 'no source; a basket on a market a year out ties up capital and this model ignores it',
    enforced: false,
  },
];

/**
 * Depth levels retained per side when a book is persisted.
 *
 * Ten. Enough to price a realistically-sized order after the fact, few enough
 * that a snapshot row stays small at high snapshot frequency.
 */
export const SNAPSHOT_DEPTH = 10;
