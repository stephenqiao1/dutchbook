import { describe, expect, it } from 'vitest';

import { bucketise, classify, quantile, spearman, summarise } from '../../src/report/queries.js';

/**
 * The statistics the report's conclusions rest on.
 *
 * A report whose whole argument is "be honest about what the numbers say" has
 * no business computing the numbers wrong, and a rank correlation is exactly
 * the kind of thing that looks plausible while being subtly inverted.
 */

describe('spearman', () => {
  it('is -1 for a perfectly inverted ranking', () => {
    const pairs = [1, 2, 3, 4, 5].map((x) => [x, 6 - x] as const);
    expect(spearman(pairs).rho).toBeCloseTo(-1, 10);
  });

  it('is +1 for a perfectly matched ranking', () => {
    const pairs = [1, 2, 3, 4, 5].map((x) => [x, x * 3] as const);
    expect(spearman(pairs).rho).toBeCloseTo(1, 10);
  });

  it('is rank-based, so a monotone transform does not change it', () => {
    const raw = [[1, 10], [2, 40], [3, 90], [4, 160]] as const;
    const logged = raw.map(([x, y]) => [x, Math.log(y)] as const);
    expect(spearman(raw).rho).toBeCloseTo(spearman(logged).rho!, 10);
  });

  it('averages ranks across ties', () => {
    // Textbook worked example: x = 1,2,2,4  y = 1,2,3,4 -> rho = 0.9486833
    const pairs = [[1, 1], [2, 2], [2, 3], [4, 4]] as const;
    expect(spearman(pairs).rho).toBeCloseTo(0.948_683_3, 6);
  });

  it('returns null rather than a number when one side is constant', () => {
    // No variance means no ranking; 0 would claim "no relationship" instead.
    expect(spearman([[1, 5], [2, 5], [3, 5]]).rho).toBeNull();
  });

  it('declines to answer below three pairs', () => {
    expect(spearman([[1, 2]]).rho).toBeNull();
  });

  it('gives a small p for a strong relationship in a large sample', () => {
    const pairs = Array.from({ length: 200 }, (_, i) => [i, i + (i % 3)] as const);
    const result = spearman(pairs);
    expect(result.rho).toBeGreaterThan(0.9);
    expect(result.p!).toBeLessThan(0.001);
  });
});

describe('quantile and summarise', () => {
  it('interpolates between neighbours', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([0, 1, 2, 3, 4], 0.25)).toBe(1);
  });

  it('is null on an empty sample rather than zero', () => {
    // Zero would render as "median 0s", which is a claim; null renders as "—".
    expect(quantile([], 0.5)).toBeNull();
    expect(summarise([]).median).toBeNull();
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    summarise(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('summarises a known sample', () => {
    const s = summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s).toMatchObject({ n: 10, min: 1, max: 10, median: 5.5, mean: 5.5 });
  });
});

describe('bucketise', () => {
  it('is half-open, so a value on a boundary lands once', () => {
    const buckets = bucketise([0, 1, 2, 3], [
      { label: 'a', from: 0, to: 2 },
      { label: 'b', from: 2, to: null },
    ]);
    expect(buckets.map((b) => b.count)).toEqual([2, 2]);
  });
});

describe('classify', () => {
  it.each([
    ['Lakers vs. Celtics moneyline', 'nba-lal-bos', 'sports'],
    ['Will Bitcoin close above $120,000?', 'btc-120k', 'crypto'],
    ['Will the Fed cut rates in March?', 'fed-march-cut', 'economics'],
    ['Will Marine Le Pen win the 2027 French presidential election?', 'lepen-2027', 'politics'],
    ['Will it rain in Lagos tomorrow?', 'lagos-rain', 'other'],
  ])('%s -> %s', (question, slug, expected) => {
    expect(classify(question, slug)).toBe(expected);
  });

  it('resolves an overlap by pattern order, not by chance', () => {
    // A market matching both sports and crypto must land somewhere stated.
    expect(classify('Will the Super Bowl winner be announced on Bitcoin?', null)).toBe('sports');
  });

  it('handles a market with no text at all', () => {
    expect(classify(null, null)).toBe('other');
  });
});
