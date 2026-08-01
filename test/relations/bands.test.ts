import { describe, expect, it } from 'vitest';

import { bandsAreDisjoint, parseBand, type Band } from '../../src/relations/bands.js';

/**
 * The calibration harness claims its `mutually_exclusive` labels are arithmetic
 * rather than judgement. That claim rests entirely on these two functions, so a
 * bug here would not produce a visible failure — it would produce a confident,
 * wrong accuracy figure. Which is the worst kind.
 */

describe('parseBand', () => {
  it('reads a plain dollar band', () => {
    expect(parseBand('Will the price of Solana be between $180 and $190 on October 15?')).toEqual({
      prefix: 'Will the price of Solana be',
      suffix: 'on October 15?',
      low: 180,
      high: 190,
    });
  });

  it('applies magnitude suffixes', () => {
    const band = parseBand('Will BTC be between $104K and $105K on March 1?');
    expect(band).toMatchObject({ low: 104_000, high: 105_000 });
  });

  it('handles billions, as the net-worth markets use', () => {
    const band = parseBand("Will Elon Musk's net worth be between $340b and $350b on August 31?");
    expect(band).toMatchObject({ low: 340e9, high: 350e9 });
  });

  it('strips thousands separators', () => {
    expect(parseBand('Will ETH be between $3,800 and $3,900 on September 29?')).toMatchObject({
      low: 3800,
      high: 3900,
    });
  });

  it('reads a band with no currency symbol', () => {
    expect(
      parseBand('Will the highest temperature in NYC be between 79 and 80 on August 19?'),
    ).toMatchObject({ low: 79, high: 80 });
  });

  it('returns null when the bounds are inverted or equal', () => {
    expect(parseBand('Will X be between $190 and $180 on October 15?')).toBeNull();
    expect(parseBand('Will X be between $180 and $180 on October 15?')).toBeNull();
  });

  it('returns null for a question with no band', () => {
    expect(parseBand('Will the price of Solana be above $180 on October 15?')).toBeNull();
  });
});

const band = (low: number, high: number, prefix = 'P', suffix = 'S'): Band => ({
  prefix,
  suffix,
  low,
  high,
});

describe('bandsAreDisjoint', () => {
  it('is true for adjacent, non-overlapping ranges', () => {
    // Polymarket bands are half-open in practice: [180,190) then [190,200).
    expect(bandsAreDisjoint(band(180, 190), band(190, 200))).toBe(true);
  });

  it('is true for separated ranges in either order', () => {
    expect(bandsAreDisjoint(band(180, 190), band(220, 230))).toBe(true);
    expect(bandsAreDisjoint(band(220, 230), band(180, 190))).toBe(true);
  });

  it('is FALSE for overlapping ranges', () => {
    // Overlapping bands can both contain the settlement price, so labelling
    // them mutually exclusive would make the ground truth wrong.
    expect(bandsAreDisjoint(band(180, 195), band(190, 200))).toBe(false);
  });

  it('is false for a range nested inside another', () => {
    expect(bandsAreDisjoint(band(180, 200), band(185, 190))).toBe(false);
  });

  it('is false when the subject differs', () => {
    // Solana in [180,190) and Bitcoin in [220,230) are not exclusive at all.
    expect(bandsAreDisjoint(band(180, 190, 'Solana'), band(220, 230, 'Bitcoin'))).toBe(false);
  });

  it('is false when the date differs', () => {
    expect(
      bandsAreDisjoint(band(180, 190, 'P', 'on Oct 15?'), band(220, 230, 'P', 'on Oct 16?')),
    ).toBe(false);
  });

  it('agrees with parseBand on two real catalog questions', () => {
    const a = parseBand('Will the price of Solana be between $180 and $190 on October 15?');
    const b = parseBand('Will the price of Solana be between $220 and $230 on October 15?');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(bandsAreDisjoint(a!, b!)).toBe(true);
  });
});
