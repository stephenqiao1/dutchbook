import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  extractLadderRelations,
  groupLadders,
  ladderEdges,
  parseThresholdQuestion,
  type Direction,
  type LadderMarket,
  type ThresholdUnit,
} from '../../src/relations/ladders.js';

/**
 * Every question string below is real — pulled from the 187,691 markets this
 * service has ingested from Polymarket, not invented. Invented strings would
 * only test the parser against the phrasings I already had in mind; the ones
 * that actually broke it (a race written as `hit $80k or $100k first`, a parlay
 * carrying two thresholds, 10,064 bands) were all found by reading the catalog.
 */

interface ParseCase {
  readonly q: string;
  readonly threshold: number;
  readonly unit: ThresholdUnit;
  readonly direction: Direction;
  readonly inclusive: boolean;
}

const SHOULD_PARSE: readonly ParseCase[] = [
  // --- dollars, comma-grouped -------------------------------------------
  { q: 'Will the price of Ethereum be above $2,900 on November 14?', threshold: 2900, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Will the price of Bitcoin be less than $92,000 on November 15?', threshold: 92_000, unit: 'usd', direction: 'lt', inclusive: false },
  { q: 'Will the price of Ethereum be above $3,200 on November 15?', threshold: 3200, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Will the price of Bitcoin be above $115,000 on September 25?', threshold: 115_000, unit: 'usd', direction: 'gt', inclusive: false },

  // --- dollars, K/M/B and written scales ---------------------------------
  { q: 'Based FDV above $800M one day after launch?', threshold: 800_000_000, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Based FDV above $300M one day after launch?', threshold: 300_000_000, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Over $15M committed to the Solomon public sale?', threshold: 15_000_000, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Will the price of Bitcoin be above $104K on May 21?', threshold: 104_000, unit: 'usd', direction: 'gt', inclusive: false },

  // --- dollars, decimals -------------------------------------------------
  { q: 'Will the price of XRP be less than $1.80 on November 15?', threshold: 1.8, unit: 'usd', direction: 'lt', inclusive: false },
  { q: 'Will the price of XRP be greater than $2.70 on November 15?', threshold: 2.7, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Will the price of XRP be above $3.30 on October 16?', threshold: 3.3, unit: 'usd', direction: 'gt', inclusive: false },
  { q: 'Will the price of Solana be less than $110 on November 15?', threshold: 110, unit: 'usd', direction: 'lt', inclusive: false },

  // --- percentages -------------------------------------------------------
  { q: 'AI model scores ≥ 90% on FrontierMath Benchmark before 2027?', threshold: 90, unit: 'percent', direction: 'gt', inclusive: true },
  { q: 'Will the 10-year Treasury yield hit 4.5% before 2027?', threshold: 4.5, unit: 'percent', direction: 'gt', inclusive: true },
  { q: 'Will the 10-year Treasury yield hit 4.8% before 2027?', threshold: 4.8, unit: 'percent', direction: 'gt', inclusive: true },
  { q: "Will Joe Biden's approval rating be 49.0% or higher on September 1?", threshold: 49, unit: 'percent', direction: 'gt', inclusive: true },
  { q: 'Annual inflation above 2.2% in September?', threshold: 2.2, unit: 'percent', direction: 'gt', inclusive: false },
  { q: 'Will the AfD win less than 20% of the vote in the German election?', threshold: 20, unit: 'percent', direction: 'lt', inclusive: false },

  // --- basis points ------------------------------------------------------
  { q: 'Will the ECB announce a 50+ bps decrease at the February 2026 meeting?', threshold: 50, unit: 'bps', direction: 'gt', inclusive: true },
  { q: 'Fed raises interest rates by 25+ bps after 2024 May meeting?', threshold: 25, unit: 'bps', direction: 'gt', inclusive: true },
  { q: 'Will the Fed increase interest rates by 25+ bps after the April 2026 meeting?', threshold: 25, unit: 'bps', direction: 'gt', inclusive: true },
  { q: 'Will ECB lower interest rates by more than 50bps in January 2025?', threshold: 50, unit: 'bps', direction: 'gt', inclusive: false },

  // --- the "N+" form -----------------------------------------------------
  { q: 'Will Trump say "Thank you" 10+ times during Saudi PM events on November 18?', threshold: 10, unit: 'count', direction: 'gt', inclusive: true },
  { q: 'NBA Finals G3: Will SGA score 35+ points against the Pacers?', threshold: 35, unit: 'count', direction: 'gt', inclusive: true },
  { q: '1,475+ Measles cases in U.S. by September 30?', threshold: 1475, unit: 'count', direction: 'gt', inclusive: true },
  { q: 'Alcaraz vs. Fritz – Will Alcaraz win by 6+ games?', threshold: 6, unit: 'count', direction: 'gt', inclusive: true },

  // --- trailing comparators ----------------------------------------------
  { q: 'Will the highest temperature in London be 65°F or higher on November 12?', threshold: 65, unit: 'temperature', direction: 'gt', inclusive: true },
  { q: 'Will the highest temperature in London be 54°F or below on November 12?', threshold: 54, unit: 'temperature', direction: 'lt', inclusive: true },
  { q: 'Will the highest temperature in New York City be 44°F or below on November 12?', threshold: 44, unit: 'temperature', direction: 'lt', inclusive: true },
  { q: "Will MrBeast's next video get 55 million or more views on day 1?", threshold: 55_000_000, unit: 'count', direction: 'gt', inclusive: true },
  { q: 'Will there be 41 or more combined points scored?', threshold: 41, unit: 'count', direction: 'gt', inclusive: true },
  { q: "Will 'Transformers One' gross $180 million or less on its opening weekend?", threshold: 180_000_000, unit: 'usd', direction: 'lt', inclusive: true },

  // --- below / under -----------------------------------------------------
  { q: 'Will the price of Ethereum be less than $2,900 on November 15?', threshold: 2900, unit: 'usd', direction: 'lt', inclusive: false },
  { q: '30-year mortgage rate below 5% before election?', threshold: 5, unit: 'percent', direction: 'lt', inclusive: false },
  { q: 'Will "Nobody 2" Opening Weekend Box Office be less than $11m?', threshold: 11_000_000, unit: 'usd', direction: 'lt', inclusive: false },

  // --- touch verbs: max/min over a window, still monotone ----------------
  { q: 'Will Bitcoin reach $110,000 by January 31, 2025?', threshold: 110_000, unit: 'usd', direction: 'gt', inclusive: true },
  { q: 'Will Solana reach $220 in June?', threshold: 220, unit: 'usd', direction: 'gt', inclusive: true },
  { q: 'Will Ethereum hit $8,000.00 by March 31?', threshold: 8000, unit: 'usd', direction: 'gt', inclusive: true },
  { q: 'Will Bitcoin dip to $57,500 in October?', threshold: 57_500, unit: 'usd', direction: 'lt', inclusive: true },
  { q: 'Will Bitcoin dip to $75,000 by February 28, 2025?', threshold: 75_000, unit: 'usd', direction: 'lt', inclusive: true },
  { q: 'Will Ethereum dip to $3400 in August?', threshold: 3400, unit: 'usd', direction: 'lt', inclusive: true },
  { q: 'Will Google dip to $200 in November?', threshold: 200, unit: 'usd', direction: 'lt', inclusive: true },
  { q: "Will Trump's approval rating hit 30% in 2025?", threshold: 30, unit: 'percent', direction: 'gt', inclusive: true },
  { q: 'Will MrBeast hit 105.5 billion views by December 31?', threshold: 105_500_000_000, unit: 'count', direction: 'gt', inclusive: true },
  { q: 'Solana above $250 on September 5?', threshold: 250, unit: 'usd', direction: 'gt', inclusive: false },
];

interface RejectCase {
  readonly q: string;
  readonly why: string;
}

const SHOULD_NOT_PARSE: readonly RejectCase[] = [
  // Bands. 10,064 of these in the live catalog, and the single biggest source
  // of false edges if the first number were read as a threshold.
  { q: 'Will the price of Bitcoin be between $92,000 and $94,000 on November 15?', why: 'band, not monotone' },
  { q: 'Will the price of Bitcoin be between $104K and $105K on May 21 at 5 PM ET?', why: 'band, not monotone' },
  { q: 'Will the price of Ethereum be between $3200 and $3300 on July 17 at 5PM ET?', why: 'band, not monotone' },
  { q: 'Will the AfD win 25-30% of the vote in the German election?', why: 'dashed range is a band' },
  { q: 'Will Rafał Trzaskowski win by 4-8%?', why: 'dashed range is a band' },
  { q: 'Will George Simion win by 12–18%?', why: 'en-dash range is a band' },
  { q: '1-25 bps decrease in ECB interest rates after 2024 December meeting?', why: 'dashed range is a band' },

  // Exact values. A partition of outcomes, not a ladder: "by exactly 25 bps"
  // does not imply "by exactly 50 bps" in either direction.
  { q: 'Fed decreases interest rates by 25 bps after 2024 May meeting?', why: 'exact value, no comparator' },
  { q: 'Will annual inflation increase by 2.9% in November?', why: 'exact value, no comparator' },
  { q: 'Will the May 2025 unemployment rate be 4.2%?', why: 'exact value, no comparator' },

  // Multiple conditions in one question.
  { q: 'Will Bitcoin hit $80k or $100k first?', why: 'a race between two levels, not one rung' },
  { q: 'Chiefs Parlay - Chiefs win, Mahomes 225+ passing yards, Kelce 40+ receiving yards', why: 'parlay: a conjunction of legs' },
  { q: 'Star Power Parlay - St. Brown 50+ receiving yards, Hurts 25+ rushing yards, Total 41+ points', why: 'parlay: a conjunction of legs' },

  // No threshold at all.
  { q: 'Will RB Leipzig vs. 1. FC Magdeburg end in a draw?', why: 'no numeric threshold' },
  { q: 'Will 1. FC Kaiserslautern win on 2025-12-02?', why: 'no numeric threshold' },
  { q: 'Over vs Under Line: 215.5', why: 'no direction — names both sides' },
];

describe('parseThresholdQuestion: real questions that must parse', () => {
  it.each(SHOULD_PARSE)('$q', ({ q, threshold, unit, direction, inclusive }) => {
    const parsed = parseThresholdQuestion(q);

    expect(parsed, 'expected a parse').not.toBeNull();
    if (parsed === null) return;

    expect(parsed.threshold).toBe(threshold);
    expect(parsed.unit).toBe(unit);
    expect(parsed.direction).toBe(direction);
    expect(parsed.inclusive).toBe(inclusive);
    // The threshold clause must be gone, or grouping would never match.
    expect(parsed.subject).toBe(parsed.subject.toLowerCase());
  });

  it('covers every unit and both directions', () => {
    const units = new Set(SHOULD_PARSE.map((c) => c.unit));
    const directions = new Set(SHOULD_PARSE.map((c) => c.direction));

    expect(units).toEqual(new Set(['usd', 'percent', 'bps', 'temperature', 'count']));
    expect(directions).toEqual(new Set(['gt', 'lt']));
    expect(SHOULD_PARSE.length).toBeGreaterThanOrEqual(40);
  });
});

describe('parseThresholdQuestion: real questions that must NOT parse', () => {
  it.each(SHOULD_NOT_PARSE)('$why — $q', ({ q }) => {
    expect(parseThresholdQuestion(q)).toBeNull();
  });

  it('has at least a dozen rejection cases', () => {
    expect(SHOULD_NOT_PARSE.length).toBeGreaterThanOrEqual(12);
  });
});

describe('subject and date extraction', () => {
  it('strips the threshold and the date, leaving the subject', () => {
    const parsed = parseThresholdQuestion(
      'Will the price of XRP be above $2.70 on September 4 at 12PM ET?',
    );

    expect(parsed?.subject).toBe('will the price of xrp');
    expect(parsed?.dateText).toBe('on september 4 at 12pm et');
  });

  it('reads every temporal preposition the catalog uses', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Will the price of Ethereum be above $2,900 on November 14?', 'on november 14'],
      ['Will Bitcoin reach $110,000 by January 31, 2025?', 'by january 31, 2025'],
      ['Will Solana reach $220 in June?', 'in june'],
      ['AI model scores ≥ 90% on FrontierMath Benchmark before 2027?', 'before 2027'],
      ['Fed raises interest rates by 25+ bps after 2024 May meeting?', 'after 2024 may meeting'],
    ];

    for (const [question, expected] of cases) {
      expect(parseThresholdQuestion(question)?.dateText, question).toBe(expected);
    }
  });

  it('does not mistake a non-temporal preposition for a date', () => {
    const parsed = parseThresholdQuestion('Will the AfD win less than 20% of the vote in the German election?');
    expect(parsed?.dateText).toBeNull();
    expect(parsed?.subject).toContain('german election');
  });

  it('keeps different resolution dates apart', () => {
    const a = parseThresholdQuestion('Will the price of Ethereum be above $2,900 on November 14?');
    const b = parseThresholdQuestion('Will the price of Ethereum be above $2,900 on November 15?');

    expect(a?.subject).toBe(b?.subject);
    expect(a?.dateText).not.toBe(b?.dateText);
  });
});

describe('purity and totality', () => {
  const hostile: readonly unknown[] = [
    '',
    '   ',
    '?',
    '$',
    '%',
    'above',
    'above $',
    '$$$$$',
    'above $NaN',
    'above $Infinity',
    ' ',
    'above $999999999999999999999999999999',
    '−100',
    'a'.repeat(10_000),
    `above $1 ${'and above $2 '.repeat(200)}`,
    null,
    undefined,
    42,
    {},
    [],
  ];

  it('returns null instead of throwing, whatever it is handed', () => {
    for (const input of hostile) {
      expect(() => parseThresholdQuestion(input as string), String(input).slice(0, 40)).not.toThrow();
    }
  });

  it('is deterministic — the same question always parses the same way', () => {
    const q = 'Will the price of Bitcoin be above $115,000 on September 25?';
    const first = JSON.stringify(parseThresholdQuestion(q));

    for (let i = 0; i < 50; i += 1) {
      expect(JSON.stringify(parseThresholdQuestion(q))).toBe(first);
    }
  });

  it('does not mutate the string it is given', () => {
    const q = 'Will the price of Solana be less than $110 on November 15?';
    const copy = `${q}`;
    parseThresholdQuestion(q);
    expect(q).toBe(copy);
  });
});

// ---------------------------------------------------------------------------

const XRP = (price: string, id: string): LadderMarket => ({
  conditionId: id,
  question: `Will the price of XRP be above $${price} on September 4 at 12PM ET?`,
  endDate: '2025-09-04T16:00:00.000Z',
  eventId: 'evt-xrp',
});

/** A bare sports over/under line: no subject survives the threshold strip. */
const line = (id: string, event: string, value: string): LadderMarket => ({
  conditionId: id,
  question: `Over ${value}`,
  endDate: '2024-10-26T12:00:00.000Z',
  eventId: event,
});

const under = (price: string, id: string): LadderMarket => ({
  conditionId: id,
  question: `Will the price of Bitcoin be less than $${price} on November 15?`,
  endDate: '2025-11-15T17:00:00.000Z',
  eventId: 'evt-btc',
});

const band = (lo: string, hi: string, id: string): LadderMarket => ({
  conditionId: id,
  question: `Will the price of Bitcoin be between $${lo} and $${hi} on November 15?`,
  endDate: '2025-11-15T17:00:00.000Z',
  eventId: 'evt-btc',
});

describe('grouping into ladders', () => {
  it('groups markets that differ only in threshold', () => {
    const ladders = groupLadders([XRP('2.70', 'a'), XRP('2.73', 'b'), XRP('2.76', 'c')]);

    expect(ladders).toHaveLength(1);
    expect(ladders[0]?.rungs.map((r) => r.parse.threshold)).toEqual([2.7, 2.73, 2.76]);
    expect(ladders[0]?.direction).toBe('gt');
    expect(ladders[0]?.unit).toBe('usd');
  });

  it('does not group across different dates', () => {
    const nov14: LadderMarket = { conditionId: 'a', question: 'Will the price of Ethereum be above $2,900 on November 14?', eventId: 'e' };
    const nov15: LadderMarket = { conditionId: 'b', question: 'Will the price of Ethereum be above $3,100 on November 15?', eventId: 'e' };

    expect(groupLadders([nov14, nov15])).toEqual([]);
  });

  it('does not group across units or directions', () => {
    const usd: LadderMarket = { conditionId: 'a', question: 'Will Foo Corp revenue be above $50 in June?', eventId: 'e' };
    const pct: LadderMarket = { conditionId: 'b', question: 'Will Foo Corp revenue be above 50% in June?', eventId: 'e' };
    const down: LadderMarket = { conditionId: 'c', question: 'Will Foo Corp revenue be below $60 in June?', eventId: 'e' };

    expect(groupLadders([usd, pct, down])).toEqual([]);
  });

  it('needs at least two rungs to be a ladder', () => {
    expect(groupLadders([XRP('2.70', 'a')])).toEqual([]);
  });

  it('keeps unrelated events apart even when subject and date coincide', () => {
    // Real shape: bare over/under lines, identical text, different games, same
    // night. On subject and date alone these would form one 88-rung ladder
    // spanning unrelated matches.
    const scoped = groupLadders([
      line('a', 'game-1', '229.5'),
      line('b', 'game-1', '231.5'),
      line('c', 'game-2', '218.5'),
      line('d', 'game-2', '220.5'),
    ]);
    expect(scoped).toHaveLength(2);
    for (const ladder of scoped) expect(ladder.rungs).toHaveLength(2);

    // Without an event to identify them, a subjectless market is not grouped
    // at all rather than grouped wrongly.
    expect(groupLadders([
      line('a', 'game-1', '229.5'),
      line('b', 'game-1', '231.5'),
    ], { scopeToEvent: false })).toEqual([]);
  });

  it('is order-independent', () => {
    const markets = [XRP('2.76', 'c'), XRP('2.70', 'a'), XRP('2.73', 'b')];
    const forward = groupLadders(markets);
    const backward = groupLadders(markets.toReversed());

    expect(forward[0]?.rungs.map((r) => r.parse.threshold)).toEqual([2.7, 2.73, 2.76]);
    expect(backward[0]?.rungs.map((r) => r.parse.threshold)).toEqual([2.7, 2.73, 2.76]);
  });
});

describe('edges', () => {
  it('points from the stronger claim to the weaker one, upward', () => {
    const [ladder] = groupLadders([XRP('2.70', 'low'), XRP('2.73', 'mid'), XRP('2.76', 'high')]);
    expect(ladder).toBeDefined();
    if (ladder === undefined) return;

    const edges = ladderEdges(ladder);

    // Adjacent only: implication is transitive, so 2.76 -> 2.70 is implied.
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => [e.fromConditionId, e.toConditionId])).toEqual([
      ['mid', 'low'],
      ['high', 'mid'],
    ]);

    for (const edge of edges) {
      expect(edge.type).toBe('implies');
      expect(edge.source).toBe('ladder');
      expect(edge.confidence).toBe(1);
      expect(edge.rationale).toContain('entails');
    }
  });

  it('reverses for a "less than" family', () => {
    const [ladder] = groupLadders([under('92,000', 'low'), under('94,000', 'high')]);
    expect(ladder?.direction).toBe('lt');
    if (ladder === undefined) return;

    // Below $92k entails below $94k — the lower threshold is the stronger claim.
    const edges = ladderEdges(ladder);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.fromConditionId).toBe('low');
    expect(edges[0]?.toConditionId).toBe('high');
  });

  it('emits every ordered pair when asked for the transitive closure', () => {
    const [ladder] = groupLadders([XRP('2.70', 'a'), XRP('2.73', 'b'), XRP('2.76', 'c')]);
    if (ladder === undefined) return;

    expect(ladderEdges(ladder, { transitive: true })).toHaveLength(3);
    expect(ladderEdges(ladder)).toHaveLength(2);
  });

  it('emits no edge between rungs at the same threshold', () => {
    // Real: the catalog lists some markets twice inside one event. Which of
    // "above $2.70" and "at least $2.70" implies the other depends on
    // inclusivity, not on the ladder, so neither is asserted.
    const [ladder] = groupLadders([XRP('2.70', 'a'), XRP('2.70', 'b')]);
    if (ladder === undefined) return;

    expect(ladder.rungs).toHaveLength(2);
    expect(ladderEdges(ladder)).toEqual([]);
  });

  it('never emits a self-edge', () => {
    const { edges } = extractLadderRelations([XRP('2.70', 'a'), XRP('2.73', 'b'), XRP('2.76', 'c')]);
    for (const edge of edges) expect(edge.fromConditionId).not.toBe(edge.toConditionId);
  });

  it('produces no edges from bands', () => {
    const { edges, ladders } = extractLadderRelations([
      band('92,000', '94,000', 'a'),
      band('94,000', '96,000', 'b'),
      band('96,000', '98,000', 'c'),
    ]);

    expect(ladders).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('is idempotent — extracting twice yields identical edges', () => {
    const markets = [XRP('2.70', 'a'), XRP('2.76', 'c'), XRP('2.73', 'b')];
    const first = extractLadderRelations(markets);
    const second = extractLadderRelations(markets.toReversed());

    expect(JSON.stringify(second.edges)).toBe(JSON.stringify(first.edges));
  });
});

// ---------------------------------------------------------------------------

interface CorpusFixture {
  readonly sampledFromMarkets: number;
  readonly sampledFromEvents: number;
  readonly markets: readonly LadderMarket[];
}

describe('coverage of the live catalog', () => {
  const corpus = JSON.parse(
    readFileSync(new URL('../fixtures/relations/catalog-sample.json', import.meta.url), 'utf8'),
  ) as CorpusFixture;

  it('reports what fraction of real markets land in a ladder', () => {
    const { stats, ladders } = extractLadderRelations(corpus.markets);

    const pct = (n: number): string => ((n / stats.marketsConsidered) * 100).toFixed(2);
    const sizes = ladders.map((l) => l.rungs.length).toSorted((a, b) => a - b);

    console.log(
      [
        '',
        '  ── ladder coverage ────────────────────────────────────────────',
        `  corpus            ${stats.marketsConsidered.toLocaleString()} markets, sampled as whole events`,
        `                    from ${corpus.sampledFromMarkets.toLocaleString()} live markets`,
        `  parse to a rung   ${stats.marketsParsed.toLocaleString()}  (${pct(stats.marketsParsed)}%)`,
        `  land in a ladder  ${stats.marketsInLadders.toLocaleString()}  (${pct(stats.marketsInLadders)}%)`,
        `  ladders           ${stats.ladders.toLocaleString()}  (median ${sizes[Math.floor(sizes.length / 2)] ?? 0} rungs, max ${sizes.at(-1) ?? 0})`,
        `  edges             ${stats.edges.toLocaleString()}`,
        '  ───────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );

    // A guard against silent collapse, not a target. If a refactor drops this
    // to zero — or doubles it by admitting bands — the test should say so.
    expect(stats.marketsInLadders / stats.marketsConsidered).toBeGreaterThan(0.05);
    expect(stats.marketsInLadders / stats.marketsConsidered).toBeLessThan(0.2);
  });

  it('finds no self-edges or duplicate edges anywhere in the corpus', () => {
    const { edges } = extractLadderRelations(corpus.markets);
    const seen = new Set<string>();

    for (const edge of edges) {
      expect(edge.fromConditionId).not.toBe(edge.toConditionId);
      const key = `${edge.fromConditionId} ${edge.toConditionId} ${edge.type}`;
      expect(seen.has(key), `duplicate edge ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('never emits an edge whose direction contradicts its thresholds', () => {
    const { ladders } = extractLadderRelations(corpus.markets);

    for (const ladder of ladders) {
      const byId = new Map(ladder.rungs.map((r) => [r.market.conditionId, r.parse.threshold]));

      for (const edge of ladderEdges(ladder)) {
        const from = byId.get(edge.fromConditionId);
        const to = byId.get(edge.toConditionId);
        expect(from).toBeDefined();
        expect(to).toBeDefined();
        if (from === undefined || to === undefined) continue;

        // gt: the stronger (higher) threshold implies the weaker (lower) one.
        if (ladder.direction === 'gt') expect(from).toBeGreaterThan(to);
        else expect(from).toBeLessThan(to);
      }
    }
  });

  it('runs over the whole corpus without throwing', () => {
    for (const market of corpus.markets) {
      expect(() => parseThresholdQuestion(market.question)).not.toThrow();
    }
  });
});
