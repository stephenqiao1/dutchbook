import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  ClobClient,
  ClobHttpError,
  ClobRateLimitError,
  ClobSchemaError,
  normalizeBook,
  parseBooksPayload,
  topOfBook,
} from '../../src/polymarket/clob.js';
import { executableCost } from '../../src/pricing/executable.js';

/**
 * The CLOB client's job is mostly defensive. Three behaviours of the live
 * service will silently corrupt prices if taken at face value, and each is
 * pinned here against a fixture recorded from the running venue:
 *
 *   1. levels arrive worst-first on both sides
 *   2. `POST /books` answers out of request order
 *   3. an unknown token is dropped, with a 200 and no error
 *
 * None of these produce an exception in the naive implementation. They produce
 * confident, wrong numbers, which is why they get tests rather than comments.
 */

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/clob/books.json', import.meta.url), 'utf8'),
) as unknown[];

const silent = { debug: () => {}, warn: () => {} };

/** A client wired to a canned response, with sleeping stubbed out. */
function clientFor(
  responses: Array<{ status?: number; body?: unknown; text?: string; headers?: Record<string, string> }>,
  options: Partial<ConstructorParameters<typeof ClobClient>[0]> = {},
) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;

  const fetchMock: typeof globalThis.fetch = (input, init) => {
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    calls.push({
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const text = spec.text ?? JSON.stringify(spec.body ?? []);
    return Promise.resolve(
      new Response(text, {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json', ...spec.headers },
      }),
    );
  };

  const client = new ClobClient({
    fetch: fetchMock,
    logger: silent,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    now: () => 0,
    ...options,
  });

  return { client, calls, callCount: () => index };
}

describe('normalizeBook — wire ordering', () => {
  it('sorts both sides best-first, against the venue ordering', () => {
    // The venue sends bids ascending and asks descending, so the best price is
    // LAST on both sides. Trusting the wire order reads 0.001 as the top bid.
    const wire = {
      asset_id: 'token-1',
      bids: [
        { price: '0.001', size: '18638' },
        { price: '0.010', size: '500' },
        { price: '0.024', size: '30' },
      ],
      asks: [
        { price: '0.999', size: '167000' },
        { price: '0.100', size: '900' },
        { price: '0.033', size: '40' },
      ],
    };

    const book = normalizeBook(wire);

    expect(book.bids.map((l) => l.price)).toEqual([0.024, 0.01, 0.001]);
    expect(book.asks.map((l) => l.price)).toEqual([0.033, 0.1, 0.999]);
    expect(book.bids[0]!.price).toBe(0.024);
    expect(book.asks[0]!.price).toBe(0.033);
  });

  it('is order-insensitive: a shuffled wire book normalises identically', () => {
    const levels = [
      { price: '0.10', size: '1' },
      { price: '0.20', size: '2' },
      { price: '0.30', size: '3' },
    ];
    const a = normalizeBook({ asset_id: 't', bids: levels, asks: levels });
    const b = normalizeBook({ asset_id: 't', bids: levels.toReversed(), asks: levels.toReversed() });

    expect(a.bids).toEqual(b.bids);
    expect(a.asks).toEqual(b.asks);
  });

  it('parses decimal strings into numbers', () => {
    const book = normalizeBook({
      asset_id: 't',
      bids: [{ price: '0.024', size: '18638.5' }],
      asks: [],
    });
    expect(book.bids[0]).toEqual({ price: 0.024, size: 18638.5 });
  });

  it('drops levels that cannot be traded against', () => {
    const book = normalizeBook({
      asset_id: 't',
      bids: [
        { price: 'not-a-number', size: '10' }, // unparseable
        { price: '0.5', size: 'NaN' }, // unparseable size
        { price: '0.5', size: '0' }, // already filled
        { price: '0.5', size: '-5' }, // nonsensical
        { price: '0', size: '10' }, // outside (0, 1]
        { price: '1.5', size: '10' }, // outside (0, 1]
        { price: '0.5', size: '10' }, // the only real one
      ],
      asks: [],
    });

    // A dropped level must not become a zero-priced one: free depth is the most
    // dangerous possible way for the walker to be wrong.
    expect(book.bids).toEqual([{ price: 0.5, size: 10 }]);
  });

  it('keeps a price of exactly 1, which is a real resting order', () => {
    const book = normalizeBook({ asset_id: 't', bids: [{ price: '1', size: '5' }], asks: [] });
    expect(book.bids).toHaveLength(1);
  });

  it('reads the venue timestamp as a date', () => {
    const book = normalizeBook({ asset_id: 't', timestamp: '1785617461736' });
    expect(book.timestamp).toEqual(new Date(1_785_617_461_736));
  });

  it('tolerates a book with no sides at all', () => {
    const book = normalizeBook({ asset_id: 't' });
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(topOfBook(book)).toEqual({ bid: null, ask: null, mid: null, spread: null });
  });
});

describe('topOfBook', () => {
  it('reports mid and spread when both sides exist', () => {
    const book = normalizeBook({
      asset_id: 't',
      bids: [{ price: '0.40', size: '10' }],
      asks: [{ price: '0.60', size: '10' }],
    });
    const top = topOfBook(book);
    expect(top.bid).toBe(0.4);
    expect(top.ask).toBe(0.6);
    expect(top.mid).toBeCloseTo(0.5, 10);
    expect(top.spread).toBeCloseTo(0.2, 10);
  });

  it('has no midpoint on a one-sided book', () => {
    const book = normalizeBook({ asset_id: 't', bids: [{ price: '0.40', size: '10' }] });
    // A midpoint invented from one side would be a price nobody quoted.
    expect(topOfBook(book)).toMatchObject({ bid: 0.4, ask: null, mid: null, spread: null });
  });
});

describe('recorded live fixture', () => {
  it('parses every book', () => {
    const books = parseBooksPayload(FIXTURE);
    expect(books).toHaveLength(FIXTURE.length);
    expect(books.length).toBeGreaterThan(0);
  });

  it('normalises real books into a walkable, crossed-free state', () => {
    for (const book of parseBooksPayload(FIXTURE)) {
      const top = topOfBook(book);

      // Sorted best-first on both sides.
      for (let i = 1; i < book.bids.length; i += 1) {
        expect(book.bids[i - 1]!.price).toBeGreaterThanOrEqual(book.bids[i]!.price);
      }
      for (let i = 1; i < book.asks.length; i += 1) {
        expect(book.asks[i - 1]!.price).toBeLessThanOrEqual(book.asks[i]!.price);
      }

      // A real book is not crossed. If normalisation had the sides backwards
      // this is the assertion that would catch it.
      if (top.bid !== null && top.ask !== null) {
        expect(top.bid).toBeLessThan(top.ask);
        expect(top.spread!).toBeGreaterThan(0);
      }
    }
  });

  it('prices an order against real depth without assuming the touch', () => {
    const book = parseBooksPayload(FIXTURE).find((b) => b.asks.length > 2);
    expect(book).toBeDefined();

    const cost = executableCost(book!, 'buy', 500, { feeRate: 0 });
    if (cost.filled > 0 && cost.levelsConsumed > 1) {
      expect(cost.avgPrice!).toBeGreaterThanOrEqual(book!.asks[0]!.price);
      expect(cost.slippage!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('ClobClient.fetchBooks', () => {
  it('keys results by asset_id, not by response position', async () => {
    // The live service answers out of order. Positional mapping would attribute
    // every book to the wrong token — silently, and with plausible numbers.
    const { client } = clientFor([
      {
        body: [
          { asset_id: 'c', bids: [{ price: '0.3', size: '1' }], asks: [] },
          { asset_id: 'a', bids: [{ price: '0.1', size: '1' }], asks: [] },
          { asset_id: 'b', bids: [{ price: '0.2', size: '1' }], asks: [] },
        ],
      },
    ]);

    const { books, missing } = await client.fetchBooks(['a', 'b', 'c']);

    expect(missing).toEqual([]);
    expect(books.get('a')!.bids[0]!.price).toBe(0.1);
    expect(books.get('b')!.bids[0]!.price).toBe(0.2);
    expect(books.get('c')!.bids[0]!.price).toBe(0.3);
  });

  it('reports tokens the venue silently dropped', async () => {
    // 200 OK, fewer books than requested, no error anywhere.
    const { client } = clientFor([{ body: [{ asset_id: 'a', bids: [], asks: [] }] }]);

    const { books, missing } = await client.fetchBooks(['a', 'bogus']);

    expect(books.size).toBe(1);
    expect(missing).toEqual(['bogus']);
  });

  it('batches rather than looping single requests', async () => {
    const { client, calls, callCount } = clientFor([{ body: [] }], { batchSize: 100 });
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);

    await client.fetchBooks(ids);

    expect(callCount()).toBe(3); // 100 + 100 + 50, not 250
    expect(calls[0]!.body).toHaveLength(100);
    expect(calls[2]!.body).toHaveLength(50);
    expect(calls[0]!.url).toContain('/books');
  });

  it('sends the documented request shape', async () => {
    const { client, calls } = clientFor([{ body: [] }]);
    await client.fetchBooks(['abc']);
    expect(calls[0]!.body).toEqual([{ token_id: 'abc' }]);
  });

  it('collapses duplicate ids into one request entry but answers both callers', async () => {
    const { client, calls } = clientFor([
      { body: [{ asset_id: 'a', bids: [{ price: '0.5', size: '1' }], asks: [] }] },
    ]);

    const { books } = await client.fetchBooks(['a', 'a', 'a']);

    expect(calls[0]!.body).toHaveLength(1);
    expect(books.get('a')).toBeDefined();
  });

  it('makes no request at all for an empty list', async () => {
    const { client, callCount } = clientFor([{ body: [] }]);
    const result = await client.fetchBooks([]);
    expect(callCount()).toBe(0);
    expect(result.books.size).toBe(0);
  });

  it('clamps an oversized batch to the tested maximum', async () => {
    const { client, calls } = clientFor([{ body: [] }], { batchSize: 5000 });
    await client.fetchBooks(Array.from({ length: 600 }, (_, i) => `t${i}`));
    expect(calls[0]!.body).toHaveLength(500);
  });

  it('returns null for a single unknown token', async () => {
    const { client } = clientFor([{ body: [] }]);
    expect(await client.fetchBook('nope')).toBeNull();
  });
});

describe('ClobClient — failure handling', () => {
  it('retries a 429 and succeeds', async () => {
    const { client, callCount } = clientFor([
      { status: 429, body: { error: 'slow down' } },
      { status: 429, body: { error: 'slow down' } },
      { body: [{ asset_id: 'a', bids: [], asks: [] }] },
    ]);

    const { books } = await client.fetchBooks(['a']);

    expect(books.size).toBe(1);
    expect(callCount()).toBe(3);
  });

  it('honours Retry-After as a floor on the backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { client } = clientFor(
      [
        { status: 429, headers: { 'retry-after': '2' } },
        { body: [{ asset_id: 'a', bids: [], asks: [] }] },
      ],
      { sleep, random: () => 0 }, // zero jitter, so the floor is the only input
    );

    await client.fetchBooks(['a']);

    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it('surfaces a typed rate-limit error once the budget is spent', async () => {
    const { client } = clientFor([{ status: 429, body: { error: 'nope' } }], { maxRetries: 2 });

    await expect(client.fetchBooks(['a'])).rejects.toBeInstanceOf(ClobRateLimitError);
  });

  it('retries 5xx', async () => {
    const { client, callCount } = clientFor([
      { status: 503, body: {} },
      { body: [{ asset_id: 'a', bids: [], asks: [] }] },
    ]);
    await client.fetchBooks(['a']);
    expect(callCount()).toBe(2);
  });

  it('fails fast on a 4xx that is not a 429', async () => {
    // A 400 is our bug. Retrying it just burns the shared budget.
    const { client, callCount } = clientFor([{ status: 400, body: { error: 'bad token' } }]);

    await expect(client.fetchBooks(['a'])).rejects.toBeInstanceOf(ClobHttpError);
    expect(callCount()).toBe(1);
  });

  it('rejects a 200 whose body is not JSON', async () => {
    const { client } = clientFor([{ text: '<html>maintenance</html>' }]);
    await expect(client.fetchBooks(['a'])).rejects.toBeInstanceOf(ClobSchemaError);
  });

  it('rejects a 200 whose body is the wrong shape', async () => {
    const { client } = clientFor([{ body: { books: [] } }]);
    await expect(client.fetchBooks(['a'])).rejects.toBeInstanceOf(ClobSchemaError);
  });

  it('emits every response to the raw hook, including retries', async () => {
    const seen: Array<{ status: number; attempt: number; tokens: number }> = [];
    const { client } = clientFor(
      [
        { status: 500, body: {} },
        { body: [{ asset_id: 'a', bids: [], asks: [] }] },
      ],
      {
        onRawResponse: (raw) =>
          void seen.push({ status: raw.status, attempt: raw.attempt, tokens: raw.tokenIds.length }),
      },
    );

    await client.fetchBooks(['a']);

    expect(seen).toEqual([
      { status: 500, attempt: 0, tokens: 1 },
      { status: 200, attempt: 1, tokens: 1 },
    ]);
  });

  it('keeps going when the raw hook throws', async () => {
    // Archival must never break a fetch.
    const { client } = clientFor([{ body: [{ asset_id: 'a', bids: [], asks: [] }] }], {
      onRawResponse: () => {
        throw new Error('disk full');
      },
    });

    await expect(client.fetchBooks(['a'])).resolves.toBeDefined();
  });

  it('reports throttling to the observer before backing off', async () => {
    const events: number[] = [];
    const { client } = clientFor(
      [
        { status: 429, body: {} },
        { body: [] },
      ],
      { onRateLimited: (event) => void events.push(event.status) },
    );

    await client.fetchBooks(['a']);
    expect(events).toEqual([429]);
  });

  it('propagates a caller abort rather than treating it as a transport failure', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new ClobClient({
      fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      logger: silent,
      sleep: () => Promise.resolve(),
    });

    await expect(client.fetchBooks(['a'], { signal: controller.signal })).rejects.toThrow();
  });
});
