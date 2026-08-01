import type { RelationEdge } from './types.js';

/**
 * Temporal nesting.
 *
 *   US strikes Iran by December 31, 2025?
 *   US strikes Iran by December 31, 2026?
 *
 * A deadline market asks whether an event occurs *at any point up to* its date,
 * so the shorter window is contained in the longer one and the earlier deadline
 * entails the later: P(by June 30) <= P(by December 31).
 *
 * The distinction that makes this sound is deadline versus instant. "by" and
 * "before" accumulate; "on" and "at" do not. `above $2.70 on September 4` says
 * nothing whatever about September 5 — the price can fall back — so a market
 * phrased that way is refused however much it looks like a date.
 *
 * Pure and total.
 */

/** Only these accumulate. `on`, `at`, `during` are instants or fixed windows. */
const DEADLINE_PREPOSITIONS = /\b(?:by|before|prior\s+to|no\s+later\s+than)\b/i;

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

/**
 * A deadline clause at the very end of the question.
 *
 * Anchored to the end because a "by" in the middle is usually a magnitude —
 * "inflation increase **by** 2.2%", "Kamala lead in RCP **by** 0-0.4" — and
 * reading those as deadlines would group unrelated markets.
 */
const DEADLINE_CLAUSE = new RegExp(
  String.raw`\s*(?:by|before|prior\s+to|no\s+later\s+than)\s+` +
    String.raw`(?:the\s+end\s+of\s+)?` +
    String.raw`(` +
    String.raw`${MONTH}\s*\d{0,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?` +
    String.raw`|\d{1,2}/\d{1,2}(?:/\d{2,4})?` +
    String.raw`|(?:Q[1-4]\s*)?\d{4}` +
    String.raw`)\s*\??\s*$`,
  'i',
);

/** An instant, not a deadline — present anywhere, the question is refused. */
const INSTANT_CLAUSE = new RegExp(
  String.raw`\b(?:on|at)\s+(?:the\s+)?(?:${MONTH}|\d{1,2}/\d{1,2})`,
  'i',
);

export interface TemporalParse {
  /** Deadline clause removed, whitespace collapsed, lowercased. */
  readonly subject: string;
  /** The deadline as written, lowercased — `december 31, 2025`. */
  readonly deadlineText: string;
}

function tidy(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a question into subject and deadline, or returns null.
 *
 * Null for: no trailing deadline clause, a "by" that turns out to be a
 * magnitude, an instant date anywhere in the question, or an empty subject.
 */
export function parseDeadlineQuestion(question: string): TemporalParse | null {
  if (typeof question !== 'string') return null;

  const text = tidy(question);
  if (text === '') return null;
  if (!DEADLINE_PREPOSITIONS.test(text)) return null;

  const match = DEADLINE_CLAUSE.exec(text);
  if (match === null) return null;

  const subject = tidy(text.slice(0, match.index))
    .replace(/[\s,;:–—-]+$/g, '')
    .toLowerCase();
  if (subject === '') return null;

  // `... above $2.70 on September 4 by 2026?` — an instant survives in the
  // subject, so the market is pinned to a moment and does not nest.
  if (INSTANT_CLAUSE.test(subject)) return null;

  return { subject, deadlineText: tidy(match[1] ?? '').toLowerCase() };
}

export interface TemporalMarket {
  readonly conditionId: string;
  readonly question: string;
  /**
   * Resolution timestamp. Required: it is what the chain is ordered by. The
   * written deadline is often yearless ("by June 30"), and guessing a year to
   * sort by would be inventing the very fact the edge depends on.
   */
  readonly endDate?: Date | string | null;
}

export interface TemporalChain {
  readonly subject: string;
  /** Ordered by ascending deadline. */
  readonly rungs: ReadonlyArray<{
    readonly market: TemporalMarket;
    readonly parse: TemporalParse;
    readonly deadline: Date;
  }>;
}

function toDate(value: TemporalMarket['endDate']): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Groups deadline markets whose subject is character-identical after
 * normalization.
 *
 * Exact match only, as required — no stemming, no fuzzy distance. Two questions
 * that differ by a single word are two different questions, and the cost of
 * being wrong here is an entailment that does not hold.
 */
export function groupTemporalChains(markets: Iterable<TemporalMarket>): TemporalChain[] {
  const chains = new Map<string, TemporalChain['rungs'][number][]>();

  for (const market of markets) {
    if (typeof market?.conditionId !== 'string' || market.conditionId === '') continue;

    const parse = parseDeadlineQuestion(market.question);
    if (parse === null) continue;

    const deadline = toDate(market.endDate);
    if (deadline === null) continue;

    const bucket = chains.get(parse.subject);
    const rung = { market, parse, deadline };
    if (bucket === undefined) chains.set(parse.subject, [rung]);
    else bucket.push(rung);
  }

  const out: TemporalChain[] = [];
  for (const [subject, rungs] of chains) {
    if (rungs.length < 2) continue;
    out.push({
      subject,
      rungs: rungs.toSorted((a, b) => a.deadline.getTime() - b.deadline.getTime()),
    });
  }

  return out.toSorted((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}

export interface TemporalEdgeOptions {
  /** Every ordered pair rather than only adjacent deadlines. Default false. */
  readonly transitive?: boolean;
}

/**
 * Edges from the earlier deadline to the later one.
 *
 * Rungs sharing a deadline produce nothing: two markets resolving at the same
 * instant are the same window, and neither contains the other.
 */
export function temporalEdges(
  chain: TemporalChain,
  options: TemporalEdgeOptions = {},
): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const rungs = chain.rungs;

  for (let i = 0; i < rungs.length; i += 1) {
    const limit = options.transitive === true ? rungs.length : Math.min(i + 2, rungs.length);

    for (let j = i + 1; j < limit; j += 1) {
      const earlier = rungs[i];
      const later = rungs[j];
      if (earlier === undefined || later === undefined) continue;
      if (earlier.deadline.getTime() === later.deadline.getTime()) continue;
      if (earlier.market.conditionId === later.market.conditionId) continue;

      edges.push({
        fromConditionId: earlier.market.conditionId,
        toConditionId: later.market.conditionId,
        type: 'implies',
        source: 'temporal',
        confidence: 1,
        rationale:
          `Same subject "${chain.subject}" with nested deadlines: occurring by ` +
          `${earlier.parse.deadlineText} entails occurring by ${later.parse.deadlineText}, ` +
          `so P(by ${earlier.parse.deadlineText}) <= P(by ${later.parse.deadlineText}).`,
      });
    }
  }

  return edges;
}

export interface TemporalExtraction {
  readonly chains: readonly TemporalChain[];
  readonly edges: readonly RelationEdge[];
  readonly stats: {
    readonly marketsConsidered: number;
    readonly marketsParsed: number;
    readonly marketsInChains: number;
    readonly chains: number;
    readonly edges: number;
  };
}

export function extractTemporalRelations(
  markets: Iterable<TemporalMarket>,
  options: TemporalEdgeOptions = {},
): TemporalExtraction {
  const all = [...markets];
  const chains = groupTemporalChains(all);
  const edges = chains.flatMap((chain) => temporalEdges(chain, options));

  let parsed = 0;
  for (const market of all) {
    if (parseDeadlineQuestion(market.question) !== null) parsed += 1;
  }

  return {
    chains,
    edges,
    stats: {
      marketsConsidered: all.length,
      marketsParsed: parsed,
      marketsInChains: chains.reduce((sum, c) => sum + c.rungs.length, 0),
      chains: chains.length,
      edges: edges.length,
    },
  };
}
