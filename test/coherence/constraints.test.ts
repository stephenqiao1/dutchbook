import { describe, expect, it } from 'vitest';

import {
  basketFor,
  evaluate,
  screen,
  type Constraint,
  DEFAULT_SCREEN_EPSILON,
} from '../../src/coherence/constraints.js';

/**
 * The three constraints and, more importantly, the three corrections.
 *
 * A wrong magnitude produces a missed opportunity. A wrong *direction* produces
 * a trade that is guaranteed to lose, because the basket it builds has no lower
 * bound on its payout. So most of this file is about direction and about which
 * outcome leg each correction buys.
 */

const implies = (a: number | null, b: number | null): Constraint => ({
  key: 'implies:1',
  kind: 'implies',
  relationIds: [1],
  groupId: null,
  members: [
    { conditionId: '0xA', price: a },
    { conditionId: '0xB', price: b },
  ],
});

const complement = (a: number | null, b: number | null): Constraint => ({
  key: 'complement:2',
  kind: 'complement',
  relationIds: [2],
  groupId: null,
  members: [
    { conditionId: '0xA', price: a },
    { conditionId: '0xB', price: b },
  ],
});

const partition = (prices: (number | null)[]): Constraint => ({
  key: 'partition:3',
  kind: 'partition',
  relationIds: [],
  groupId: '3',
  members: prices.map((price, i) => ({ conditionId: `0x${i}`, price })),
});

describe('implies — P(A) <= P(B)', () => {
  it('is satisfied when the antecedent is cheaper', () => {
    const result = evaluate(implies(0.3, 0.7));
    expect(result.violated).toBe(false);
    expect(result.direction).toBeNull();
  });

  it('is satisfied at equality', () => {
    expect(evaluate(implies(0.5, 0.5)).violated).toBe(false);
  });

  it('reports magnitude as P(A) - P(B), signed', () => {
    // Signed on purpose: a satisfied entailment has negative magnitude, which
    // is slack. Taking an absolute value here would report every comfortably
    // satisfied constraint as a large violation.
    expect(evaluate(implies(0.3, 0.7)).magnitude).toBeCloseTo(-0.4, 10);
    expect(evaluate(implies(0.7, 0.3)).magnitude).toBeCloseTo(0.4, 10);
  });

  it('violates only when the antecedent is dearer', () => {
    const result = evaluate(implies(0.72, 0.6));
    expect(result.violated).toBe(true);
    expect(result.direction).toBe('over');
    expect(result.magnitude).toBeCloseTo(0.12, 10);
  });

  it('ignores a gap inside epsilon', () => {
    // 0.4¢ on a 1¢-tick market is rounding, not mispricing.
    expect(evaluate(implies(0.504, 0.5), 0.005).violated).toBe(false);
    expect(evaluate(implies(0.51, 0.5), 0.005).violated).toBe(true);
  });
});

describe('complement — P(A) + P(B) = 1', () => {
  it('is satisfied when the pair sums to one', () => {
    expect(evaluate(complement(0.4, 0.6)).violated).toBe(false);
  });

  it('is over when the pair sums above one', () => {
    const result = evaluate(complement(0.6, 0.5));
    expect(result.violated).toBe(true);
    expect(result.direction).toBe('over');
    expect(result.magnitude).toBeCloseTo(0.1, 10);
    expect(result.sum).toBeCloseTo(1.1, 10);
  });

  it('is under when the pair sums below one', () => {
    const result = evaluate(complement(0.4, 0.5));
    expect(result.direction).toBe('under');
    expect(result.magnitude).toBeCloseTo(0.1, 10);
  });
});

describe('partition — sum over the set = 1', () => {
  it('is satisfied when the set sums to one', () => {
    expect(evaluate(partition([0.2, 0.3, 0.5])).violated).toBe(false);
  });

  it('is under when the set is collectively too cheap', () => {
    const result = evaluate(partition([0.2, 0.3, 0.4]));
    expect(result.direction).toBe('under');
    expect(result.magnitude).toBeCloseTo(0.1, 10);
  });

  it('is over when the set is collectively too dear', () => {
    const result = evaluate(partition([0.3, 0.4, 0.5]));
    expect(result.direction).toBe('over');
    expect(result.magnitude).toBeCloseTo(0.2, 10);
  });

  it('handles a large partition', () => {
    const result = evaluate(partition(Array.from({ length: 12 }, () => 0.1)));
    expect(result.sum).toBeCloseTo(1.2, 10);
    expect(result.direction).toBe('over');
  });
});

describe('missing prices', () => {
  it.each([
    ['implies', implies(0.9, null)],
    ['complement', complement(null, 0.2)],
    ['partition', partition([0.2, null, 0.3])],
  ])('makes a %s constraint unscreenable rather than violated', (_label, constraint) => {
    // Substituting a default would manufacture violations out of missing data,
    // and those would be the *largest* apparent ones — crowding out the real
    // ones in every ranking.
    const result = evaluate(constraint);
    expect(result.unscreenable).toBe(true);
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });
});

describe('screen', () => {
  it('keeps only violations, worst first', () => {
    const { violations, stats } = screen([
      implies(0.3, 0.7), // satisfied
      complement(0.6, 0.5), // 0.10
      partition([0.3, 0.4, 0.5]), // 0.20
      partition([0.2, null, 0.3]), // unscreenable
    ]);

    expect(violations).toHaveLength(2);
    expect(violations[0]!.magnitude).toBeCloseTo(0.2, 10);
    expect(violations[1]!.magnitude).toBeCloseTo(0.1, 10);
    expect(stats).toEqual({ evaluated: 4, satisfied: 1, violated: 2, unscreenable: 1 });
  });

  it('uses the default epsilon when none is given', () => {
    expect(DEFAULT_SCREEN_EPSILON).toBe(0.005);
    expect(screen([implies(0.502, 0.5)]).violations).toHaveLength(0);
  });
});

describe('basketFor — what the correcting trade buys', () => {
  it('implies: sells the antecedent by buying its No, and buys the consequent', () => {
    // The trade a naive scanner describes as "sell A, buy B" — but Polymarket
    // has no short, so selling A is buying No(A).
    const basket = basketFor(implies(0.7, 0.3), 'over');

    expect(basket.legs).toEqual([
      { conditionId: '0xA', outcomeIndex: 1 },
      { conditionId: '0xB', outcomeIndex: 0 },
    ]);
    expect(basket.guaranteedPayout).toBe(1);
  });

  it('implies: the basket pays at least 1 in every state the entailment allows', () => {
    // No(A) + Yes(B), across the three admissible states:
    //   A=1,B=1 → 0 + 1 = 1
    //   A=0,B=1 → 1 + 1 = 2
    //   A=0,B=0 → 1 + 0 = 1
    //   A=1,B=0 → excluded by the entailment
    const payouts = [
      [0, 1],
      [1, 1],
      [1, 0],
    ].map(([noA, yesB]) => (noA ?? 0) + (yesB ?? 0));

    expect(Math.min(...payouts)).toBe(basketFor(implies(0.7, 0.3), 'over').guaranteedPayout);
  });

  it('complement over: buys both Nos, which pay exactly 1', () => {
    const basket = basketFor(complement(0.6, 0.5), 'over');
    expect(basket.legs.map((l) => l.outcomeIndex)).toEqual([1, 1]);
    expect(basket.guaranteedPayout).toBe(1);
  });

  it('complement under: buys both Yeses, which pay exactly 1', () => {
    const basket = basketFor(complement(0.4, 0.5), 'under');
    expect(basket.legs.map((l) => l.outcomeIndex)).toEqual([0, 0]);
    expect(basket.guaranteedPayout).toBe(1);
  });

  it('partition under: buys every Yes, exactly one of which pays', () => {
    const basket = basketFor(partition([0.2, 0.3, 0.4]), 'under');
    expect(basket.legs).toHaveLength(3);
    expect(basket.legs.every((l) => l.outcomeIndex === 0)).toBe(true);
    expect(basket.guaranteedPayout).toBe(1);
  });

  it('partition over: buys every No, and n-1 of them pay', () => {
    // Exactly one member resolves Yes, so every *other* No pays out. With five
    // members that is four dollars per unit, not one — getting this wrong would
    // reject every profitable overpriced partition as unprofitable.
    const basket = basketFor(partition([0.3, 0.3, 0.3, 0.3, 0.3]), 'over');
    expect(basket.legs).toHaveLength(5);
    expect(basket.legs.every((l) => l.outcomeIndex === 1)).toBe(true);
    expect(basket.guaranteedPayout).toBe(4);
  });

  it('never buys both legs of the same market', () => {
    // Buying Yes and No of one market is a guaranteed 1 for a guaranteed cost
    // of about 1 — a fee-sized loss dressed up as an arbitrage.
    for (const [constraint, direction] of [
      [implies(0.7, 0.3), 'over'],
      [complement(0.6, 0.5), 'over'],
      [partition([0.3, 0.4, 0.5]), 'over'],
    ] as const) {
      const basket = basketFor(constraint, direction);
      const seen = new Set(basket.legs.map((l) => `${l.conditionId}:${l.outcomeIndex}`));
      expect(seen.size).toBe(basket.legs.length);

      const byMarket = new Map<string, Set<number>>();
      for (const leg of basket.legs) {
        const set = byMarket.get(leg.conditionId) ?? new Set();
        set.add(leg.outcomeIndex);
        byMarket.set(leg.conditionId, set);
      }
      for (const outcomes of byMarket.values()) expect(outcomes.size).toBe(1);
    }
  });
});
