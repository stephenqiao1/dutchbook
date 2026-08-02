import { inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { markets } from '../db/schema.js';
import { createLogger } from '../logger.js';
import { ClobClient, type OrderBook } from '../polymarket/clob.js';
import { GammaClient } from '../polymarket/gamma.js';
import { resolveFeeRate } from '../pricing/costs.js';
import { writeSnapshots } from '../pricing/snapshots.js';
import {
  basketFor,
  screen,
  type Constraint,
  type Evaluation,
  DEFAULT_SCREEN_EPSILON,
} from './constraints.js';
import { loadConstraints, loadQuotes, loadScreenTokens, priced, refreshQuotes, screenPrices } from './load.js';
import { priceCorrectingTrade, type BookLookup, type CorrectingTrade, type TradeFailure } from './trade.js';

/**
 * The two-stage coherence check.
 *
 * Stage 1 evaluates every constraint against cached Gamma midpoints. It is
 * nearly free and nearly always says "satisfied". Stage 2 fetches live order
 * books for the survivors and asks the only question that matters: is there a
 * trade, at a size worth doing, that still makes money after fees and slippage?
 *
 * The ordering is a rate-limit decision. Screening in stage 1 costs one Gamma
 * request per 100 markets; confirming in stage 2 costs an order book per token,
 * two per market. Running stage 2 over the whole graph would be four orders of
 * magnitude more expensive and would spend the entire CLOB budget rediscovering
 * that almost everything is priced consistently.
 *
 * It also means the two stages disagree constantly, and that disagreement is
 * the product. A gap on Gamma midpoints is not an opportunity — it is a
 * hypothesis, and stage 2 rejects most of them. Recording the rejected ones as
 * `apparent`, with the reason, is what separates this from a scanner that
 * reports every midpoint gap as free money.
 */

const log = createLogger('coherence:check');

type Database = PostgresJsDatabase<typeof schema>;

export interface CheckOptions {
  readonly epsilon?: number;
  /** Cap on constraints promoted to stage 2 per run, worst-magnitude first. */
  readonly maxConfirmations?: number;
  /** Skip the Gamma refresh and screen against whatever is cached. */
  readonly skipQuoteRefresh?: boolean;
  /** Persist the fetched books to `price_snapshots`. Default true. */
  readonly snapshot?: boolean;
  readonly signal?: AbortSignal;
  readonly clob?: ClobClient;
  readonly gamma?: GammaClient;
  /**
   * Live order books for the screen. When present, stage 1 prices from book
   * midpoints and the Gamma refresh narrows to the markets the feed does not
   * cover — which is the whole point of the feed, since a Gamma quote is already
   * seconds old when it arrives and describes no size at all.
   */
  readonly feed?: StagePriceFeed;
}

/** The slice of the market feed stage 1 uses. */
export interface StagePriceFeed {
  mid(tokenId: string): number | null;
}

/** What stage 2 concluded about one screened constraint. */
export interface Confirmation {
  readonly constraint: Constraint;
  readonly evaluation: Evaluation;
  /** Magnitude recomputed from live book midpoints, not Gamma's. */
  readonly liveMagnitude: number | null;
  readonly trade: CorrectingTrade | null;
  readonly failure: TradeFailure | null;
  readonly reason: string | null;
  readonly status: 'confirmed' | 'apparent';
}

export interface CheckResult {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly screened: {
    readonly evaluated: number;
    readonly satisfied: number;
    readonly violated: number;
    readonly unscreenable: number;
  };
  readonly confirmations: readonly Confirmation[];
  readonly confirmed: number;
  readonly apparent: number;
  /** Order books fetched — the expensive resource this design exists to ration. */
  readonly booksFetched: number;
}

/** Market metadata stage 2 needs to turn a constraint into buyable tokens. */
interface MarketLeg {
  readonly conditionId: string;
  readonly tokenIds: string[] | null;
  readonly outcomes: string[] | null;
}

/**
 * Runs one full check.
 *
 * Every expensive step is bounded: quotes are refreshed only for markets under
 * constraint, books are fetched only for constraints that survived the screen,
 * and `maxConfirmations` caps stage 2 even when the screen surfaces a flood
 * (which happens when the quote cache goes stale and every price is wrong at
 * once).
 */
export async function runCoherenceCheck(
  database: Database = db,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const startedAt = new Date();
  const epsilon = options.epsilon ?? DEFAULT_SCREEN_EPSILON;
  const maxConfirmations = options.maxConfirmations ?? 25;
  const clob = options.clob ?? new ClobClient();
  const gamma = options.gamma ?? new GammaClient();

  // ---- stage 0: constraints, and the prices to screen them with -------------
  const { constraints, conditionIds } = await loadConstraints(database);

  const feed = options.feed ?? null;
  const tokenOf = feed === null ? null : await loadScreenTokens(conditionIds, database);

  if (options.skipQuoteRefresh !== true) {
    // With a feed, Gamma is refreshed only for what the feed cannot price. That
    // is the traffic saving, but it is also the point: the cached quote is the
    // fallback path, and a fallback nobody refreshes is a fallback that fails
    // when it is finally needed.
    const stale =
      feed === null
        ? conditionIds
        : conditionIds.filter((id) => {
            const token = tokenOf?.get(id);
            return token === undefined || feed.mid(token) === null;
          });
    await refreshQuotes(stale, database, gamma, options.signal);
  }
  const cached = await loadQuotes(conditionIds, database);
  const { prices, live, fallback } = screenPrices(conditionIds, cached, tokenOf, feed);

  // ---- stage 1: the cheap screen -------------------------------------------
  const withPrices = constraints.map((constraint) => priced(constraint, prices));
  const { violations, stats } = screen(withPrices, epsilon);

  log.info(
    {
      ...stats,
      epsilon,
      promoted: Math.min(violations.length, maxConfirmations),
      pricedFromFeed: live,
      pricedFromCache: fallback,
    },
    'coherence screen complete',
  );

  const promoted = violations.slice(0, maxConfirmations);
  if (violations.length > maxConfirmations) {
    // Never silent: a truncated stage 2 means real violations went unexamined.
    log.warn(
      { violated: violations.length, promoted: maxConfirmations },
      'more screened violations than the confirmation budget allows; the tail was not examined',
    );
  }

  if (promoted.length === 0) {
    return {
      startedAt,
      finishedAt: new Date(),
      screened: stats,
      confirmations: [],
      confirmed: 0,
      apparent: 0,
      booksFetched: 0,
    };
  }

  // ---- stage 2: live books for the survivors only --------------------------
  const involved = [...new Set(promoted.flatMap((v) => v.constraint.members.map((m) => m.conditionId)))];

  const marketRows = await database
    .select({
      conditionId: markets.conditionId,
      clobTokenIds: markets.clobTokenIds,
      outcomes: markets.outcomes,
    })
    .from(markets)
    .where(inArray(markets.conditionId, involved));

  const meta = new Map<string, MarketLeg>(
    marketRows.map((row) => [
      row.conditionId,
      { conditionId: row.conditionId, tokenIds: row.clobTokenIds, outcomes: row.outcomes },
    ]),
  );

  // Both outcome tokens of every involved market: a correcting basket may need
  // either leg, and which one is not known until the direction is.
  const tokenIds = [
    ...new Set(
      involved.flatMap((conditionId) => meta.get(conditionId)?.tokenIds ?? []).filter((id) => id !== ''),
    ),
  ];

  const fetchOptions = options.signal === undefined ? {} : { signal: options.signal };
  const { books, missing } = await clob.fetchBooks(tokenIds, fetchOptions);
  if (missing.length > 0) {
    log.warn({ missing: missing.length, sample: missing.slice(0, 3) }, 'clob returned no book for some tokens');
  }

  if (options.snapshot !== false && books.size > 0) {
    // Free history: these books were fetched anyway, and a confirmed violation
    // is only auditable later if the depth behind it was kept.
    await writeSnapshots(books.values(), database).catch((error: unknown) => {
      log.warn({ error }, 'snapshot write failed; continuing');
      return null;
    });
  }

  const lookup = buildLookup(meta, books);

  const confirmations: Confirmation[] = [];
  for (const evaluation of promoted) {
    confirmations.push(confirmOne(evaluation, lookup));
  }

  const confirmed = confirmations.filter((c) => c.status === 'confirmed').length;

  log.info(
    {
      promoted: promoted.length,
      confirmed,
      apparent: confirmations.length - confirmed,
      booksFetched: books.size,
    },
    'coherence confirmation complete',
  );

  return {
    startedAt,
    finishedAt: new Date(),
    screened: stats,
    confirmations,
    confirmed,
    apparent: confirmations.length - confirmed,
    booksFetched: books.size,
  };
}

/** Adapter from market metadata plus fetched books to what trade pricing needs. */
export function buildLookup(
  meta: ReadonlyMap<string, MarketLeg>,
  books: ReadonlyMap<string, OrderBook>,
): BookLookup {
  const tokenFor = (conditionId: string, outcomeIndex: 0 | 1): string | null =>
    meta.get(conditionId)?.tokenIds?.[outcomeIndex] ?? null;

  return {
    tokenId: tokenFor,
    outcome: (conditionId, outcomeIndex) =>
      meta.get(conditionId)?.outcomes?.[outcomeIndex] ?? null,
    book: (conditionId, outcomeIndex) => {
      const token = tokenFor(conditionId, outcomeIndex);
      return token === null ? null : (books.get(token) ?? null);
    },
    minOrderSize: (conditionId, outcomeIndex) => {
      const token = tokenFor(conditionId, outcomeIndex);
      return token === null ? null : (books.get(token)?.minOrderSize ?? null);
    },
  };
}

/**
 * Confirms or rejects one screened violation.
 *
 * The live magnitude is recomputed from book midpoints before the trade is
 * priced, because the most common reason a screened violation is not real is
 * simply that the Gamma quote was stale — the gap had already closed. Reporting
 * that as "the spread ate it" would be wrong, and would hide how much of the
 * apparent set is a data-freshness artefact rather than a market-structure one.
 */
export function confirmOne(evaluation: Evaluation, books: BookLookup): Confirmation {
  const constraint = evaluation.constraint;
  const direction = evaluation.direction;

  if (direction === null) {
    return {
      constraint,
      evaluation,
      liveMagnitude: null,
      trade: null,
      failure: null,
      reason: 'not violated',
      status: 'apparent',
    };
  }

  const liveMagnitude = recomputeFromBooks(evaluation, books);

  const spec = basketFor(constraint, direction);
  const attempt = priceCorrectingTrade(constraint, direction, spec, books, {
    // The fee category is not published; the conservative rate applies, so a
    // confirmed violation is confirmed under a fee assumption that is an upper
    // bound. Erring the other way would confirm trades that lose money.
    feeRate: resolveFeeRate({}),
  });

  if (attempt.trade === null) {
    const staleness =
      liveMagnitude !== null && liveMagnitude <= 0
        ? 'the gap had already closed on the live book — the screen was reading a stale Gamma quote'
        : null;
    return {
      constraint,
      evaluation,
      liveMagnitude,
      trade: null,
      failure: attempt.failure,
      reason: staleness ?? attempt.reason,
      status: 'apparent',
    };
  }

  return {
    constraint,
    evaluation,
    liveMagnitude,
    trade: attempt.trade,
    failure: null,
    reason: null,
    status: 'confirmed',
  };
}

/**
 * The constraint's magnitude using live book midpoints instead of Gamma's.
 *
 * Midpoints again, not executable prices — this number exists only to separate
 * "the screen was stale" from "the screen was right but the trade is not
 * profitable". The executable answer is the trade itself.
 */
function recomputeFromBooks(evaluation: Evaluation, books: BookLookup): number | null {
  const prices: number[] = [];

  for (const member of evaluation.constraint.members) {
    const book = books.book(member.conditionId, 0);
    const bid = book?.bids[0]?.price ?? null;
    const ask = book?.asks[0]?.price ?? null;
    if (bid === null || ask === null) return null;
    prices.push((bid + ask) / 2);
  }

  if (evaluation.constraint.kind === 'implies') {
    const [a, b] = prices;
    return (a ?? 0) - (b ?? 0);
  }
  const sum = prices.reduce((total, price) => total + price, 0);
  return evaluation.direction === 'under' ? 1 - sum : sum - 1;
}
