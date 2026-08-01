import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TAKER_FEE_RATE,
  FEE_ENABLED_SENTINEL_BPS,
  MAKER_FEE_RATE,
  MIN_FEE_USDC,
  TAKER_FEE_RATES,
  feeRateFor,
  resolveFeeRate,
  takerFee,
} from '../../src/pricing/costs.js';

/**
 * These pin the published fee schedule and the shape of the formula. They are
 * deliberately literal: if Polymarket changes a rate, the right outcome is a
 * failing test that sends someone to re-read the source, not a silently shifted
 * cost model.
 *
 * Source: https://docs.polymarket.com/trading/fees (checked 2026-08-01)
 */

describe('takerFee', () => {
  it('implements shares × rate × p × (1 - p)', () => {
    // Documented worked shape: 100 shares at 0.5 on the 0.07 crypto rate.
    expect(takerFee(100, 0.5, 0.07)).toBeCloseTo(100 * 0.07 * 0.25, 12);
  });

  it('is symmetric about 0.5 in dollars', () => {
    // "a trade at 30¢ incurs the same dollar fee as a trade at 70¢"
    expect(takerFee(100, 0.3, 0.05)).toBeCloseTo(takerFee(100, 0.7, 0.05), 12);
    expect(takerFee(100, 0.01, 0.05)).toBeCloseTo(takerFee(100, 0.99, 0.05), 12);
  });

  it('peaks at the midpoint', () => {
    const mid = takerFee(100, 0.5, 0.05);
    for (const price of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      expect(takerFee(100, price, 0.05)).toBeLessThan(mid);
    }
  });

  it('vanishes at the extremes', () => {
    expect(takerFee(100, 0.9999, 0.07)).toBeLessThan(0.001);
  });

  it('is proportionally largest on cheap shares', () => {
    // As a fraction of notional the fee is rate × (1 - p), so a 5¢ share costs
    // far more to trade than a 50¢ one relative to the amount staked.
    const cheapFraction = takerFee(100, 0.05, 0.05) / (100 * 0.05);
    const evenFraction = takerFee(100, 0.5, 0.05) / (100 * 0.5);

    expect(cheapFraction).toBeCloseTo(0.05 * 0.95, 10);
    expect(cheapFraction).toBeGreaterThan(evenFraction);
  });

  it('scales linearly with size', () => {
    expect(takerFee(200, 0.5, 0.05)).toBeCloseTo(2 * takerFee(100, 0.5, 0.05), 12);
  });

  it('rounds below the minimum to zero', () => {
    const tiny = takerFee(0.000001, 0.5, 0.05);
    expect(tiny).toBe(0);
    expect(takerFee(100, 0.5, 0.05)).toBeGreaterThan(MIN_FEE_USDC);
  });

  it('is zero for a non-positive or non-finite size', () => {
    expect(takerFee(0, 0.5)).toBe(0);
    expect(takerFee(-10, 0.5)).toBe(0);
    expect(takerFee(Number.NaN, 0.5)).toBe(0);
  });

  it('is concave in price, which is why it must be charged per level', () => {
    // Charging once at the average of two prices understates the true total.
    const perLevel = takerFee(100, 0.1, 0.05) + takerFee(100, 0.9, 0.05);
    const atAverage = takerFee(200, 0.5, 0.05);
    expect(perLevel).toBeLessThan(atAverage);
  });
});

describe('fee schedule', () => {
  it('matches the published rates', () => {
    expect(TAKER_FEE_RATES.crypto).toBe(0.07);
    expect(TAKER_FEE_RATES.sports).toBe(0.05);
    expect(TAKER_FEE_RATES.finance).toBe(0.04);
    expect(TAKER_FEE_RATES.politics).toBe(0.04);
    expect(TAKER_FEE_RATES.tech).toBe(0.04);
    expect(TAKER_FEE_RATES.geopolitics).toBe(0);
  });

  it('charges makers nothing', () => {
    expect(MAKER_FEE_RATE).toBe(0);
  });

  it('defaults to the most expensive rate when the category is unknown', () => {
    // An unknown category must make an opportunity look worse, never better.
    expect(DEFAULT_TAKER_FEE_RATE).toBe(Math.max(...Object.values(TAKER_FEE_RATES)));
    expect(feeRateFor(null)).toBe(DEFAULT_TAKER_FEE_RATE);
    expect(feeRateFor(undefined)).toBe(DEFAULT_TAKER_FEE_RATE);
    expect(feeRateFor('not-a-category')).toBe(DEFAULT_TAKER_FEE_RATE);
  });

  it('looks up a known category case-insensitively', () => {
    expect(feeRateFor('Crypto')).toBe(0.07);
    expect(feeRateFor('GEOPOLITICS')).toBe(0);
  });

  it('does not confuse a prototype property for a category', () => {
    expect(feeRateFor('toString')).toBe(DEFAULT_TAKER_FEE_RATE);
    expect(feeRateFor('constructor')).toBe(DEFAULT_TAKER_FEE_RATE);
  });
});

describe('resolveFeeRate — venue flag plus published schedule', () => {
  it('treats a base_fee of 0 as authoritative: the market is fee-free', () => {
    // Sampling 2,000 live markets, base_fee was 0 on exactly the documented
    // carve-out (Duma seats, Greenland, Maduro, Iran). That zero is the venue
    // itself saying there is no fee, so it wins over any category guess.
    expect(resolveFeeRate({ baseFeeBps: 0 })).toBe(0);
    expect(resolveFeeRate({ baseFeeBps: 0, category: 'crypto' })).toBe(0);
  });

  it('IGNORES the magnitude of a non-zero base_fee', () => {
    // The spec calls base_fee "basis points" and the live value is 1000, which
    // read literally is 10% — between 1.4x and 2.5x every published rate. It
    // only ever takes two values, so it cannot be carrying a per-category rate.
    // Anyone "fixing" this by dividing by 10,000 breaks the cost model.
    expect(resolveFeeRate({ baseFeeBps: FEE_ENABLED_SENTINEL_BPS, category: 'politics' })).toBe(0.04);
    expect(resolveFeeRate({ baseFeeBps: 999_999, category: 'politics' })).toBe(0.04);
    expect(resolveFeeRate({ baseFeeBps: FEE_ENABLED_SENTINEL_BPS })).toBe(DEFAULT_TAKER_FEE_RATE);
    expect(FEE_ENABLED_SENTINEL_BPS / 10_000).toBeGreaterThan(Math.max(...Object.values(TAKER_FEE_RATES)));
  });

  it('falls back to the conservative rate when nothing is known', () => {
    expect(resolveFeeRate({})).toBe(DEFAULT_TAKER_FEE_RATE);
    expect(resolveFeeRate({ baseFeeBps: null })).toBe(DEFAULT_TAKER_FEE_RATE);
  });

  it('uses the category for magnitude when fees are on', () => {
    expect(resolveFeeRate({ baseFeeBps: 1000, category: 'crypto' })).toBe(0.07);
    expect(resolveFeeRate({ baseFeeBps: 1000, category: 'finance' })).toBe(0.04);
  });
});
