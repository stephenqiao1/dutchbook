import { describe, expect, it } from 'vitest';

import {
  extractComplements,
  normalizeQuestion,
  positiveForms,
} from '../../src/relations/complements.js';
import {
  extractPartitions,
  findPartitionConflicts,
  type PartitionEvent,
  type PartitionMarket,
} from '../../src/relations/partitions.js';
import {
  extractTemporalRelations,
  groupTemporalChains,
  parseDeadlineQuestion,
  temporalEdges,
  type TemporalMarket,
} from '../../src/relations/temporal.js';

/**
 * Every question and event below is real, taken from the ingested catalog.
 */

const YES_NO = ['Yes', 'No'] as const;

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

/** Real: event 100174, an A-League fixture. Three exhaustive outcomes. */
const SOCCER_EVENT: PartitionEvent = {
  eventId: '100174',
  negRisk: true,
  title: 'Central Coast Mariners FC vs. Auckland FC',
};
const SOCCER_MARKETS: PartitionMarket[] = [
  { conditionId: 'draw', eventId: '100174', outcomes: YES_NO, question: 'Will Central Coast Mariners FC vs. Auckland FC end in a draw?' },
  { conditionId: 'home', eventId: '100174', outcomes: YES_NO, question: 'Will Central Coast Mariners FC win on 2025-12-12?' },
  { conditionId: 'away', eventId: '100174', outcomes: YES_NO, question: 'Will Auckland FC win on 2025-12-12?' },
];

describe('partitions from negRisk events', () => {
  it('emits one sum-to-one group per negRisk event', () => {
    const [group] = extractPartitions(SOCCER_MARKETS, [SOCCER_EVENT]);

    expect(group).toBeDefined();
    expect(group?.type).toBe('partition');
    expect(group?.source).toBe('neg-risk-event');
    expect(group?.confidence).toBe(1);
    expect(group?.members).toEqual(['away', 'draw', 'home']);
    expect(group?.key).toBe('partition:neg-risk-event:100174');
    expect(group?.rationale).toContain('sum to 1');
  });

  it('emits nothing when the venue has not claimed exclusivity', () => {
    // `false` is a claim that they are not exclusive; `null` means the crawl
    // never learned. Neither may be read as a partition.
    expect(extractPartitions(SOCCER_MARKETS, [{ ...SOCCER_EVENT, negRisk: false }])).toEqual([]);
    expect(extractPartitions(SOCCER_MARKETS, [{ ...SOCCER_EVENT, negRisk: null }])).toEqual([]);
    expect(extractPartitions(SOCCER_MARKETS, [{ eventId: '100174' }])).toEqual([]);
  });

  it('excludes markets that have no single Yes leg', () => {
    const scalar: PartitionMarket = {
      conditionId: 'scalar',
      eventId: '100174',
      outcomes: ['Under', 'Over'],
      question: 'Something scalar',
    };

    const [group] = extractPartitions([...SOCCER_MARKETS, scalar], [SOCCER_EVENT]);
    expect(group?.members).not.toContain('scalar');
    expect(group?.members).toHaveLength(3);
  });

  it('needs at least two members', () => {
    expect(extractPartitions([SOCCER_MARKETS[0]!], [SOCCER_EVENT])).toEqual([]);
  });

  it('deduplicates and sorts members so the group has one canonical form', () => {
    const dup = [...SOCCER_MARKETS, SOCCER_MARKETS[0]!];
    const [group] = extractPartitions(dup, [SOCCER_EVENT]);

    expect(group?.members).toEqual(['away', 'draw', 'home']);
  });

  it('handles a large real partition', () => {
    // Real: event 100074, "Top performing Magnificent 7 company".
    const event: PartitionEvent = { eventId: '100074', negRisk: true, title: 'Top performing Magnificent 7 company week of December 8?' };
    const tickers = ['TSLA', 'MSFT', 'AAPL', 'NVDA', 'META', 'AMZN', 'GOOGL'];
    const markets: PartitionMarket[] = tickers.map((t) => ({
      conditionId: t,
      eventId: '100074',
      outcomes: YES_NO,
      question: `Will ${t} be the top performing Magnificent 7 company during the week of December 8?`,
    }));

    const [group] = extractPartitions(markets, [event]);
    expect(group?.members).toHaveLength(7);
    expect(group?.members).toEqual(tickers.toSorted());
  });
});

describe('partitions as ground truth', () => {
  it('flags an implication between two members of one partition', () => {
    const [group] = extractPartitions(SOCCER_MARKETS, [SOCCER_EVENT]);
    expect(group).toBeDefined();
    if (group === undefined) return;

    // Mutually exclusive markets cannot entail one another: at most one is Yes.
    const conflicts = findPartitionConflicts(
      [group],
      [{ fromConditionId: 'home', toConditionId: 'away', type: 'implies', source: 'ladder' }],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.source).toBe('ladder');
    expect(conflicts[0]?.detail).toContain('mutually exclusive');
  });

  it('flags a complement inside a partition larger than two', () => {
    const [group] = extractPartitions(SOCCER_MARKETS, [SOCCER_EVENT]);
    if (group === undefined) return;

    const conflicts = findPartitionConflicts(
      [group],
      [{ fromConditionId: 'home', toConditionId: 'away', type: 'complement', source: 'complement' }],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.detail).toContain('3-member partition');
  });

  it('accepts a complement inside a two-member partition', () => {
    const event: PartitionEvent = { eventId: 'e2', negRisk: true, title: 'Binary' };
    const markets: PartitionMarket[] = [
      { conditionId: 'a', eventId: 'e2', outcomes: YES_NO, question: 'A?' },
      { conditionId: 'b', eventId: 'e2', outcomes: YES_NO, question: 'B?' },
    ];
    const [group] = extractPartitions(markets, [event]);
    if (group === undefined) return;

    // "exactly one Yes" and "P(A) + P(B) = 1" say the same thing here.
    expect(
      findPartitionConflicts([group], [
        { fromConditionId: 'a', toConditionId: 'b', type: 'complement', source: 'complement' },
      ]),
    ).toEqual([]);
  });

  it('ignores relations that leave the partition', () => {
    const [group] = extractPartitions(SOCCER_MARKETS, [SOCCER_EVENT]);
    if (group === undefined) return;

    expect(
      findPartitionConflicts([group], [
        { fromConditionId: 'home', toConditionId: 'elsewhere', type: 'implies', source: 'ladder' },
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Temporal nesting
// ---------------------------------------------------------------------------

describe('parseDeadlineQuestion', () => {
  it('reads real deadline questions', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['US strikes Iran by December 31, 2025?', 'us strikes iran', 'december 31, 2025'],
      ['US strikes Iran by February 10, 2026?', 'us strikes iran', 'february 10, 2026'],
      ['Will Zelenskyy and Putin meet before 2027?', 'will zelenskyy and putin meet', '2027'],
      ['Will a new country join BRICS before 2026?', 'will a new country join brics', '2026'],
    ];

    for (const [question, subject, deadline] of cases) {
      const parsed = parseDeadlineQuestion(question);
      expect(parsed?.subject, question).toBe(subject);
      expect(parsed?.deadlineText, question).toBe(deadline);
    }
  });

  it('refuses a "by" that is a magnitude rather than a deadline', () => {
    // Real, and the reason the deadline clause is anchored to the end.
    expect(parseDeadlineQuestion('Will annual inflation increase by 2.2% or less in June?')).toBeNull();
    expect(parseDeadlineQuestion('Will Kamala lead in RCP by 0-0.4 on Oct 11?')).toBeNull();
    expect(parseDeadlineQuestion('Will Rafał Trzaskowski win by 4-8%?')).toBeNull();
    expect(parseDeadlineQuestion('Fed raises interest rates by 25+ bps after 2024 May meeting?')).toBeNull();
  });

  it('refuses an instant, which does not nest', () => {
    // A price above $2.70 *on* September 4 says nothing about September 5 —
    // the price can fall back. Only "by"/"before" accumulate.
    expect(parseDeadlineQuestion('Will the price of XRP be above $2.70 on September 4?')).toBeNull();
    expect(parseDeadlineQuestion('Will the price of Bitcoin be above $115,000 on September 25 at 12AM ET?')).toBeNull();
  });

  it('refuses questions with no deadline at all', () => {
    expect(parseDeadlineQuestion('Will RB Leipzig win?')).toBeNull();
    expect(parseDeadlineQuestion('')).toBeNull();
    expect(parseDeadlineQuestion('by')).toBeNull();
  });

  it('is total', () => {
    for (const input of [null, undefined, 42, {}, [], 'x'.repeat(5000)]) {
      expect(() => parseDeadlineQuestion(input as string)).not.toThrow();
    }
  });
});

const iran = (id: string, deadline: string, endDate: string): TemporalMarket => ({
  conditionId: id,
  question: `US strikes Iran by ${deadline}?`,
  endDate,
});

describe('temporal chains', () => {
  const CHAIN: TemporalMarket[] = [
    iran('feb26', 'February 10, 2026', '2026-02-10T12:00:00.000Z'),
    iran('dec25', 'December 31, 2025', '2025-12-31T12:00:00.000Z'),
    iran('dec26', 'December 31, 2026', '2026-12-31T12:00:00.000Z'),
  ];

  it('orders rungs by deadline and points earlier at later', () => {
    const [chain] = groupTemporalChains(CHAIN);
    expect(chain?.rungs.map((r) => r.market.conditionId)).toEqual(['dec25', 'feb26', 'dec26']);
    if (chain === undefined) return;

    const edges = temporalEdges(chain);
    expect(edges.map((e) => [e.fromConditionId, e.toConditionId])).toEqual([
      ['dec25', 'feb26'],
      ['feb26', 'dec26'],
    ]);

    for (const e of edges) {
      expect(e.type).toBe('implies');
      expect(e.source).toBe('temporal');
      expect(e.confidence).toBe(1);
    }
  });

  it('requires the non-date portion to be character-identical', () => {
    const different: TemporalMarket = {
      conditionId: 'other',
      question: 'US strikes Iran or Iraq by December 31, 2026?',
      endDate: '2026-12-31T12:00:00.000Z',
    };

    const chains = groupTemporalChains([...CHAIN, different]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.rungs).toHaveLength(3);
  });

  it('needs a resolution timestamp to order by', () => {
    // "by June 30" carries no year, so text alone cannot order the chain.
    const undated = CHAIN.map((m) => ({ ...m, endDate: null }));
    expect(groupTemporalChains(undated)).toEqual([]);
  });

  it('emits nothing for rungs sharing a deadline', () => {
    const same: TemporalMarket[] = [
      iran('a', 'December 31, 2025', '2025-12-31T12:00:00.000Z'),
      iran('b', 'December 31, 2025', '2025-12-31T12:00:00.000Z'),
    ];
    const [chain] = groupTemporalChains(same);
    if (chain === undefined) return;
    expect(temporalEdges(chain)).toEqual([]);
  });

  it('emits every ordered pair on request', () => {
    const [chain] = groupTemporalChains(CHAIN);
    if (chain === undefined) return;
    expect(temporalEdges(chain, { transitive: true })).toHaveLength(3);
    expect(temporalEdges(chain)).toHaveLength(2);
  });

  it('is order-independent and idempotent', () => {
    const a = extractTemporalRelations(CHAIN);
    const b = extractTemporalRelations(CHAIN.toReversed());
    expect(JSON.stringify(b.edges)).toBe(JSON.stringify(a.edges));
  });

  it('does not build a chain out of price markets pinned to an instant', () => {
    const prices: TemporalMarket[] = [
      { conditionId: 'p1', question: 'Will the price of XRP be above $2.70 on September 4?', endDate: '2025-09-04T16:00:00.000Z' },
      { conditionId: 'p2', question: 'Will the price of XRP be above $2.70 on September 5?', endDate: '2025-09-05T16:00:00.000Z' },
    ];
    expect(groupTemporalChains(prices)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Complements
// ---------------------------------------------------------------------------

describe('complements', () => {
  it('normalizes contractions so won\'t and will not agree', () => {
    expect(normalizeQuestion("Will X won't happen?")).toBe('will x will not happen');
    expect(normalizeQuestion('Will X  happen?  ')).toBe('will x happen');
  });

  it('derives the positive form by deleting the negation', () => {
    expect(positiveForms('Will Chris Olave not be traded?')).toContain('will chris olave be traded');
    expect(positiveForms('Will the German election not happen?')).toContain('will the german election happen');
  });

  it('pairs a real negation with its real counterpart', () => {
    const edges = extractComplements([
      { conditionId: 'neg', eventId: 'e1', question: 'Will Chris Olave not be traded?' },
      { conditionId: 'pos', eventId: 'e1', question: 'Will Chris Olave be traded?' },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.type).toBe('complement');
    expect(edges[0]?.source).toBe('complement');
    expect(edges[0]?.confidence).toBe(1);
    expect([edges[0]?.fromConditionId, edges[0]?.toConditionId].toSorted()).toEqual(['neg', 'pos']);
    expect(edges[0]?.rationale).toContain('P(A) + P(B) = 1');
  });

  it('stores the symmetric pair once, in a canonical order', () => {
    const forward = extractComplements([
      { conditionId: 'zzz', eventId: 'e1', question: 'Will X not happen?' },
      { conditionId: 'aaa', eventId: 'e1', question: 'Will X happen?' },
    ]);

    expect(forward).toHaveLength(1);
    expect(forward[0]?.fromConditionId).toBe('aaa');
    expect(forward[0]?.toConditionId).toBe('zzz');
  });

  it('leaves a negation with no counterpart alone', () => {
    // Real: "Not" belongs to the song title, and de-negating gives a question
    // no market asks — so no pair forms, with no title list to maintain.
    const edges = extractComplements([
      { conditionId: 'a', eventId: 'e1', question: 'Will "I Am Not Okay" by Jelly Roll win Best Country Song?' },
      { conditionId: 'b', eventId: 'e1', question: 'Will "Textures" by Tyler Childers win Best Country Song?' },
    ]);

    expect(edges).toEqual([]);
  });

  it('does not pair across events', () => {
    const edges = extractComplements([
      { conditionId: 'neg', eventId: 'week-1', question: 'Will X not happen?' },
      { conditionId: 'pos', eventId: 'week-2', question: 'Will X happen?' },
    ]);

    expect(edges).toEqual([]);
  });

  it('refuses to guess when the counterpart is ambiguous', () => {
    const edges = extractComplements([
      { conditionId: 'neg', eventId: 'e1', question: 'Will X not happen?' },
      { conditionId: 'pos1', eventId: 'e1', question: 'Will X happen?' },
      { conditionId: 'pos2', eventId: 'e1', question: 'Will X happen?' },
    ]);

    expect(edges).toEqual([]);
  });

  it('never pairs a market with itself', () => {
    const edges = extractComplements([
      { conditionId: 'a', eventId: 'e1', question: 'Will X not happen?' },
    ]);
    expect(edges).toEqual([]);
  });

  it('is total', () => {
    expect(() =>
      extractComplements([
        { conditionId: 'a', eventId: 'e', question: '' },
        { conditionId: '', eventId: 'e', question: 'x' },
      ] as never),
    ).not.toThrow();
  });
});
