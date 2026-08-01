import { describe, expect, it } from 'vitest';

import {
  GammaClient,
  GammaHttpError,
  GammaNetworkError,
  GammaSchemaError,
  MAX_PAGE_LIMIT,
  RateLimitExceededError,
  parseRetryAfter,
  type GammaClientOptions,
  type GammaLogger,
  type RawResponse,
} from '../../src/polymarket/gamma.js';
import { fixtureText } from './fixtures.js';

const BASE_URL = 'https://gamma.test';

interface LogLine {
  readonly obj: Record<string, unknown>;
  readonly msg: string;
}

function captureLogger(): { logger: GammaLogger; warnings: LogLine[]; debugs: LogLine[] } {
  const warnings: LogLine[] = [];
  const debugs: LogLine[] = [];
  return {
    warnings,
    debugs,
    logger: {
      warn: (obj, msg) => warnings.push({ obj: obj as Record<string, unknown>, msg }),
      debug: (obj, msg) => debugs.push({ obj: obj as Record<string, unknown>, msg }),
    },
  };
}

type Reply = Response | Error;

/** Replies to each request in turn from `script`, recording what was asked for. */
function fakeFetch(script: Array<Reply | (() => Reply)>): {
  fetch: typeof globalThis.fetch;
  requests: URL[];
} {
  const requests: URL[] = [];

  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const step = script[requests.length];
    requests.push(url);

    if (step === undefined) throw new Error(`unscripted request #${requests.length}: ${url}`);
    const reply = typeof step === 'function' ? step() : step;
    if (reply instanceof Error) throw reply;
    return reply;
  };

  return { fetch, requests };
}

function json(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function fixtureResponse(name: string): Response {
  return json(fixtureText(name));
}

/**
 * A client whose clock, jitter, and sleep are all deterministic. Sleeping
 * advances the fake clock, which is what lets the token bucket refill without
 * any real time passing.
 */
function testClient(
  script: Array<Reply | (() => Reply)>,
  overrides: Partial<GammaClientOptions> = {},
): {
  client: GammaClient;
  requests: URL[];
  warnings: LogLine[];
  sleeps: number[];
} {
  const { fetch, requests } = fakeFetch(script);
  const { logger, warnings } = captureLogger();
  const sleeps: number[] = [];
  let clock = 0;

  const client = new GammaClient({
    baseUrl: BASE_URL,
    fetch,
    logger,
    // Full jitter multiplies the ceiling by random(); pinning it to 0.5 makes
    // the backoff sequence exactly half the ceiling, and therefore assertable.
    random: () => 0.5,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...overrides,
  });

  return { client, requests, warnings, sleeps };
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('pagination', () => {
  it('follows next_cursor until the final page omits it', async () => {
    const { client, requests } = testClient([
      fixtureResponse('markets-page-1'),
      fixtureResponse('markets-page-2'),
    ]);

    const markets = await collect(client.iterateMarkets());

    expect(markets.map((market) => market.id)).toEqual([
      '253591',
      '507118',
      '601002',
      '712004',
      '712005',
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.pathname).toBe('/markets/keyset');
    expect(requests[0]?.searchParams.get('after_cursor')).toBeNull();
    expect(requests[1]?.searchParams.get('after_cursor')).toBe('MTAwMA==');
  });

  it('never sends offset, which keyset endpoints answer with a 422', async () => {
    const { client, requests, warnings } = testClient([fixtureResponse('markets-page-2')]);

    await collect(client.iterateMarkets({ params: { offset: 100, closed: false } }));

    expect(requests[0]?.searchParams.has('offset')).toBe(false);
    expect(requests[0]?.searchParams.get('closed')).toBe('false');
    expect(warnings.some((line) => line.msg.includes('offset'))).toBe(true);
  });

  it('clamps limit to the server maximum', async () => {
    const { client, requests } = testClient([
      fixtureResponse('markets-page-2'),
      fixtureResponse('markets-page-2'),
      fixtureResponse('markets-page-2'),
    ]);

    await collect(client.iterateMarkets({ limit: 5_000 }));
    await collect(client.iterateMarkets({ limit: 0 }));
    await collect(client.iterateMarkets());

    expect(requests[0]?.searchParams.get('limit')).toBe(String(MAX_PAGE_LIMIT));
    expect(requests[1]?.searchParams.get('limit')).toBe('1');
    expect(requests[2]?.searchParams.get('limit')).toBe(String(MAX_PAGE_LIMIT));
  });

  it('resumes from a caller-supplied cursor', async () => {
    const { client, requests } = testClient([fixtureResponse('markets-page-2')]);

    await collect(client.iterateMarkets({ afterCursor: 'RESUME' }));

    expect(requests[0]?.searchParams.get('after_cursor')).toBe('RESUME');
  });

  it('stops at maxPages even when a cursor remains', async () => {
    const { client, requests } = testClient([fixtureResponse('markets-page-1')]);

    const markets = await collect(client.iterateMarkets({ maxPages: 1 }));

    expect(markets).toHaveLength(3);
    expect(requests).toHaveLength(1);
  });

  it('fetches lazily — a page at a time, not the whole catalog', async () => {
    const { client, requests } = testClient([
      fixtureResponse('markets-page-1'),
      fixtureResponse('markets-page-2'),
    ]);

    const iterator = client.iterateMarkets();

    await iterator.next();
    expect(requests).toHaveLength(1);
    await iterator.next();
    await iterator.next();
    expect(requests).toHaveLength(1);

    // Only exhausting page one triggers the request for page two.
    await iterator.next();
    expect(requests).toHaveLength(2);

    await iterator.return(undefined);
  });

  it('stops rather than looping when the server echoes its own cursor', async () => {
    const echo = json(JSON.stringify({ data: [{ id: '1' }], next_cursor: 'SAME' }));
    const { client, requests, warnings } = testClient([
      () => echo.clone(),
      () => echo.clone(),
      () => echo.clone(),
    ]);

    const markets = await collect(client.iterateMarkets());

    expect(markets).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(warnings.some((line) => line.msg.includes('cursor repeated'))).toBe(true);
  });

  it('streams events with their nested markets', async () => {
    const { client } = testClient([fixtureResponse('events-page-1')]);

    const events = await collect(client.iterateEvents());

    expect(events.map((event) => event.id)).toEqual(['12345', '90210']);
    expect(events[0]?.markets.map((market) => market.id)).toEqual(['712004', '712006']);
    expect(events[1]?.markets).toEqual([]);
  });

  it('throws a typed error when the page envelope is unrecognisable', async () => {
    const { client } = testClient([json(JSON.stringify({ error: 'not a page' }))]);

    await expect(collect(client.iterateMarkets())).rejects.toBeInstanceOf(GammaSchemaError);
  });

  it('throws when a 200 body is not JSON at all', async () => {
    const { client } = testClient([json('<html>maintenance</html>')]);

    await expect(collect(client.iterateMarkets())).rejects.toBeInstanceOf(GammaSchemaError);
  });
});

describe('degrading on malformed records', () => {
  it('nulls broken fields and logs the market id and field', async () => {
    const { client, warnings } = testClient([fixtureResponse('markets-malformed-encodings')]);

    const markets = await collect(client.iterateMarkets());

    expect(markets.map((market) => market.id)).toEqual(['900001', '900002']);
    expect(markets[0]?.outcomes).toBeNull();
    expect(markets[0]?.volume).toBe(1000.5);

    const dropped = warnings.filter((line) => line.msg.includes('field dropped'));
    expect(dropped.length).toBeGreaterThan(0);
    for (const line of dropped) {
      expect(line.obj['marketId']).toMatch(/^9000/);
      expect(typeof line.obj['field']).toBe('string');
      expect(typeof line.obj['reason']).toBe('string');
    }
    expect(dropped.map((line) => line.obj['field'])).toContain('outcomes');
  });

  it('survives dates and numbers that are prose', async () => {
    const { client, warnings } = testClient([fixtureResponse('markets-malformed-dates')]);

    const markets = await collect(client.iterateMarkets());

    expect(markets).toHaveLength(2);
    expect(markets[0]?.endDate).toBeNull();
    expect(markets[0]?.volume).toBeNull();
    // The second record's odd-but-valid forms are still coerced, not discarded.
    expect(markets[1]?.endDate?.toISOString()).toBe('2025-06-01T18:30:00.000Z');
    expect(markets[1]?.volume).toBe(15432.25);

    expect(
      warnings.filter((line) => line.msg.includes('field dropped')).map((line) => line.obj['field']),
    ).toContain('endDate');
  });

  it('skips unidentifiable records and keeps crawling the same page', async () => {
    const { client, warnings } = testClient([fixtureResponse('markets-malformed-shapes')]);

    const markets = await collect(client.iterateMarkets());

    // Four records have no usable id; the fifth follows them and still arrives.
    expect(markets.map((market) => market.id)).toEqual(['900299']);
    expect(markets[0]?.outcomePrices).toEqual([0.5, 0.5]);

    const skipped = warnings.filter((line) => line.msg.includes('unidentifiable'));
    expect(skipped).toHaveLength(4);
    expect(skipped.map((line) => line.obj['index'])).toEqual([0, 1, 2, 3]);
  });

  it('does not let a malformed page halt a multi-page crawl', async () => {
    const { client } = testClient([
      json(
        JSON.stringify({
          data: [{ id: '1' }, null, { id: 'bad', outcomes: 42 }],
          next_cursor: 'NEXT',
        }),
      ),
      fixtureResponse('markets-page-2'),
    ]);

    const markets = await collect(client.iterateMarkets());

    expect(markets.map((market) => market.id)).toEqual(['1', 'bad', '712004', '712005']);
  });
});

describe('rate limiting and retries', () => {
  it('retries a 429 and succeeds, respecting Retry-After', async () => {
    const { client, sleeps, requests } = testClient([
      json('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '2' } }),
      fixtureResponse('markets-page-2'),
    ]);

    const markets = await collect(client.iterateMarkets());

    expect(markets).toHaveLength(2);
    expect(requests).toHaveLength(2);
    // Retry-After (2s) is a floor over the jittered 125ms.
    expect(sleeps).toEqual([2_000]);
  });

  it('backs off exponentially with full jitter on 5xx', async () => {
    const { client, sleeps } = testClient([
      json('boom', { status: 500 }),
      json('boom', { status: 502 }),
      json('boom', { status: 503 }),
      fixtureResponse('markets-page-2'),
    ]);

    await collect(client.iterateMarkets());

    // random() is pinned at 0.5, so each delay is half of 250 * 2^attempt.
    expect(sleeps).toEqual([125, 250, 500]);
  });

  it('caps the backoff ceiling', async () => {
    const { client, sleeps } = testClient(
      [
        json('boom', { status: 500 }),
        json('boom', { status: 500 }),
        json('boom', { status: 500 }),
        fixtureResponse('markets-page-2'),
      ],
      { baseBackoffMs: 1_000, maxBackoffMs: 2_000 },
    );

    await collect(client.iterateMarkets());

    expect(sleeps).toEqual([500, 1_000, 1_000]);
  });

  it('gives up after exactly six retries and throws RateLimitExceededError', async () => {
    const throttle = (): Response =>
      json('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '1' } });
    const { client, requests } = testClient(Array.from({ length: 7 }, () => throttle));

    const error = await collect(client.iterateMarkets()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(error).toBeInstanceOf(GammaHttpError);
    if (!(error instanceof RateLimitExceededError)) return;

    // One initial attempt plus six retries, and no eighth request.
    expect(requests).toHaveLength(7);
    expect(error.attempts).toBe(7);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1_000);
    expect(error.name).toBe('RateLimitExceededError');
  });

  it('honours a lowered retry cap', async () => {
    const { client, requests } = testClient(
      Array.from({ length: 3 }, () => () => json('nope', { status: 429 })),
      { maxRetries: 2 },
    );

    await expect(collect(client.iterateMarkets())).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(requests).toHaveLength(3);
  });

  it('reports exhausted 5xx as an HTTP error, not a rate limit', async () => {
    const { client } = testClient(
      Array.from({ length: 3 }, () => () => json('boom', { status: 503 })),
      { maxRetries: 2 },
    );

    const error = await collect(client.iterateMarkets()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GammaHttpError);
    expect(error).not.toBeInstanceOf(RateLimitExceededError);
    expect(error instanceof GammaHttpError && error.status).toBe(503);
  });

  it('fails immediately on a non-retryable 4xx', async () => {
    const { client, requests, sleeps } = testClient([
      json('{"error":"unprocessable"}', { status: 422 }),
    ]);

    const error = await collect(client.iterateMarkets()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GammaHttpError);
    expect(error).not.toBeInstanceOf(RateLimitExceededError);
    expect(error instanceof GammaHttpError && error.status).toBe(422);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries transport failures and reports them as a network error', async () => {
    const { client, requests } = testClient(
      Array.from({ length: 3 }, () => new Error('connect ECONNREFUSED')),
      { maxRetries: 2 },
    );

    const error = await collect(client.iterateMarkets()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GammaNetworkError);
    expect(error instanceof GammaNetworkError && error.attempts).toBe(3);
    expect(String(error)).toContain('ECONNREFUSED');
    expect(requests).toHaveLength(3);
  });

  it('recovers from a transport failure that clears', async () => {
    const { client, sleeps } = testClient([
      new Error('socket hang up'),
      fixtureResponse('markets-page-2'),
    ]);

    expect(await collect(client.iterateMarkets())).toHaveLength(2);
    expect(sleeps).toEqual([125]);
  });

  it('paces requests through the token bucket', async () => {
    const { client, sleeps } = testClient(
      [
        fixtureResponse('markets-page-1'),
        json(JSON.stringify({ data: [], next_cursor: 'C2' })),
        json(JSON.stringify({ data: [] })),
      ],
      { requestsPerSecond: 2, burst: 1 },
    );

    await collect(client.iterateMarkets());

    // The burst covers the first request; the next two wait 500ms each at 2/s.
    expect(sleeps).toEqual([500, 500]);
  });

  it('does not pace below its budget', async () => {
    const { client, sleeps } = testClient(
      [fixtureResponse('markets-page-1'), fixtureResponse('markets-page-2')],
      { requestsPerSecond: 20 },
    );

    await collect(client.iterateMarkets());

    expect(sleeps).toEqual([]);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('2')).toBe(2_000);
    expect(parseRetryAfter(' 0.5 ')).toBe(500);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-01T00:00:00Z');
    expect(parseRetryAfter('Sat, 01 Aug 2026 00:00:30 GMT', () => now)).toBe(30_000);
  });

  it('caps an absurd hint instead of sleeping for a day', () => {
    expect(parseRetryAfter('86400')).toBe(60_000);
  });

  it('ignores an absent, empty, unparseable, or past value', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});

describe('raw response capture', () => {
  it('hands the unparsed body of every request to the hook', async () => {
    const captured: RawResponse[] = [];
    const { client } = testClient(
      [fixtureResponse('markets-page-1'), fixtureResponse('markets-page-2')],
      { onRawResponse: (raw) => void captured.push(raw) },
    );

    await collect(client.iterateMarkets());

    expect(captured).toHaveLength(2);
    expect(captured[0]?.status).toBe(200);
    expect(captured[0]?.attempt).toBe(0);
    expect(captured[0]?.url).toContain('/markets/keyset');
    expect(captured[0]?.headers['content-type']).toBe('application/json');

    // The payload is verbatim: still JSON-encoded lists, still `questionID`.
    const body = captured[0]?.body as { data: Array<Record<string, unknown>> };
    expect(body.data[0]?.['outcomes']).toBe('["Yes", "No"]');
    expect(body.data[0]?.['questionID']).toBeTypeOf('string');
    expect(JSON.parse(captured[0]?.text ?? '')).toEqual(body);
  });

  it('captures error responses and retries too, so nothing is lost', async () => {
    const captured: RawResponse[] = [];
    const { client } = testClient(
      [
        json('{"error":"rate limited"}', { status: 429 }),
        json('boom', { status: 500 }),
        fixtureResponse('markets-page-2'),
      ],
      { onRawResponse: (raw) => void captured.push(raw) },
    );

    await collect(client.iterateMarkets());

    expect(captured.map((raw) => raw.status)).toEqual([429, 500, 200]);
    expect(captured.map((raw) => raw.attempt)).toEqual([0, 1, 2]);
    // A non-JSON error body is still archived as text.
    expect(captured[1]?.text).toBe('boom');
    expect(captured[1]?.body).toBeUndefined();
  });

  it('awaits an async hook before moving on', async () => {
    const order: string[] = [];
    const { client } = testClient([fixtureResponse('markets-page-2')], {
      onRawResponse: async () => {
        order.push('hook:start');
        await Promise.resolve();
        order.push('hook:end');
      },
    });

    for await (const market of client.iterateMarkets()) order.push(`yield:${market.id}`);

    expect(order).toEqual(['hook:start', 'hook:end', 'yield:712004', 'yield:712005']);
  });

  it('keeps crawling when the archive hook throws', async () => {
    const { client, warnings } = testClient([fixtureResponse('markets-page-2')], {
      onRawResponse: () => {
        throw new Error('disk full');
      },
    });

    const markets = await collect(client.iterateMarkets());

    expect(markets).toHaveLength(2);
    const failure = warnings.find((line) => line.msg.includes('raw-response hook'));
    expect(failure?.obj['error']).toContain('disk full');
  });
});

describe('cancellation', () => {
  it('stops a crawl when the caller aborts', async () => {
    const controller = new AbortController();
    const { client, requests } = testClient([
      fixtureResponse('markets-page-1'),
      fixtureResponse('markets-page-2'),
    ]);

    const seen: string[] = [];
    const crawl = async (): Promise<void> => {
      for await (const market of client.iterateMarkets({ signal: controller.signal })) {
        seen.push(market.id);
        if (seen.length === 3) controller.abort();
      }
    };

    await expect(crawl()).rejects.toThrow();
    expect(seen).toHaveLength(3);
    expect(requests).toHaveLength(1);
  });
});
