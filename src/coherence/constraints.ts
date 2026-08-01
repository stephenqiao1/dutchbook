/**
 * Constraints and their violation magnitudes.
 *
 * Three relation types, three inequalities, and — the part that actually
 * matters — three *directions of correction*. A constraint that is violated
 * tells you the prices are inconsistent; which side of it is violated tells you
 * what to buy. Getting the direction wrong does not produce a smaller profit,
 * it produces a guaranteed loss, so the direction is modelled explicitly rather
 * than inferred at the trade-construction site.
 *
 * Pure and total: no I/O, no clock, no throwing. Every function here is
 * arithmetic over probabilities.
 */

export type ConstraintKind = 'implies' | 'complement' | 'partition';

/**
 * Which side of a constraint is broken, and therefore what the correcting
 * basket is made of.
 *
 * - `over`  — the priced quantity is too high, so the basket sells: buy the
 *   NO leg of each member.
 * - `under` — too low, so the basket buys: buy the YES leg of each member.
 *
 * `implies` only ever has one violating direction (P(A) > P(B)), which is
 * modelled as `over` for uniformity: the trade sells A and buys B.
 */
export type Direction = 'over' | 'under';

/** A market participating in a constraint, at a screened price. */
export interface ConstraintMember {
  readonly conditionId: string;
  /** P(first outcome). Null when no quote is cached — the constraint is unscreenable. */
  readonly price: number | null;
}

export interface Constraint {
  /** Stable identity, e.g. `implies:4213`. Used to key violation episodes. */
  readonly key: string;
  readonly kind: ConstraintKind;
  /** `relations.id` values behind this constraint. */
  readonly relationIds: readonly number[];
  /** `relation_groups.id` for a partition; null otherwise. */
  readonly groupId: string | null;
  /**
   * Members in a fixed order. For `implies` this is exactly [antecedent,
   * consequent] — the order carries the direction of entailment and must not
   * be sorted.
   */
  readonly members: readonly ConstraintMember[];
  readonly rationale?: string;
}

export interface Evaluation {
  readonly constraint: Constraint;
  /**
   * How far the constraint is from being satisfied, in probability.
   *
   * Signed for `implies`, where the sign *is* the violation: positive means
   * P(A) > P(B), which is the only way an entailment can break. Absolute for
   * `complement` and `partition`, where either direction is a violation and
   * {@link direction} carries which.
   */
  readonly magnitude: number;
  /** Which way the constraint is broken. Null when it is satisfied. */
  readonly direction: Direction | null;
  readonly violated: boolean;
  /** True when a member had no cached quote, so nothing could be concluded. */
  readonly unscreenable: boolean;
  /** The prices used, for the audit trail. */
  readonly prices: readonly (number | null)[];
  /** For `partition`/`complement`, the sum that should have been 1. */
  readonly sum: number | null;
}

/**
 * Default screening threshold, in probability.
 *
 * 0.5¢. Below this a "violation" is indistinguishable from the venue's own tick
 * size — most markets quote in 1¢ increments — so anything smaller is rounding,
 * not mispricing. It is also far below any level that could survive fees: a 1¢
 * gross edge on a 50¢ share does not cover a 5% taker fee, so this threshold is
 * not what filters out unprofitable trades. Stage 2 is. This only decides what
 * is worth *asking* about.
 */
export const DEFAULT_SCREEN_EPSILON = 0.005;

/**
 * Evaluates one constraint against screened prices.
 *
 * A member with no price makes the whole constraint unscreenable rather than
 * treated as zero. Substituting a default probability would manufacture
 * violations out of missing data — and those would be the *largest* apparent
 * violations, so they would crowd out the real ones in every ranking.
 */
export function evaluate(constraint: Constraint, epsilon = DEFAULT_SCREEN_EPSILON): Evaluation {
  const prices = constraint.members.map((member) => member.price);
  const unscreenable = prices.some((price) => price === null || !Number.isFinite(price));

  const base = { constraint, prices, unscreenable } as const;

  if (unscreenable) {
    return { ...base, magnitude: 0, direction: null, violated: false, sum: null };
  }

  const known = prices as number[];

  if (constraint.kind === 'implies') {
    // P(A) <= P(B). The magnitude is signed on purpose: a satisfied entailment
    // has a negative magnitude, which is the slack, and slack is not violation.
    const [a, b] = known;
    const magnitude = (a ?? 0) - (b ?? 0);
    return {
      ...base,
      magnitude,
      direction: magnitude > epsilon ? 'over' : null,
      violated: magnitude > epsilon,
      sum: null,
    };
  }

  // complement and partition are the same arithmetic: the members' probabilities
  // must sum to exactly 1, because exactly one of them resolves Yes.
  const sum = known.reduce((total, price) => total + price, 0);
  const gap = sum - 1;
  const magnitude = Math.abs(gap);

  return {
    ...base,
    magnitude,
    direction: magnitude > epsilon ? (gap > 0 ? 'over' : 'under') : null,
    violated: magnitude > epsilon,
    sum,
  };
}

/** Evaluates many constraints, keeping only the violated ones, worst first. */
export function screen(
  constraints: readonly Constraint[],
  epsilon = DEFAULT_SCREEN_EPSILON,
): {
  readonly violations: readonly Evaluation[];
  readonly stats: {
    readonly evaluated: number;
    readonly satisfied: number;
    readonly violated: number;
    readonly unscreenable: number;
  };
} {
  const all = constraints.map((constraint) => evaluate(constraint, epsilon));
  const violations = all
    .filter((evaluation) => evaluation.violated)
    .toSorted((a, b) => b.magnitude - a.magnitude);

  return {
    violations,
    stats: {
      evaluated: all.length,
      satisfied: all.filter((e) => !e.violated && !e.unscreenable).length,
      violated: violations.length,
      unscreenable: all.filter((e) => e.unscreenable).length,
    },
  };
}

/**
 * Which outcome leg of each member the correcting basket buys, and what the
 * basket is guaranteed to pay.
 *
 * This is the heart of the whole checker, so it is worth stating why every
 * correction is expressible as *buying* something.
 *
 * Polymarket has no short. You cannot sell a token you do not hold. But every
 * market has two complementary outcome tokens that together always pay exactly
 * 1, so selling Yes is the same position as buying No. Every correction below
 * is therefore a basket of **buy** orders, each priced against its own real
 * order book — which is also what makes the cost of the correction computable
 * rather than notional.
 *
 * `outcomeIndex` is an index into `markets.outcomes` / `clob_token_ids`: 0 is
 * the first outcome (the one every relation is written about), 1 is its
 * complement.
 *
 * The guaranteed payout is the *minimum* over every state the world can be in
 * that the constraint permits. Minimum, not expected: the trade is only an
 * arbitrage if it wins in the worst admissible case.
 *
 * | Constraint | Direction | Basket | Worst-case payout |
 * | --- | --- | --- | --- |
 * | implies(A,B) | over | No(A), Yes(B) | 1 |
 * | complement(A,B) | over | No(A), No(B) | 1 |
 * | complement(A,B) | under | Yes(A), Yes(B) | 1 |
 * | partition(S) | under | Yes of every member | 1 |
 * | partition(S) | over | No of every member | n − 1 |
 *
 * Worked, for `implies(A,B)` violated — the only non-obvious one. A entails B,
 * so the state A=1,B=0 cannot occur. Buy one No(A) and one Yes(B):
 *
 * - A=1, B=1 → No(A) pays 0, Yes(B) pays 1 → **1**
 * - A=0, B=1 → 1 + 1 → 2
 * - A=0, B=0 → 1 + 0 → **1**
 * - A=1, B=0 → excluded by the entailment
 *
 * so the basket never pays less than 1, and any cost below 1 is free money.
 * Note this is exactly the naive "sell A, buy B" trade, but expressed in
 * instruments that actually exist and prices you can actually get.
 */
export interface BasketSpec {
  readonly legs: readonly { readonly conditionId: string; readonly outcomeIndex: 0 | 1 }[];
  /** Minimum USDC one unit of the basket pays at resolution. */
  readonly guaranteedPayout: number;
}

export function basketFor(constraint: Constraint, direction: Direction): BasketSpec {
  const members = constraint.members;

  if (constraint.kind === 'implies') {
    const [antecedent, consequent] = members;
    if (antecedent === undefined || consequent === undefined) {
      return { legs: [], guaranteedPayout: 0 };
    }
    // Sell the antecedent (buy its No), buy the consequent.
    return {
      legs: [
        { conditionId: antecedent.conditionId, outcomeIndex: 1 },
        { conditionId: consequent.conditionId, outcomeIndex: 0 },
      ],
      guaranteedPayout: 1,
    };
  }

  // complement and partition: buy Yes on everything when the set is underpriced,
  // No on everything when it is overpriced.
  const outcomeIndex: 0 | 1 = direction === 'under' ? 0 : 1;
  const legs = members.map((member) => ({ conditionId: member.conditionId, outcomeIndex }));

  // Exactly one member resolves Yes. Buying every Yes therefore pays 1; buying
  // every No pays n − 1, because all but the winner pay out.
  const guaranteedPayout = direction === 'under' ? 1 : members.length - 1;

  return { legs, guaranteedPayout };
}

/**
 * Gross edge per unit implied by the screen, before any execution cost.
 *
 * The number a naive scanner would report as profit. It is carried through to
 * the violation record precisely so the gap between it and the net edge is
 * visible — that gap is the entire difference between this and a naive scanner.
 */
export function grossEdge(evaluation: Evaluation): number {
  return evaluation.magnitude;
}
