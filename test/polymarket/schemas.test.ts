import { describe, expect, it } from 'vitest';

import {
  booleanish,
  identifier,
  keysetPageSchema,
  numberList,
  numeric,
  parseEvent,
  parseMarket,
  stringList,
  timestamp,
  type FieldIssue,
} from '../../src/polymarket/schemas.js';
import { loadFixture } from './fixtures.js';

function records(fixture: string): unknown[] {
  const page = keysetPageSchema.parse(loadFixture(fixture));
  return [...page.records];
}

function fieldsOf(issues: readonly FieldIssue[]): string[] {
  return issues.map((issue) => issue.field).toSorted();
}

describe('coercions', () => {
  it('reads numbers from numbers and from strings', () => {
    expect(numeric.parse(12.5)).toBe(12.5);
    expect(numeric.parse('12.5')).toBe(12.5);
    expect(numeric.parse(' 39457.4413 ')).toBe(39457.4413);
    expect(numeric.parse(0)).toBe(0);
  });

  it('rejects values that are not finite numbers', () => {
    expect(numeric.safeParse('N/A').success).toBe(false);
    expect(numeric.safeParse('Infinity').success).toBe(false);
    expect(numeric.safeParse({}).success).toBe(false);
  });

  it('reads booleans from booleans, strings, and 0/1', () => {
    expect(booleanish.parse(true)).toBe(true);
    expect(booleanish.parse('true')).toBe(true);
    expect(booleanish.parse('False')).toBe(false);
    expect(booleanish.parse(1)).toBe(true);
    expect(booleanish.parse(0)).toBe(false);
    expect(booleanish.safeParse('maybe').success).toBe(false);
    expect(booleanish.safeParse(2).success).toBe(false);
  });

  it('normalises ids to strings regardless of how they arrive', () => {
    expect(identifier.parse('253591')).toBe('253591');
    expect(identifier.parse(253591)).toBe('253591');
    expect(identifier.safeParse('   ').success).toBe(false);
    expect(identifier.safeParse({}).success).toBe(false);
  });

  it('accepts every date shape Gamma emits', () => {
    const iso = timestamp.parse('2024-12-31T12:00:00Z');
    expect(iso.toISOString()).toBe('2024-12-31T12:00:00.000Z');

    // Bare calendar date — read as UTC midnight, not local.
    expect(timestamp.parse('2025-01-02').toISOString()).toBe('2025-01-02T00:00:00.000Z');

    // Postgres style: space separator, two-digit offset.
    expect(timestamp.parse('2024-01-08 20:24:52.36+00').toISOString()).toBe(
      '2024-01-08T20:24:52.360Z',
    );

    // Epoch seconds and milliseconds, as number and as string.
    expect(timestamp.parse(1735776000).toISOString()).toBe('2025-01-02T00:00:00.000Z');
    expect(timestamp.parse(1735776000000).toISOString()).toBe('2025-01-02T00:00:00.000Z');
    expect(timestamp.parse('1735776000').toISOString()).toBe('2025-01-02T00:00:00.000Z');
  });

  it('rejects dates it cannot read', () => {
    expect(timestamp.safeParse('sometime next spring').success).toBe(false);
    expect(timestamp.safeParse('0000-00-00').success).toBe(false);
    expect(timestamp.safeParse(true).success).toBe(false);
  });

  it('rejects impossible calendar dates rather than rolling them forward', () => {
    // `Date.parse` would answer March 2 for both of these.
    expect(timestamp.safeParse('2025-02-30T00:00:00Z').success).toBe(false);
    expect(timestamp.safeParse('2025-04-31').success).toBe(false);
    // The leap day itself is real in 2024 and not in 2025.
    expect(timestamp.parse('2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(timestamp.safeParse('2025-02-29').success).toBe(false);
  });

  it('reads lists whether JSON-encoded or already arrays', () => {
    expect(stringList.parse('["Yes", "No"]')).toEqual(['Yes', 'No']);
    expect(stringList.parse(['Yes', 'No'])).toEqual(['Yes', 'No']);
    expect(numberList.parse('["0.9965", "0.0035"]')).toEqual([0.9965, 0.0035]);
    expect(numberList.parse([0.18, 0.82])).toEqual([0.18, 0.82]);
    expect(stringList.parse('[]')).toEqual([]);
  });

  it('rejects a list rather than returning half of one', () => {
    expect(numberList.safeParse('["0.51", "abc"]').success).toBe(false);
    expect(stringList.safeParse('["Yes", "No"').success).toBe(false);
    expect(stringList.safeParse('{"a": 1}').success).toBe(false);
    expect(stringList.safeParse(42).success).toBe(false);
  });
});

describe('parseMarket', () => {
  it('coerces a well-formed market into clean domain types', () => {
    const [first] = records('markets-page-1');
    const parsed = parseMarket(first);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.issues).toEqual([]);
    expect(parsed.value.id).toBe('253591');
    expect(parsed.value.outcomes).toEqual(['Yes', 'No']);
    expect(parsed.value.outcomePrices).toEqual([0.9965, 0.0035]);
    expect(parsed.value.volume).toBe(12345.671);
    expect(parsed.value.liquidity).toBe(39457.4413);
    expect(parsed.value.active).toBe(true);
    expect(parsed.value.endDate?.toISOString()).toBe('2024-12-31T12:00:00.000Z');
    expect(parsed.value.createdAt?.toISOString()).toBe('2024-01-08T20:24:52.360Z');
  });

  it('maps the API key names that are not usable domain names', () => {
    const [first, second] = records('markets-page-1');

    const a = parseMarket(first);
    expect(a.ok && a.value.questionId).toMatch(/^0x7d1f/);
    expect(a.ok && a.value.isNew).toBe(false);

    // `volumeNum`/`liquidityNum` fill in only when the string field is absent.
    const b = parseMarket(second);
    expect(b.ok && b.value.volume).toBe(998877.5);
    expect(b.ok && b.value.isNew).toBe(false);
  });

  it('treats a missing or empty field as null, not as a failure', () => {
    const sparse = records('markets-page-1')[2];
    const parsed = parseMarket(sparse);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Gamma writes "unset" as "" on some fields and omits others entirely.
    // Neither is corruption, so neither is reported.
    expect(parsed.issues).toEqual([]);
    expect(parsed.value.endDate).toBeNull();
    expect(parsed.value.outcomePrices).toBeNull();
    expect(parsed.value.umaBond).toBeNull();
    expect(parsed.value.question).toBe('Will the sparse market resolve?');
  });

  it('nulls a malformed field and keeps the rest of the market', () => {
    const [broken] = records('markets-malformed-encodings');
    const parsed = parseMarket(broken);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(fieldsOf(parsed.issues)).toEqual(['clobTokenIds', 'outcomePrices', 'outcomes']);
    expect(parsed.value.outcomes).toBeNull();
    expect(parsed.value.outcomePrices).toBeNull();
    expect(parsed.value.clobTokenIds).toBeNull();

    // Everything the payload got right is still there.
    expect(parsed.value.id).toBe('900001');
    expect(parsed.value.volume).toBe(1000.5);
    expect(parsed.value.endDate?.toISOString()).toBe('2025-12-31T12:00:00.000Z');
  });

  it('reports the failing field and the value that caused it', () => {
    const [, broken] = records('markets-malformed-encodings');
    const parsed = parseMarket(broken);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const outcomes = parsed.issues.find((issue) => issue.field === 'outcomes');
    expect(outcomes?.received).toBe(42);
    expect(outcomes?.reason).toContain('expected an array or a JSON-encoded array string');
  });

  it('salvages the valid-but-unusual halves of a record with bad dates', () => {
    const [prose, unusual] = records('markets-malformed-dates');

    const a = parseMarket(prose);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(fieldsOf(a.issues)).toEqual([
      'createdAt',
      'endDate',
      'spread',
      'startDate',
      'updatedAt',
      'volume',
    ]);
    expect(a.value.startDate).toBeNull();
    expect(a.value.volume).toBeNull();
    // `"liquidity": ""` is absence, so it is null without being reported.
    expect(a.value.liquidity).toBeNull();
    expect(a.value.outcomePrices).toEqual([0.25, 0.75]);

    const b = parseMarket(unusual);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(fieldsOf(b.issues)).toEqual(['closed', 'updatedAt']);
    expect(b.value.startDate?.toISOString()).toBe('2024-01-08T00:00:00.000Z');
    expect(b.value.endDate?.toISOString()).toBe('2025-06-01T18:30:00.000Z');
    expect(b.value.closedTime?.toISOString()).toBe('2025-06-01T18:30:00.000Z');
    expect(b.value.volume).toBe(15432.25);
    expect(b.value.active).toBe(true);
  });

  it('refuses only records it cannot identify', () => {
    const [noId, nullRecord, bareString, objectId, salvageable] =
      records('markets-malformed-shapes');

    expect(parseMarket(noId).ok).toBe(false);
    expect(parseMarket(nullRecord).ok).toBe(false);
    expect(parseMarket(bareString).ok).toBe(false);
    expect(parseMarket(objectId).ok).toBe(false);

    const parsed = parseMarket(salvageable);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(fieldsOf(parsed.issues)).toEqual(['active', 'image', 'spread']);
    expect(parsed.value.id).toBe('900299');
    expect(parsed.value.outcomePrices).toEqual([0.5, 0.5]);
  });
});

describe('parseEvent', () => {
  it('parses an event and its nested markets', () => {
    const [first] = records('events-page-1');
    const parsed = parseEvent(first);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.issues).toEqual([]);
    expect(parsed.value.id).toBe('12345');
    expect(parsed.value.title).toBe('Fed decision in March');
    expect(parsed.value.competitive).toBe(0.9412);
    expect(parsed.value.creationDate?.toISOString()).toBe('2025-01-30T13:58:02.114Z');
    expect(parsed.value.tags).toEqual([
      { id: '100196', label: 'Fed Rates', slug: 'fed-rates' },
      { id: '2', label: 'Economy', slug: 'economy' },
    ]);

    expect(parsed.value.markets.map((market) => market.id)).toEqual(['712004', '712006']);
    expect(parsed.value.markets[0]?.outcomePrices).toEqual([0.01, 0.99]);
  });

  it('handles an event with no markets', () => {
    const [, empty] = records('events-page-1');
    const parsed = parseEvent(empty);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.markets).toEqual([]);
    expect(parsed.value.tags).toEqual([]);
    expect(parsed.value.isNew).toBe(true);
  });

  it('scopes a nested market failure to a path, keeping the event and its siblings', () => {
    const parsed = parseEvent({
      id: '777',
      title: 'Mixed bag',
      markets: [
        { id: '1', outcomes: 42 },
        { noId: true },
        { id: '3', outcomes: '["Yes","No"]' },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(fieldsOf(parsed.issues)).toEqual(['markets[0].outcomes', 'markets[1]']);
    expect(parsed.value.markets.map((market) => market.id)).toEqual(['1', '3']);
    expect(parsed.value.markets[0]?.outcomes).toBeNull();
    expect(parsed.value.markets[1]?.outcomes).toEqual(['Yes', 'No']);
  });
});

describe('keysetPageSchema', () => {
  it('reads the data array and the next cursor', () => {
    const page = keysetPageSchema.parse(loadFixture('markets-page-1'));
    expect(page.records).toHaveLength(3);
    expect(page.nextCursor).toBe('MTAwMA==');
  });

  it('treats an omitted, empty, or sentinel cursor as the end of the catalog', () => {
    expect(keysetPageSchema.parse(loadFixture('markets-page-2')).nextCursor).toBeNull();
    expect(keysetPageSchema.parse({ data: [], next_cursor: '' }).nextCursor).toBeNull();
    expect(keysetPageSchema.parse({ data: [], next_cursor: null }).nextCursor).toBeNull();
    // Base64 "-1", the terminal cursor used by the CLOB-derived encoders.
    expect(keysetPageSchema.parse({ data: [], next_cursor: 'LTE=' }).nextCursor).toBeNull();
  });

  it('accepts a bare array as a single terminal page', () => {
    const page = keysetPageSchema.parse([{ id: '1' }]);
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps records unvalidated so one bad record cannot fail the page', () => {
    const page = keysetPageSchema.parse({ data: [null, 'junk', { id: '1' }] });
    expect(page.records).toHaveLength(3);
  });

  it('rejects a body with no record array', () => {
    expect(keysetPageSchema.safeParse({ error: 'nope' }).success).toBe(false);
    expect(keysetPageSchema.safeParse('nope').success).toBe(false);
  });

  it('reads the record array from the live envelope, which names it after the resource', () => {
    // The first production deploy failed on exactly this: `/events/keyset`
    // answers with `{ $schema, events, next_cursor }`, not `{ data }`.
    const events = keysetPageSchema.parse(loadFixture('events-keyset-live'));
    expect(events.records).toHaveLength(3);
    expect(events.nextCursor).toBeTypeOf('string');
    expect(events.nextCursor).not.toBe('');

    const markets = keysetPageSchema.parse(loadFixture('markets-keyset-live'));
    expect(markets.records).toHaveLength(3);
  });

  it('parses the records inside a live envelope end to end', () => {
    const page = keysetPageSchema.parse(loadFixture('events-keyset-live'));

    for (const record of page.records) {
      const parsed = parseEvent(record);
      expect(parsed.ok, parsed.ok ? '' : parsed.reason).toBe(true);
    }
  });

  it('falls back to the sole array key for a resource name it has not seen', () => {
    const page = keysetPageSchema.parse({
      $schema: 'https://example/Whatever.json',
      widgets: [{ id: '1' }, { id: '2' }],
      next_cursor: 'MTA=',
      limit: 2,
    });

    expect(page.records).toHaveLength(2);
    expect(page.nextCursor).toBe('MTA=');
  });

  it('does not guess when two candidate arrays are present', () => {
    expect(
      keysetPageSchema.safeParse({ widgets: [{ id: '1' }], gadgets: [{ id: '2' }] }).success,
    ).toBe(false);
  });

  it('ignores envelope metadata when looking for records', () => {
    const page = keysetPageSchema.parse({ $schema: 'x', events: [], next_cursor: '', count: 0 });
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
