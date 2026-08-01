/**
 * Deterministic relation extraction for threshold ladders.
 *
 * A ladder is a family of markets sharing a subject and a resolution date and
 * differing only in a numeric threshold:
 *
 *   Will the price of XRP be above $2.70 on September 4 at 12PM ET?
 *   Will the price of XRP be above $2.73 on September 4 at 12PM ET?
 *   Will the price of XRP be above $2.76 on September 4 at 12PM ET?
 *
 * Within such a family the constraint is arithmetic, not statistical: if the
 * price exceeds $2.76 it necessarily exceeds $2.73, so P(2.76) <= P(2.73). That
 * is why these edges carry confidence 1.0 — they are entailments, not guesses.
 *
 * Everything here is pure and total. No network, no LLM, no clock, no I/O; a
 * question it cannot read yields `null` rather than an exception. Persisting
 * the result is a separate, explicit step.
 *
 * The parser is deliberately conservative. A false edge asserts a probability
 * bound that is not true, which corrupts anything built on top; a missed edge
 * only costs coverage. Every ambiguity below resolves toward `null`.
 */

import type { RelationEdge } from './types.js';

export type { RelationEdge };

/** Which way the family runs. */
export type Direction = 'gt' | 'lt';

/**
 * The dimension a threshold is measured in. Two markets can only be compared
 * within one unit — `$120,000` and `120%` are not rungs of the same ladder.
 */
export type ThresholdUnit = 'usd' | 'percent' | 'bps' | 'temperature' | 'count';

export interface ThresholdParse {
  /** Threshold and date clauses removed, whitespace collapsed, lowercased. */
  readonly subject: string;
  readonly direction: Direction;
  /** True for "at least"/"or higher"/"25+"; false for a strict "above". */
  readonly inclusive: boolean;
  /** Always in the unit's base: `$104K` is 104000, `25 bps` is 25. */
  readonly threshold: number;
  readonly unit: ThresholdUnit;
  /** The temporal phrase as written, lowercased — `on september 4 at 12pm et`. */
  readonly dateText: string | null;
}

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

/**
 * Phrasings that look numeric but are not monotone thresholds.
 *
 * Bands are the important one: 10,064 markets in the live catalog are phrased
 * `between $104K and $105K`. A band does not imply its neighbour in either
 * direction — the price landing in [104K, 105K] says nothing about it landing
 * in [103K, 104K] — so reading the first number as a threshold would emit
 * implications that are simply false.
 */
const BAND_PATTERNS: readonly RegExp[] = [
  /\bbetween\b[^?]*\band\b/i,
  // `$42-49m`, `25-30%`, `12–18%`, `1-25 bps` — a range written with a dash.
  /\d\s*(?:–|—|-|\bto\b)\s*\$?\d/,
];

/**
 * The catalog contains ~2,350 bare `Over 231.5` sports lines. Stripping the
 * threshold leaves an empty subject, so on subject-and-date alone every one of
 * them sharing a date collapses into a single group and links unrelated games.
 *
 * They are not discarded, because inside a single event they are a genuine
 * ladder — the same game's over/under lines. `groupLadders` admits an empty
 * subject only when an event id is supplying the identity instead.
 */

/** `$100k`, `40+`, `12%`, `25 bps` still present after the clause was removed. */
const RESIDUAL_THRESHOLD = /\$\s*\d|\d\s*\+|\d\s*%|\d\s*(?:bps|basis\s*points?)\b/i;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const MULTIPLIERS: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9 };

/** Written-out scales, which Polymarket mixes freely with the letter forms. */
const WORD_MULTIPLIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^thousand\b/, 1e3],
  [/^million\b/, 1e6],
  [/^billion\b/, 1e9],
  [/^trillion\b/, 1e12],
  [/^bn\b/, 1e9],
];

/** `$115,000` · `$104K` · `2,900` · `3.30` · `231.5` */
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;

interface ParsedNumber {
  readonly value: number;
  readonly unit: ThresholdUnit;
}

/**
 * Reads one numeric literal with its unit markers.
 *
 * `hadDollar` is passed in rather than re-detected because the `$` sits before
 * the digits and the suffix after them, and both feed the same decision.
 */
function readNumber(digits: string, hadDollar: boolean, suffix: string): ParsedNumber | null {
  const magnitude = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(magnitude)) return null;

  const tail = suffix.trim().toLowerCase();

  // Basis points before percent: "25 bps" must not be read as a bare count.
  if (/^(?:bps|bp\b|basis\s*points?)/.test(tail)) return { value: magnitude, unit: 'bps' };
  if (tail.startsWith('%') || tail.startsWith('percent')) return { value: magnitude, unit: 'percent' };
  if (/^°?[fc]\b/.test(tail)) return { value: magnitude, unit: 'temperature' };

  for (const [pattern, factor] of WORD_MULTIPLIERS) {
    if (pattern.test(tail)) return { value: magnitude * factor, unit: hadDollar ? 'usd' : 'count' };
  }

  const scale = MULTIPLIERS[tail.charAt(0)] ?? 1;
  // A bare `K`/`M`/`B` only scales a currency amount. "Will X win 3 M..." is
  // not 3 million of anything.
  if (hadDollar) return { value: magnitude * scale, unit: 'usd' };
  if (scale !== 1 && /^[kmb]\b/.test(tail)) return { value: magnitude * scale, unit: 'count' };

  return { value: magnitude, unit: 'count' };
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

interface ComparatorMatch {
  readonly direction: Direction;
  readonly inclusive: boolean;
  readonly threshold: number;
  readonly unit: ThresholdUnit;
  /** Slice of the question the clause occupied, removed to leave the subject. */
  readonly start: number;
  readonly end: number;
}

const UNIT_SUFFIX = String.raw`\s*(?:%|°?[FC]\b|bps\b|bp\b|basis\s*points?|percent|thousand\b|million\b|billion\b|trillion\b|bn\b|[KMB]\b)?`;

/** Comparator before the number: "above $120,000", "at least 25 bps". */
const PREFIX_COMPARATORS: ReadonlyArray<{
  readonly words: string;
  readonly direction: Direction;
  readonly inclusive: boolean;
}> = [
  { words: String.raw`at\s+least`, direction: 'gt', inclusive: true },
  { words: String.raw`greater\s+than\s+or\s+equal\s+to`, direction: 'gt', inclusive: true },
  { words: String.raw`no\s+less\s+than`, direction: 'gt', inclusive: true },
  { words: String.raw`more\s+than`, direction: 'gt', inclusive: false },
  { words: String.raw`greater\s+than`, direction: 'gt', inclusive: false },
  { words: String.raw`above`, direction: 'gt', inclusive: false },
  { words: String.raw`over`, direction: 'gt', inclusive: false },
  { words: String.raw`exceeds?`, direction: 'gt', inclusive: false },
  { words: String.raw`≥|>=`, direction: 'gt', inclusive: true },
  { words: String.raw`>`, direction: 'gt', inclusive: false },

  // Touch verbs. "reach $120k" is max-over-the-window >= 120k, which is
  // monotone the same way a level threshold is: reaching 120k entails
  // reaching 110k. "dip to $3,400" is min-over-the-window <= 3,400, monotone
  // downward. These are ~4.7k markets the level comparators alone all miss.
  { words: String.raw`reach(?:es|ed)?(?:\s+to)?`, direction: 'gt', inclusive: true },
  { words: String.raw`hits?`, direction: 'gt', inclusive: true },
  { words: String.raw`surpass(?:es|ed)?`, direction: 'gt', inclusive: false },
  { words: String.raw`cross(?:es|ed)?`, direction: 'gt', inclusive: false },
  { words: String.raw`climbs?\s+to`, direction: 'gt', inclusive: true },
  { words: String.raw`rises?\s+to`, direction: 'gt', inclusive: true },
  { words: String.raw`tops`, direction: 'gt', inclusive: false },

  { words: String.raw`dips?\s+to`, direction: 'lt', inclusive: true },
  { words: String.raw`falls?\s+to`, direction: 'lt', inclusive: true },
  { words: String.raw`drops?\s+to`, direction: 'lt', inclusive: true },
  { words: String.raw`declines?\s+to`, direction: 'lt', inclusive: true },
  { words: String.raw`sinks?\s+to`, direction: 'lt', inclusive: true },

  { words: String.raw`at\s+most`, direction: 'lt', inclusive: true },
  { words: String.raw`no\s+more\s+than`, direction: 'lt', inclusive: true },
  { words: String.raw`less\s+than\s+or\s+equal\s+to`, direction: 'lt', inclusive: true },
  { words: String.raw`less\s+than`, direction: 'lt', inclusive: false },
  { words: String.raw`fewer\s+than`, direction: 'lt', inclusive: false },
  { words: String.raw`below`, direction: 'lt', inclusive: false },
  { words: String.raw`under`, direction: 'lt', inclusive: false },
  { words: String.raw`≤|<=`, direction: 'lt', inclusive: true },
  { words: String.raw`<`, direction: 'lt', inclusive: false },
];

/** Comparator after the number: "49.0% or higher", "52°F or below". */
const SUFFIX_COMPARATORS: ReadonlyArray<{
  readonly words: string;
  readonly direction: Direction;
  readonly inclusive: boolean;
}> = [
  { words: String.raw`or\s+(?:higher|above|more|greater|better)`, direction: 'gt', inclusive: true },
  { words: String.raw`or\s+(?:lower|below|less|fewer|worse)`, direction: 'lt', inclusive: true },
];

function findComparator(question: string): ComparatorMatch | null {
  const candidates: ComparatorMatch[] = [];

  for (const { words, direction, inclusive } of PREFIX_COMPARATORS) {
    const re = new RegExp(String.raw`(?:${words})\s*(\$)?\s*(${NUMBER})(${UNIT_SUFFIX})`, 'i');
    const m = re.exec(question);
    if (m?.index === undefined) continue;

    const number = readNumber(m[2] ?? '', m[1] === '$', m[3] ?? '');
    if (number === null) continue;

    candidates.push({
      direction,
      inclusive,
      threshold: number.value,
      unit: number.unit,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  for (const { words, direction, inclusive } of SUFFIX_COMPARATORS) {
    const re = new RegExp(String.raw`(\$)?\s*(${NUMBER})(${UNIT_SUFFIX})\s*(?:${words})`, 'i');
    const m = re.exec(question);
    if (m?.index === undefined) continue;

    const number = readNumber(m[2] ?? '', m[1] === '$', m[3] ?? '');
    if (number === null) continue;

    candidates.push({
      direction,
      inclusive,
      threshold: number.value,
      unit: number.unit,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // `25+ bps`, `10+ times`, `1,475+ Measles cases` — the plus means "at least".
  const plus = new RegExp(String.raw`(\$)?\s*(${NUMBER})\s*\+(${UNIT_SUFFIX})`, 'i').exec(question);
  if (plus?.index !== undefined) {
    const number = readNumber(plus[2] ?? '', plus[1] === '$', plus[3] ?? '');
    if (number !== null) {
      candidates.push({
        direction: 'gt',
        inclusive: true,
        threshold: number.value,
        unit: number.unit,
        start: plus.index,
        end: plus.index + plus[0].length,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Two different comparators in one question means it is not a simple
  // threshold — a compound condition, or a band this far missed. Refuse it
  // rather than pick one and be confidently wrong.
  const distinct = new Set(candidates.map((c) => `${c.direction}:${c.threshold}:${c.unit}`));
  if (distinct.size > 1) return null;

  return candidates.reduce((best, c) => (c.start < best.start ? c : best));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTH =
  String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

/**
 * A trailing temporal clause: `on September 4 at 12PM ET`, `by August 1`,
 * `after the April 2026 meeting`, `before 2027`, `in January 2025`.
 *
 * Anchored to a month name or a four-digit year so that "in the Senate" or
 * "by Trump" are not mistaken for dates.
 */
const DATE_CLAUSE = new RegExp(
  String.raw`\b(?:on|by|before|after|during|in|at)\s+` +
    String.raw`(?:the\s+)?` +
    String.raw`(?:${MONTH}|\d{4}|\d{1,2}/\d{1,2}(?:/\d{2,4})?)` +
    // Trailing `\??` matters: nearly every question ends in a question mark, and
    // `[^?]*$` can never reach the anchor when one is present.
    String.raw`[^?]*\??\s*$`,
  'i',
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function tidy(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trims connective debris left behind once a clause is cut out. */
function tidySubject(text: string): string {
  return tidy(text)
    .replace(/[\s,;:–—-]+$/g, '')
    .replace(/\s+(?:be|is|are|was|were|reach|hit|close|closes|at|of|by|to)$/i, '')
    .replace(/[\s,;:–—-]+$/g, '')
    .replace(/^\W+/, '')
    .trim();
}

/**
 * Reads `(subject, comparator, threshold, unit, date)` out of a question.
 *
 * Returns `null` — never throws — for anything it cannot read with certainty:
 * bands, compound comparators, questions with no numeric threshold, and
 * questions whose subject vanishes once the threshold is removed.
 */
export function parseThresholdQuestion(question: string): ThresholdParse | null {
  if (typeof question !== 'string') return null;

  const text = tidy(question);
  if (text === '') return null;

  for (const pattern of BAND_PATTERNS) {
    if (pattern.test(text)) return null;
  }

  const comparator = findComparator(text);
  if (comparator === null) return null;

  const withoutThreshold = `${text.slice(0, comparator.start)} ${text.slice(comparator.end)}`;

  const dateMatch = DATE_CLAUSE.exec(withoutThreshold);
  const dateText =
    dateMatch === null ? null : tidy(dateMatch[0]).replace(/[?\s]+$/, '').toLowerCase();
  const withoutDate =
    dateMatch === null ? withoutThreshold : withoutThreshold.slice(0, dateMatch.index);

  const subject = tidySubject(withoutDate).toLowerCase();

  // A second threshold surviving in the subject means the question carries more
  // than one numeric condition, and is therefore not a single rung:
  //
  //   "Will Bitcoin hit $80k or $100k first?"        -> a race, not a level
  //   "Parlay - Mahomes 225+ yards, Kelce 40+ yards" -> a conjunction of legs
  //
  // Both would otherwise parse on their first number and group with genuine
  // rungs. Bare numbers are fine — "10-year Treasury yield" and "day 1" are
  // part of the subject — so only threshold *markers* count.
  if (RESIDUAL_THRESHOLD.test(subject)) return null;

  return {
    subject,
    direction: comparator.direction,
    inclusive: comparator.inclusive,
    threshold: comparator.threshold,
    unit: comparator.unit,
    dateText,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface LadderMarket {
  readonly conditionId: string;
  readonly question: string;
  /** Resolution timestamp, when known. Tightens grouping; never loosens it. */
  readonly endDate?: Date | string | null;
  /**
   * Owning event. Joins the grouping key when present, and only ever splits a
   * group — see `scopeToEvent`.
   */
  readonly eventId?: string | null;
}

export interface GroupLaddersOptions {
  /**
   * Require ladder members to share an event. Default true.
   *
   * Subject-plus-date alone is not always enough to identify a family. The live
   * catalog contains generic subjects on placeholder dates — "will there be
   * combined points scored?" resolving 2024-10-26, asked of every game that
   * night — where grouping on subject and date merges unrelated markets and
   * emits implications between different basketball games. Event scoping is a
   * pure tightening: it can split a real ladder, never invent one.
   *
   * Set false to group strictly on subject and date.
   */
  readonly scopeToEvent?: boolean;
}

export interface LadderRung {
  readonly market: LadderMarket;
  readonly parse: ThresholdParse;
}

export interface Ladder {
  readonly key: string;
  readonly subject: string;
  readonly direction: Direction;
  readonly unit: ThresholdUnit;
  readonly dateKey: string;
  /** Ordered by ascending threshold. */
  readonly rungs: readonly LadderRung[];
}

function dateKeyOf(parse: ThresholdParse, endDate: LadderMarket['endDate']): string | null {
  const resolved =
    endDate instanceof Date
      ? endDate.toISOString()
      : typeof endDate === 'string' && endDate !== ''
        ? endDate
        : null;

  // Both are used when both exist. `on September 4` carries no year, so text
  // alone would merge this September with next September; `end_date` alone
  // would merge a noon settlement with an 8PM one only if they truly coincide.
  if (parse.dateText !== null && resolved !== null) return `${parse.dateText}@${resolved}`;
  if (parse.dateText !== null) return parse.dateText;
  if (resolved !== null) return resolved;

  // No date from either source: there is no way to tell this market apart from
  // the same question asked about a different week.
  return null;
}

/**
 * Groups markets into ladders by exact match on normalized subject and date.
 *
 * Direction and unit join the key because a ladder is one monotone family:
 * "above $100" and "below $100" constrain each other, but not by the rule this
 * module encodes, and dollars and percentages do not compare at all.
 *
 * No fuzzy matching. Subjects match exactly or they are different ladders.
 */
export function groupLadders(
  markets: Iterable<LadderMarket>,
  options: GroupLaddersOptions = {},
): Ladder[] {
  const scopeToEvent = options.scopeToEvent ?? true;
  const groups = new Map<string, { rungs: LadderRung[]; parse: ThresholdParse; dateKey: string }>();

  for (const market of markets) {
    if (typeof market?.conditionId !== 'string' || market.conditionId === '') continue;

    const parse = parseThresholdQuestion(market.question);
    if (parse === null) continue;

    const dateKey = dateKeyOf(parse, market.endDate);
    if (dateKey === null) continue;

    const scope =
      scopeToEvent && typeof market.eventId === 'string' && market.eventId !== ''
        ? market.eventId
        : '';

    // With no subject there is nothing to identify the market by, so an event
    // must supply that identity. Otherwise every bare `Over 231.5` on a given
    // date would join one group spanning unrelated games.
    if (parse.subject === '' && scope === '') continue;
    const key = [scope, parse.subject, parse.direction, parse.unit, dateKey].join(' ');
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { rungs: [{ market, parse }], parse, dateKey });
    else existing.rungs.push({ market, parse });
  }

  const ladders: Ladder[] = [];
  for (const [key, group] of groups) {
    if (group.rungs.length < 2) continue;

    ladders.push({
      key,
      subject: group.parse.subject,
      direction: group.parse.direction,
      unit: group.parse.unit,
      dateKey: group.dateKey,
      rungs: group.rungs.toSorted((a, b) => a.parse.threshold - b.parse.threshold),
    });
  }

  // Stable output so a re-run writes the same rows in the same order.
  return ladders.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface LadderEdgeOptions {
  /**
   * Emit an edge for every ordered pair rather than only adjacent rungs.
   *
   * Implication is transitive, so adjacent edges already encode the full
   * relation — an 88-rung ladder is 87 edges instead of 3,828. Turn this on
   * only for a consumer that will not compute the closure itself.
   */
  readonly transitive?: boolean;
}

function formatThreshold(parse: ThresholdParse): string {
  const { threshold, unit } = parse;
  switch (unit) {
    case 'usd':
      return `$${threshold.toLocaleString('en-US')}`;
    case 'percent':
      return `${threshold}%`;
    case 'bps':
      return `${threshold}bps`;
    case 'temperature':
      return `${threshold}°`;
    default:
      return String(threshold);
  }
}

/**
 * One edge per implication, from the stronger claim to the weaker one.
 *
 * For a `gt` family the higher rung implies the lower: exceeding $2.76 entails
 * exceeding $2.73. For an `lt` family it is the reverse — below $2.73 entails
 * below $2.76. Read `from implies to`, so P(from) <= P(to).
 *
 * Rungs at the same threshold produce no edge. `above $100` and `at least $100`
 * differ only at the boundary, and which implies which depends on inclusivity
 * rather than on the ladder — outside what this rule can assert.
 */
export function ladderEdges(ladder: Ladder, options: LadderEdgeOptions = {}): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const rungs = ladder.rungs;

  for (let i = 0; i < rungs.length; i += 1) {
    const limit = options.transitive === true ? rungs.length : Math.min(i + 2, rungs.length);

    for (let j = i + 1; j < limit; j += 1) {
      const lower = rungs[i];
      const higher = rungs[j];
      if (lower === undefined || higher === undefined) continue;
      if (lower.parse.threshold === higher.parse.threshold) continue;
      if (lower.market.conditionId === higher.market.conditionId) continue;

      // `gt`: the higher threshold is the stronger claim. `lt`: the lower one.
      const [strong, weak] = ladder.direction === 'gt' ? [higher, lower] : [lower, higher];

      const comparator = ladder.direction === 'gt' ? '>' : '<';
      edges.push({
        fromConditionId: strong.market.conditionId,
        toConditionId: weak.market.conditionId,
        type: 'implies',
        source: 'ladder',
        confidence: 1,
        rationale:
          `Same threshold ladder on "${ladder.subject}" (${ladder.dateKey}): ` +
          `${comparator} ${formatThreshold(strong.parse)} entails ${comparator} ${formatThreshold(weak.parse)}, ` +
          `so P(${comparator} ${formatThreshold(strong.parse)}) <= P(${comparator} ${formatThreshold(weak.parse)}).`,
      });
    }
  }

  return edges;
}

export interface LadderExtraction {
  readonly ladders: readonly Ladder[];
  readonly edges: readonly RelationEdge[];
  readonly stats: {
    readonly marketsConsidered: number;
    readonly marketsParsed: number;
    readonly marketsInLadders: number;
    readonly ladders: number;
    readonly edges: number;
  };
}

/** Parses, groups, and emits edges in one pass. Pure. */
export function extractLadderRelations(
  markets: Iterable<LadderMarket>,
  options: LadderEdgeOptions & GroupLaddersOptions = {},
): LadderExtraction {
  const all = [...markets];
  const ladders = groupLadders(all, options);
  const edges = ladders.flatMap((ladder) => ladderEdges(ladder, options));

  let parsed = 0;
  for (const market of all) {
    if (parseThresholdQuestion(market.question) !== null) parsed += 1;
  }

  return {
    ladders,
    edges,
    stats: {
      marketsConsidered: all.length,
      marketsParsed: parsed,
      marketsInLadders: ladders.reduce((sum, l) => sum + l.rungs.length, 0),
      ladders: ladders.length,
      edges: edges.length,
    },
  };
}
