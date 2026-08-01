import { describe, expect, it } from 'vitest';

import {
  HASHED_FIELDS,
  canonicalize,
  contentHash,
  contentOf,
  diffContent,
  ingestCatalog,
  responseHash,
  toEventRow,
  toMarketRow,
  toRawPayloadRow,
  type IngestLogger,
  type IngestSummary,
  type MarketContent,
} from '../../src/jobs/ingest-catalog.js';
import { parseEvent, type Event as GammaEvent } from '../../src/polymarket/schemas.js';
import { fixtureText, loadFixture } from '../polymarket/fixtures.js';
import { createFakeStore, type FakeStore } from './fake-store.js';

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-02T00:00:00Z');
const T2 = new Date('2026-01-03T00:00:00Z');

function silentLogger(): IngestLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (_obj, msg) => warnings.push(msg),
    error: () => {},
  };
}

/** Builds a domain event through the real parser, so tests use real shapes. */
function makeEvent(raw: Record<string, unknown>): GammaEvent {
  const parsed = parseEvent(raw);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return parsed.value;
}

async function* stream(events: readonly GammaEvent[]): AsyncGenerator<GammaEvent> {
  for (const item of events) yield item;
}

interface MarketOverrides {
  readonly conditionId?: string;
  readonly question?: string;
  readonly description?: string;
  readonly resolutionSource?: string;
  readonly outcomes?: string;
  readonly endDate?: string;
  readonly active?: boolean;
  readonly closed?: boolean;
  readonly clobTokenIds?: string;
  readonly volume?: number;
}

function event(id: string, markets: MarketOverrides[], extra: Record<string, unknown> = {}) {
  return makeEvent({
    id,
    slug: `event-${id}`,
    title: `Event ${id}`,
    negRisk: false,
    ...extra,
    markets: markets.map((market, index) => ({
      id: `${id}-${index}`,
      conditionId: market.conditionId ?? `0xcond${id}-${index}`,
      slug: `market-${id}-${index}`,
      question: market.question ?? 'Will it?',
      description: market.description ?? 'Resolves per the source.',
      resolutionSource: market.resolutionSource ?? 'https://example.com',
      outcomes: market.outcomes ?? '["Yes", "No"]',
      endDate: market.endDate ?? '2026-12-31T12:00:00Z',
      active: market.active ?? true,
      closed: market.closed ?? false,
      // Absent by default: Polymarket mints CLOB tokens after publishing.
      clobTokenIds: market.clobTokenIds,
      volume: market.volume ?? 100,
    })),
  });
}

async function run(
  store: FakeStore,
  events: readonly GammaEvent[],
  at: Date,
  options: Parameters<typeof ingestCatalog>[0] = {},
): Promise<IngestSummary> {
  return ingestCatalog({
    store,
    source: stream(events),
    now: () => at,
    logger: silentLogger(),
    ...options,
  });
}

// ---------------------------------------------------------------------------

describe('canonicalize', () => {
  it('sorts object keys at every depth', () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order, which carries meaning here', () => {
    // outcomes[0] pairs with clob_token_ids[0]; sorting would erase which is Yes.
    expect(canonicalize(['Yes', 'No'])).toEqual(['Yes', 'No']);
    expect(JSON.stringify(canonicalize(['Yes', 'No']))).not.toBe(
      JSON.stringify(canonicalize(['No', 'Yes'])),
    );
  });

  it('folds undefined and null together', () => {
    expect(canonicalize(undefined)).toBeNull();
    expect(canonicalize({ a: undefined })).toEqual({ a: null });
  });

  it('renders dates as ISO strings', () => {
    expect(canonicalize(new Date('2026-12-31T12:00:00Z'))).toBe('2026-12-31T12:00:00.000Z');
  });
});

describe('contentHash', () => {
  const base: MarketContent = {
    question: 'Will BTC close above $100k?',
    description: 'Resolves per Coinbase.',
    resolution_source: 'https://coinbase.com',
    outcomes: ['Yes', 'No'],
    clob_token_ids: ['711', '712'],
    end_date: new Date('2026-12-31T12:00:00Z'),
    active: true,
    closed: false,
  };

  it('is stable across calls', () => {
    expect(contentHash(base)).toBe(contentHash({ ...base }));
    expect(contentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const reordered: MarketContent = {
      closed: base['closed'],
      active: base['active'],
      end_date: base['end_date'],
      clob_token_ids: base['clob_token_ids'],
      outcomes: base['outcomes'],
      resolution_source: base['resolution_source'],
      description: base['description'],
      question: base['question'],
    };
    expect(contentHash(reordered)).toBe(contentHash(base));
  });

  it('treats a Date and its ISO string as the same value', () => {
    expect(contentHash({ ...base, end_date: '2026-12-31T12:00:00.000Z' })).toBe(contentHash(base));
  });

  it('treats an absent field and an explicitly null one as the same', () => {
    expect(contentHash({ ...base, description: null })).toBe(
      contentHash({ ...base, description: undefined }),
    );
  });

  it('changes when any covered field changes', () => {
    for (const field of HASHED_FIELDS) {
      const mutated: MarketContent = { ...base, [field]: 'something else entirely' };
      expect(contentHash(mutated), `${field} did not affect the hash`).not.toBe(contentHash(base));
    }
  });

  it('ignores the volatile fields entirely', () => {
    // The hash reads only what `contentOf` projects, which never includes
    // volume, prices, liquidity, or spread — so a market that merely traded
    // hashes the same, and does not look edited.
    const [busy] = event('1', [{ volume: 999_999 }]).markets;
    const [calm] = event('1', [{ volume: 1 }]).markets;
    expect(busy).toBeDefined();
    expect(calm).toBeDefined();
    if (busy === undefined || calm === undefined) return;

    expect(busy.volume).not.toBe(calm.volume);
    expect(toMarketRow(busy, '1', T0)?.contentHash).toBe(toMarketRow(calm, '1', T0)?.contentHash);
  });

  it('changes when an index-paired array is reordered', () => {
    // outcomes[i] is the outcome for clob_token_ids[i]. A swap is a different
    // market, not a re-sort, so it must not hash the same.
    expect(contentHash({ ...base, outcomes: ['No', 'Yes'] })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, clob_token_ids: ['712', '711'] })).not.toBe(contentHash(base));
  });
});

describe('diffContent', () => {
  const before = contentOf({
    question: 'Will it rain?',
    description: 'Old description.',
    resolutionSource: 'https://a.example',
    outcomes: ['Yes', 'No'],
    clobTokenIds: ['711', '712'],
    endDate: new Date('2026-06-01T00:00:00Z'),
    active: true,
    closed: false,
  });

  it('finds nothing when the content matches', () => {
    expect(diffContent(before, { ...before })).toEqual([]);
  });

  it('reports one entry per changed field, named by its column', () => {
    const after = { ...before, question: 'Will it snow?', closed: true };
    const changes = diffContent(before, after);

    expect(changes.map((change) => change.field)).toEqual(['question', 'closed']);
    expect(changes[0]).toEqual({
      field: 'question',
      oldValue: 'Will it rain?',
      newValue: 'Will it snow?',
    });
    expect(changes[1]).toEqual({ field: 'closed', oldValue: false, newValue: true });
  });

  it('canonicalises the recorded values', () => {
    const after = { ...before, end_date: new Date('2027-06-01T00:00:00Z') };
    const [change] = diffContent(before, after);

    expect(change?.oldValue).toBe('2026-06-01T00:00:00.000Z');
    expect(change?.newValue).toBe('2027-06-01T00:00:00.000Z');
  });

  it('does not report a date that only changed representation', () => {
    expect(diffContent(before, { ...before, end_date: '2026-06-01T00:00:00.000Z' })).toEqual([]);
  });
});

describe('toMarketRow', () => {
  it('refuses a market with no condition_id', () => {
    const [market] = event('1', [{}]).markets;
    expect(market).toBeDefined();
    if (market === undefined) return;

    expect(toMarketRow({ ...market, conditionId: null }, '1', T0)).toBeNull();
  });

  it('stamps both timestamps on a new row and leaves it unflagged', () => {
    const [market] = event('1', [{}]).markets;
    if (market === undefined) return;

    const row = toMarketRow(market, '1', T0);
    expect(row?.firstSeenAt).toBe(T0);
    expect(row?.lastSeenAt).toBe(T0);
    expect(row?.missingSince).toBeNull();
    expect(row?.eventId).toBe('1');
  });
});

describe('toEventRow', () => {
  it('stamps closed_at only for an event that is closed', () => {
    expect(toEventRow(event('1', [], { closed: true }), T0).closedAt).toBe(T0);
    expect(toEventRow(event('1', [], { closed: false }), T0).closedAt).toBeNull();
  });
});

describe('responseHash', () => {
  it('ignores key order so an unchanged catalog archives once', () => {
    expect(responseHash({ a: 1, b: [1, 2] })).toBe(responseHash({ b: [1, 2], a: 1 }));
  });

  it('separates genuinely different bodies', () => {
    expect(responseHash({ a: 1 })).not.toBe(responseHash({ a: 2 }));
  });
});

describe('toRawPayloadRow', () => {
  it('records the path and query as the endpoint', () => {
    const row = toRawPayloadRow({
      url: 'https://gamma-api.polymarket.com/events/keyset?limit=100&after_cursor=ABC',
      status: 200,
      attempt: 0,
      headers: {},
      text: '{"data":[]}',
      body: { data: [] },
    });

    expect(row.endpoint).toBe('/events/keyset?limit=100&after_cursor=ABC');
    expect(row.responseHash).toBe(responseHash({ data: [] }));
  });

  it('keeps a body that was not JSON rather than dropping it', () => {
    const row = toRawPayloadRow({
      url: 'https://gamma-api.polymarket.com/events/keyset',
      status: 503,
      attempt: 0,
      headers: {},
      text: '<html>maintenance</html>',
      body: undefined,
    });

    expect(row.body).toEqual({ unparsed: '<html>maintenance</html>' });
  });
});

// ---------------------------------------------------------------------------

describe('ingestCatalog', () => {
  it('creates everything on a first run', async () => {
    const store = createFakeStore();
    const summary = await run(store, [event('1', [{}, {}]), event('2', [{}])], T0);

    expect(summary.markets).toEqual({ seen: 3, created: 3, updated: 0, unchanged: 0, skipped: 0 });
    expect(summary.events.seen).toBe(2);
    expect(summary.revisions).toBe(0);
    expect(summary.complete).toBe(true);

    expect(store.markets.size).toBe(3);
    expect(store.events.size).toBe(2);
    expect(store.revisions).toEqual([]);
    expect(store.markets.get('0xcond1-0')?.firstSeenAt).toBe(T0);
  });

  it('writes only last_seen_at when the content hash is unchanged', async () => {
    const store = createFakeStore();
    const events = [event('1', [{}, {}])];

    await run(store, events, T0);
    store.calls.upsertMarkets.length = 0;

    const summary = await run(store, [event('1', [{}, {}])], T1);

    expect(summary.markets).toEqual({ seen: 2, created: 0, updated: 0, unchanged: 2, skipped: 0 });
    expect(summary.revisions).toBe(0);

    // The unchanged path must not touch content at all.
    expect(store.calls.upsertMarkets).toEqual([0]);
    expect(store.calls.touchMarkets).toEqual([0, 2]);

    const row = store.markets.get('0xcond1-0');
    expect(row?.lastSeenAt).toBe(T1);
    expect(row?.firstSeenAt).toBe(T0);
    expect(row?.question).toBe('Will it?');
  });

  it('writes one revision per changed field when a market is edited', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}])], T0);
    const before = store.markets.get('0xcond1-0')?.contentHash;

    const summary = await run(
      store,
      [
        event('1', [
          {
            question: 'Will it, though?',
            resolutionSource: 'https://b.example',
            volume: 999_999,
          },
        ]),
      ],
      T1,
    );

    expect(summary.markets).toEqual({ seen: 1, created: 0, updated: 1, unchanged: 0, skipped: 0 });
    expect(summary.revisions).toBe(2);

    const fields = store.revisions.map((revision) => revision.field).toSorted();
    expect(fields).toEqual(['question', 'resolution_source']);

    const question = store.revisions.find((revision) => revision.field === 'question');
    expect(question?.oldValue).toBe('Will it?');
    expect(question?.newValue).toBe('Will it, though?');
    expect(question?.conditionId).toBe('0xcond1-0');
    expect(question?.changedAt).toBe(T1);

    // Both revisions bracket the same edit, so the history can be replayed.
    expect(question?.contentHashBefore).toBe(before);
    expect(question?.contentHashAfter).toBe(store.markets.get('0xcond1-0')?.contentHash);
    expect(new Set(store.revisions.map((revision) => revision.contentHashBefore)).size).toBe(1);
  });

  it('records a silent edit that would otherwise be invisible', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{ description: 'Resolves on the official count.' }])], T0);

    await run(store, [event('1', [{ description: 'Resolves on the AP call.' }])], T1);

    const [revision] = store.revisions;
    expect(store.revisions).toHaveLength(1);
    expect(revision?.field).toBe('description');
    expect(revision?.oldValue).toBe('Resolves on the official count.');
    expect(revision?.newValue).toBe('Resolves on the AP call.');
  });

  it('records a close and a later reopen', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{ closed: false, active: true }])], T0);
    await run(store, [event('1', [{ closed: true, active: false }])], T1);
    await run(store, [event('1', [{ closed: false, active: true }])], T2);

    expect(store.revisions.map((revision) => [revision.field, revision.newValue])).toEqual([
      ['active', false],
      ['closed', true],
      ['active', true],
      ['closed', false],
    ]);
    expect(store.markets.get('0xcond1-0')?.closed).toBe(false);
  });

  it('does not move an event closed_at once it is set', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [], { closed: true })], T0);
    await run(store, [event('1', [], { closed: true })], T1);

    expect(store.events.get('1')?.closedAt).toBe(T0);
    expect(store.events.get('1')?.lastSeenAt).toBe(T1);
  });

  it('backfills clob token ids minted after the market was published', async () => {
    const store = createFakeStore();

    // Polymarket publishes a market before its CLOB tokens exist.
    await run(store, [event('1', [{}])], T0);
    expect(store.markets.get('0xcond1-0')?.clobTokenIds).toBeNull();

    // Nothing else about the market changes when they are minted, so the
    // backfill only lands because `clob_token_ids` is inside the hash.
    const summary = await run(store, [event('1', [{ clobTokenIds: '["711", "712"]' }])], T1);

    expect(summary.markets.updated).toBe(1);
    expect(store.markets.get('0xcond1-0')?.clobTokenIds).toEqual(['711', '712']);

    expect(summary.revisions).toBe(1);
    const [revision] = store.revisions;
    expect(revision?.field).toBe('clob_token_ids');
    expect(revision?.oldValue).toBeNull();
    expect(revision?.newValue).toEqual(['711', '712']);
  });

  it('records a token id swap, which repoints every outcome', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{ clobTokenIds: '["711", "712"]' }])], T0);

    const summary = await run(store, [event('1', [{ clobTokenIds: '["712", "711"]' }])], T1);

    expect(summary.revisions).toBe(1);
    expect(store.revisions[0]?.oldValue).toEqual(['711', '712']);
    expect(store.revisions[0]?.newValue).toEqual(['712', '711']);
  });

  it('ignores churn in volatile fields', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{ volume: 1 }])], T0);
    const summary = await run(store, [event('1', [{ volume: 5_000_000 }])], T1);

    expect(summary.markets.unchanged).toBe(1);
    expect(store.revisions).toEqual([]);
  });
});

describe('markets that disappear', () => {
  it('flags rather than deletes, and stamps when it went missing', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}, {}])], T0);

    // The second crawl returns only the first market.
    const summary = await run(
      store,
      [makeEvent({ ...rawEvent('1'), markets: [rawMarket('1', 0)] })],
      T1,
      { reconcileMissing: true },
    );

    expect(store.markets.size).toBe(2);
    expect(summary.missing).toBe(1);

    const gone = store.markets.get('0xcond1-1');
    expect(gone).toBeDefined();
    // Stamped with the last crawl that did return it, not with "now".
    expect(gone?.missingSince).toBe(T0);
    expect(gone?.lastSeenAt).toBe(T0);

    expect(store.markets.get('0xcond1-0')?.missingSince).toBeNull();
  });

  it('clears the flag the moment a market comes back', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}, {}])], T0);
    await run(store, [makeEvent({ ...rawEvent('1'), markets: [rawMarket('1', 0)] })], T1, {
      reconcileMissing: true,
    });
    expect(store.markets.get('0xcond1-1')?.missingSince).toBe(T0);

    const summary = await run(store, [event('1', [{}, {}])], T2, { reconcileMissing: true });

    expect(store.markets.get('0xcond1-1')?.missingSince).toBeNull();
    expect(summary.missing).toBe(0);
  });

  it('skips the sweep by default when the crawl was not a full one', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}, {}])], T0);

    // A supplied source is not known to cover the catalog, so sweeping would
    // flag everything the caller filtered out.
    const summary = await run(store, [event('1', [{}])], T1);

    expect(summary.missing).toBeNull();
    expect(store.markets.get('0xcond1-1')?.missingSince).toBeNull();
  });
});

describe('resilience', () => {
  it('skips markets with no condition_id and counts them', async () => {
    const store = createFakeStore();
    const logger = silentLogger();

    const broken = makeEvent({
      id: '1',
      slug: 'event-1',
      markets: [
        { id: 'a', slug: 'no-condition-id', question: 'Unstorable?' },
        rawMarket('1', 0),
      ],
    });

    const summary = await ingestCatalog({
      store,
      source: stream([broken]),
      now: () => T0,
      logger,
    });

    expect(summary.markets).toEqual({ seen: 2, created: 1, updated: 0, unchanged: 0, skipped: 1 });
    expect(store.markets.size).toBe(1);
    expect(logger.warnings.some((msg) => msg.includes('no condition_id'))).toBe(true);
  });

  it('keeps the summary invariant: seen equals the sum of the outcomes', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}])], T0);

    const summary = await run(
      store,
      [
        event('1', [{}, { question: 'changed' }]),
        makeEvent({
          id: '2',
          slug: 'event-2',
          markets: [{ id: 'x', question: 'no condition id' }],
        }),
      ],
      T1,
    );

    const { seen, created, updated, unchanged, skipped } = summary.markets;
    expect(created + updated + unchanged + skipped).toBe(seen);
    expect(summary.markets).toEqual({ seen: 3, created: 1, updated: 0, unchanged: 1, skipped: 1 });
  });

  it('writes one row when a condition_id appears twice in a batch', async () => {
    const store = createFakeStore();
    const logger = silentLogger();

    const duplicated = makeEvent({
      id: '1',
      slug: 'event-1',
      markets: [rawMarket('1', 0), { ...rawMarket('1', 0), question: 'The later one wins' }],
    });

    const summary = await ingestCatalog({
      store,
      source: stream([duplicated]),
      now: () => T0,
      logger,
    });

    expect(store.markets.size).toBe(1);
    expect(store.markets.get('0xcond1-0')?.question).toBe('The later one wins');
    expect(summary.markets.seen).toBe(1);
    expect(logger.warnings.some((msg) => msg.includes('twice in a batch'))).toBe(true);
  });

  it('commits per batch, so a crash keeps what already landed', async () => {
    const store = createFakeStore();
    store.failOnTransaction = 2;

    const events = [event('1', [{}]), event('2', [{}]), event('3', [{}])];

    await expect(
      ingestCatalog({
        store,
        source: stream(events),
        now: () => T0,
        logger: silentLogger(),
        batchSize: 1,
      }),
    ).rejects.toThrow('simulated crash');

    // Batch one committed; batch two rolled back whole; batch three never ran.
    expect([...store.markets.keys()]).toEqual(['0xcond1-0']);
    expect(store.events.size).toBe(1);
  });

  it('rolls a failed batch back entirely, revisions included', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}])], T0);
    expect(store.revisions).toHaveLength(0);

    store.failOnTransaction = store.calls.transactions + 1;

    await expect(
      ingestCatalog({
        store,
        source: stream([event('1', [{ question: 'edited' }])]),
        now: () => T1,
        logger: silentLogger(),
      }),
    ).rejects.toThrow('simulated crash');

    // Neither the edit nor its revision survived.
    expect(store.revisions).toEqual([]);
    expect(store.markets.get('0xcond1-0')?.question).toBe('Will it?');
    // Restored from the pre-batch snapshot, so equal to T0 but not the same object.
    expect(store.markets.get('0xcond1-0')?.lastSeenAt).toEqual(T0);
  });

  it('resumes after a crash with no duplicate rows or revisions', async () => {
    const store = createFakeStore();
    await run(store, [event('1', [{}]), event('2', [{}])], T0);

    store.failOnTransaction = store.calls.transactions + 2;
    const edited = [event('1', [{ question: 'edited' }]), event('2', [{ question: 'edited too' }])];

    await expect(
      ingestCatalog({
        store,
        source: stream(edited),
        now: () => T1,
        logger: silentLogger(),
        batchSize: 1,
      }),
    ).rejects.toThrow('simulated crash');

    expect(store.revisions).toHaveLength(1);

    // The next run re-crawls from the start; the already-applied edit is now
    // simply unchanged, so it produces no second revision.
    const summary = await run(store, edited, T2);

    expect(summary.markets).toEqual({ seen: 2, created: 0, updated: 1, unchanged: 1, skipped: 0 });
    expect(store.revisions).toHaveLength(2);
    expect(store.markets.size).toBe(2);
    expect(store.revisions.filter((r) => r.conditionId === '0xcond1-0')).toHaveLength(1);
  });

  it('logs a summary even when the run fails', async () => {
    const store = createFakeStore();
    store.failOnTransaction = 1;

    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const logger: IngestLogger = {
      debug: () => {},
      info: (obj, msg) => lines.push({ obj: obj as Record<string, unknown>, msg }),
      warn: () => {},
      error: (obj, msg) => lines.push({ obj: obj as Record<string, unknown>, msg }),
    };

    await expect(
      ingestCatalog({ store, source: stream([event('1', [{}])]), now: () => T0, logger }),
    ).rejects.toThrow();

    const [line] = lines;
    expect(line?.msg).toBe('catalog ingest failed');
    expect(line?.obj['complete']).toBe(false);
    expect(line?.obj['error']).toContain('simulated crash');
    expect(line?.obj['durationMs']).toBeTypeOf('number');
  });
});

describe('batching', () => {
  it('opens one transaction per batch', async () => {
    const store = createFakeStore();
    const events = [event('1', [{}, {}]), event('2', [{}, {}]), event('3', [{}, {}])];

    await ingestCatalog({
      store,
      source: stream(events),
      now: () => T0,
      logger: silentLogger(),
      batchSize: 2,
    });

    expect(store.calls.transactions).toBe(3);
    expect(store.markets.size).toBe(6);
  });

  it('flushes a trailing partial batch', async () => {
    const store = createFakeStore();

    await ingestCatalog({
      store,
      source: stream([event('1', [{}, {}]), event('2', [{}])]),
      now: () => T0,
      logger: silentLogger(),
      batchSize: 2,
    });

    expect(store.calls.transactions).toBe(2);
    expect(store.markets.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------

function fetchingFixtures(): { fetch: typeof globalThis.fetch; calls: number[] } {
  const calls: number[] = [];
  const fetch: typeof globalThis.fetch = async () => {
    calls.push(calls.length);
    return new Response(fixtureText('events-page-1'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

describe('end to end, from recorded payloads', () => {
  it('crawls, parses, reconciles, and archives in one pass', async () => {
    const store = createFakeStore();
    const { fetch } = fetchingFixtures();

    const summary = await ingestCatalog({
      store,
      logger: silentLogger(),
      now: () => T0,
      gamma: { baseUrl: 'https://gamma.test', fetch },
    });

    expect(summary.events.seen).toBe(2);
    expect(summary.markets).toEqual({ seen: 2, created: 2, updated: 0, unchanged: 0, skipped: 0 });
    expect(summary.rawPayloads).toEqual({ archived: 1, duplicate: 0 });
    // A default crawl is a full one, so the sweep runs.
    expect(summary.missing).toBe(0);

    expect(store.events.get('12345')?.title).toBe('Fed decision in March');
    expect(store.events.get('12345')?.closedAt).toBe(T0);

    const market = store.markets.get(
      '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
    );
    expect(market?.question).toBe('Fed cuts rates in March?');
    expect(market?.outcomes).toEqual(['Yes', 'No']);
    expect(market?.eventId).toBe('12345');
    expect(market?.endDate?.toISOString()).toBe('2025-03-20T21:00:00.000Z');
  });

  it('archives an unchanged catalog once, not once per run', async () => {
    const store = createFakeStore();
    const { fetch } = fetchingFixtures();
    const options = { store, logger: silentLogger(), gamma: { baseUrl: 'https://gamma.test', fetch } };

    const first = await ingestCatalog({ ...options, now: () => T0 });
    const second = await ingestCatalog({ ...options, now: () => T1 });

    expect(first.rawPayloads).toEqual({ archived: 1, duplicate: 0 });
    expect(second.rawPayloads).toEqual({ archived: 0, duplicate: 1 });
    expect(store.rawPayloads).toHaveLength(1);
    expect(store.rawPayloads[0]?.endpoint).toBe('/events/keyset?limit=100');

    expect(second.markets.unchanged).toBe(2);
    expect(store.revisions).toEqual([]);
  });

  it('archives the payload even when the records inside it are malformed', async () => {
    const store = createFakeStore();
    const body = fixtureText('markets-malformed-shapes');
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: '1', markets: JSON.parse(body).data }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const summary = await ingestCatalog({
      store,
      logger: silentLogger(),
      now: () => T0,
      gamma: { baseUrl: 'https://gamma.test', fetch },
    });

    // Four records had no id and one had no condition_id, so nothing stored —
    // but the payload that produced them is on disk to be re-examined.
    expect(summary.markets.skipped).toBe(1);
    expect(store.markets.size).toBe(0);
    expect(store.rawPayloads).toHaveLength(1);
    expect(summary.rawPayloads.archived).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Raw shapes for the cases that need to bypass the `event()` helper.

function rawEvent(id: string): Record<string, unknown> {
  return { id, slug: `event-${id}`, title: `Event ${id}`, negRisk: false };
}

function rawMarket(eventId: string, index: number): Record<string, unknown> {
  return {
    id: `${eventId}-${index}`,
    conditionId: `0xcond${eventId}-${index}`,
    slug: `market-${eventId}-${index}`,
    question: 'Will it?',
    description: 'Resolves per the source.',
    resolutionSource: 'https://example.com',
    outcomes: '["Yes", "No"]',
    endDate: '2026-12-31T12:00:00Z',
    active: true,
    closed: false,
    volume: 100,
  };
}

// A guard against the fixture loader silently returning nothing.
describe('fixtures', () => {
  it('are present', () => {
    expect(loadFixture('events-page-1')).toBeTypeOf('object');
  });
});
