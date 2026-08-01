/**
 * Band arithmetic.
 *
 * A *band* market asks whether a quantity lands inside a numeric interval —
 * `between $104K and $105K`. Bands are the largest numeric family in the
 * catalog and the reason threshold-ladder coverage is 8.85% rather than higher:
 * they carry two numbers and no monotone order, so the ladder extractor
 * deliberately refuses them (see `ladders.ts`).
 *
 * What they do carry is exclusivity. Two non-overlapping intervals over the
 * same subject and the same date cannot both contain the settlement value. That
 * is arithmetic rather than judgement, which is what makes it usable as ground
 * truth for scoring a classifier.
 *
 * Pure and total, like every other extractor here: no I/O, no clock, and `null`
 * rather than a throw on anything it cannot read.
 */

/** `... between $180 and $190 on October 15?` → prefix, two magnitudes, suffix. */
const BAND = /^(.*?)between\s+\$?([\d,.]+)\s*([KkMmBb]?)\s+and\s+\$?([\d,.]+)\s*([KkMmBb]?)(.*)$/;

const SCALE: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9 };

function magnitude(digits: string, suffix: string): number {
  const value = Number(digits.replaceAll(',', ''));
  if (!Number.isFinite(value)) return Number.NaN;
  return value * (SCALE[suffix.toLowerCase()] ?? 1);
}

export interface Band {
  /** Everything before `between` — the subject. */
  readonly prefix: string;
  /** Everything after the upper bound — usually the date. */
  readonly suffix: string;
  readonly low: number;
  readonly high: number;
}

export function parseBand(question: string): Band | null {
  const match = BAND.exec(question);
  if (match === null) return null;

  const [, prefix, lowDigits, lowSuffix, highDigits, highSuffix, suffix] = match;
  const low = magnitude(lowDigits ?? '', lowSuffix ?? '');
  const high = magnitude(highDigits ?? '', highSuffix ?? '');

  // An inverted or degenerate interval is a phrasing this parser does not
  // understand, not a band with unusual bounds.
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) return null;

  return { prefix: (prefix ?? '').trim(), suffix: (suffix ?? '').trim(), low, high };
}

/**
 * True when two bands cannot both contain the same outcome.
 *
 * Subject and date must match character-for-character — the same conservatism
 * the other extractors use. Solana in [180, 190) and Bitcoin in [220, 230) are
 * not exclusive at all, and a looser comparison would silently say they are.
 *
 * Bounds are treated as half-open, matching how the venue writes consecutive
 * bands: `$180–$190` followed by `$190–$200` is a partition, not an overlap.
 */
export function bandsAreDisjoint(a: Band, b: Band): boolean {
  if (a.prefix !== b.prefix || a.suffix !== b.suffix) return false;
  return a.high <= b.low || b.high <= a.low;
}
