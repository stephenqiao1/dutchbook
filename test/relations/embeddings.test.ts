import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  embeddingText,
} from '../../src/relations/embeddings.js';

describe('embeddingText', () => {
  it('collapses the whitespace the vendor leaves in question text', () => {
    expect(embeddingText('  Will BTC   reach\n$100,000?  ')).toBe('Will BTC reach $100,000?');
  });

  it('is idempotent', () => {
    const once = embeddingText('Will  BTC\treach $100,000?');
    expect(embeddingText(once)).toBe(once);
  });

  it('preserves the numbers that distinguish rungs of a ladder', () => {
    // Two markets in a ladder differ only in a threshold. Normalising it away
    // would make every rung embed identically and the index useless.
    expect(embeddingText('Will BTC reach $100,000?')).not.toBe(
      embeddingText('Will BTC reach $90,000?'),
    );
  });
});

/** A unit vector in the first two components, zero elsewhere. */
function unit(x: number, y: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  v[0] = x;
  v[1] = y;
  return v;
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity(unit(1, 0), unit(1, 0))).toBeCloseTo(1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(unit(1, 0), unit(0, 1))).toBeCloseTo(0, 10);
  });

  it('is -1 for opposed vectors', () => {
    expect(cosineSimilarity(unit(1, 0), unit(-1, 0))).toBeCloseTo(-1, 10);
  });

  it('agrees with the cosine of the angle between them', () => {
    const theta = 0.3;
    expect(cosineSimilarity(unit(1, 0), unit(Math.cos(theta), Math.sin(theta)))).toBeCloseTo(
      Math.cos(theta),
      10,
    );
  });

  it('returns 0 rather than throwing on a length mismatch', () => {
    // Degrading beats throwing: a mismatched vector means a stale row, and a
    // similarity of 0 simply keeps the pair out of the candidate set.
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
