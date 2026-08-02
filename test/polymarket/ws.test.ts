import { beforeEach, describe, expect, it } from 'vitest';

import { resetMetrics } from '../../src/metrics.js';
import { ClobClient } from '../../src/polymarket/clob.js';
import { MarketFeed, type WebSocketLike } from '../../src/polymarket/ws.js';

/**
 * The feed, against a scripted socket and a scripted REST client.
 *
 * Almost every assertion here is about a hazard that was measured against the
 * live venue and would otherwise corrupt a book quietly — the absolute/delta
 * question, the unreliable initial snapshot, the immutable subscription. A
 * corrupted book does not throw. It produces a confident, well-formed, wrong
 * price, which is the failure mode this whole project is built to avoid.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  /** The venue dropping us, as opposed to us closing. */
  drop(code = 1006, reason = 'abnormal'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
}

interface RestBook {
  bids: [number, number][];
  asks: [number, number][];
  hash?: string;
}

/**
 * A real `ClobClient` over a scripted fetch, so the seed path exercises the
 * actual wire parsing and normalisation rather than a stand-in for it.
 *
 * The clock advances on every sleep. A frozen clock plus a no-op sleep spins the
 * token bucket forever once its burst is spent.
 */
function fakeClob(books: () => Record<string, RestBook>): ClobClient {
  let clock = 0;
  return new ClobClient({
    now: () => clock,
    random: () => 0,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    logger: { debug: () => {}, warn: () => {} },
    fetch: (_url, init) => {
      const requested = JSON.parse(String(init?.body ?? '[]')) as { token_id: string }[];
      const table = books();
      const payload = requested
        .filter((r) => table[r.token_id] !== undefined)
        .map((r) => {
          const book = table[r.token_id]!;
          return {
            asset_id: r.token_id,
            market: `cond-${r.token_id}`,
            hash: book.hash ?? `h-${r.token_id}`,
            timestamp: '1000',
            // Worst-first, as the venue sends it: bids ascending, asks descending.
            bids: book.bids
              .toSorted((a, b) => a[0] - b[0])
              .map(([price, size]) => ({ price: String(price), size: String(size) })),
            asks: book.asks
              .toSorted((a, b) => b[0] - a[0])
              .map(([price, size]) => ({ price: String(price), size: String(size) })),
            min_order_size: '5',
            tick_size: '0.01',
          };
        });
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
}

interface Harness {
  feed: MarketFeed;
  sockets: FakeSocket[];
  rest: Record<string, RestBook>;
  clock: { value: number };
  updates: string[];
}

async function harness(
  tokens: string[],
  rest: Record<string, RestBook>,
  options: { shardSize?: number; openImmediately?: boolean } = {},
): Promise<Harness> {
  const sockets: FakeSocket[] = [];
  const clock = { value: 0 };
  const updates: string[] = [];
  const table = { ...rest };

  const feed = new MarketFeed({
    clob: fakeClob(() => table),
    shardSize: options.shardSize ?? 100,
    now: () => clock.value,
    random: () => 0.5,
    logger: { debug: () => {}, warn: () => {} },
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      // The venue accepts the connection before `start` awaits the REST seed,
      // which is the ordering the buffering logic exists for.
      if (options.openImmediately !== false) queueMicrotask(() => socket.open());
      return socket;
    },
    onUpdate: (update) => updates.push(update.tokenId),
  });

  await feed.start(tokens);
  return { feed, sockets, rest: table, clock, updates };
}

const change = (
  assetId: string,
  price: number,
  size: number,
  side: 'BUY' | 'SELL',
  extra: { hash?: string; best_bid?: string; best_ask?: string; ts?: string } = {},
) => ({
  event_type: 'price_change',
  market: `cond-${assetId}`,
  timestamp: extra.ts ?? '2000',
  price_changes: [
    {
      asset_id: assetId,
      price: String(price),
      size: String(size),
      side,
      ...(extra.hash === undefined ? {} : { hash: extra.hash }),
      ...(extra.best_bid === undefined ? {} : { best_bid: extra.best_bid }),
      ...(extra.best_ask === undefined ? {} : { best_ask: extra.best_ask }),
    },
  ],
});

const BOOK: RestBook = {
  bids: [
    [0.4, 100],
    [0.39, 200],
  ],
  asks: [
    [0.42, 150],
    [0.43, 300],
  ],
};

beforeEach(() => {
  resetMetrics();
});

// ---------------------------------------------------------------------------

describe('subscription', () => {
  it('sends the whole asset set in one message', async () => {
    const { sockets } = await harness(['a', 'b'], { a: BOOK, b: BOOK });

    expect(sockets).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ assets_ids: ['a', 'b'], type: 'market' });
  });

  it('shards, because the asset set cannot be changed on a live socket', async () => {
    const { sockets } = await harness(['a', 'b', 'c'], { a: BOOK, b: BOOK, c: BOOK }, { shardSize: 2 });

    expect(sockets).toHaveLength(2);
    expect(JSON.parse(sockets[0]!.sent[0]!).assets_ids).toEqual(['a', 'b']);
    expect(JSON.parse(sockets[1]!.sent[0]!).assets_ids).toEqual(['c']);
  });

  it('replaces rather than stacks when the subscription is rebuilt', async () => {
    const h = await harness(['a', 'b'], { a: BOOK, b: BOOK });
    await h.feed.start(['b', 'c']);

    // Two new sockets would mean the old ones were still subscribed, and every
    // event would be counted twice.
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0]!.closedWith).not.toBeNull();
    expect(h.feed.stats().subscribed).toBe(2);
    expect(h.feed.book('a')).toBeNull();
  });
});

describe('applying updates', () => {
  it('treats size as the new absolute level, not a delta', async () => {
    // The single most consequential fact about this protocol. Delta semantics
    // would leave 100 + 40 = 140 here.
    const { feed, sockets } = await harness(['a'], { a: BOOK });
    sockets[0]!.deliver([change('a', 0.4, 40, 'BUY')]);

    expect(feed.book('a')!.bids[0]).toEqual({ price: 0.4, size: 40 });
  });

  it('removes a level on size zero', async () => {
    const { feed, sockets } = await harness(['a'], { a: BOOK });
    sockets[0]!.deliver([change('a', 0.4, 0, 'BUY')]);

    expect(feed.book('a')!.bids.map((l) => l.price)).toEqual([0.39]);
  });

  it('keeps bids best-first and asks best-first after an update', async () => {
    const { feed, sockets } = await harness(['a'], { a: BOOK });
    sockets[0]!.deliver([change('a', 0.41, 10, 'BUY')]);
    sockets[0]!.deliver([change('a', 0.415, 10, 'SELL')]);

    const book = feed.book('a')!;
    expect(book.bids.map((l) => l.price)).toEqual([0.41, 0.4, 0.39]);
    expect(book.asks.map((l) => l.price)).toEqual([0.415, 0.42, 0.43]);
  });

  it('rejects levels that cannot exist rather than storing them', async () => {
    const { feed, sockets } = await harness(['a'], { a: BOOK });
    sockets[0]!.deliver([change('a', 1.5, 10, 'BUY')]);
    sockets[0]!.deliver([change('a', 0, 10, 'BUY')]);
    sockets[0]!.deliver([change('a', Number.NaN, 10, 'BUY')]);

    // A zero-priced level reads as free depth to the book walker.
    expect(feed.book('a')!.bids.map((l) => l.price)).toEqual([0.4, 0.39]);
  });

  it('notifies a listener once per touched token', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.updates.length = 0;
    h.sockets[0]!.deliver([change('a', 0.4, 40, 'BUY')]);

    expect(h.updates).toEqual(['a']);
  });
});

describe('unseeded books', () => {
  it('never builds a book out of price changes alone', async () => {
    // Hazard 3: with 1,000 assets subscribed the venue sent zero snapshots, and
    // 5,780 assets sent changes for books that were never snapshotted. Applying
    // those yields a book holding only the levels that moved — plausible,
    // well-formed, and missing all the resting depth behind them.
    const { feed, sockets } = await harness(['a', 'ghost'], { a: BOOK });

    sockets[0]!.deliver([change('ghost', 0.9, 500, 'BUY')]);

    expect(feed.book('ghost')).toBeNull();
    expect(feed.mid('ghost')).toBeNull();
    expect(feed.stats().changesUnseeded).toBe(1);
  });

  it('accepts a pushed snapshot when the venue does send one', async () => {
    const { feed, sockets } = await harness(['a', 'ghost'], { a: BOOK });

    sockets[0]!.deliver([
      {
        event_type: 'book',
        asset_id: 'ghost',
        market: 'cond-ghost',
        timestamp: '3000',
        hash: 'g1',
        bids: [{ price: '0.2', size: '10' }],
        asks: [{ price: '0.8', size: '10' }],
      },
    ]);

    expect(feed.mid('ghost')).toBeCloseTo(0.5, 10);
  });
});

describe('seeding', () => {
  it('drains a token the moment its own base arrives, not at the end of the seed', async () => {
    // At production size the seed spans 125 requests and several seconds. A
    // single drain at the end would leave the first batch's buffered changes
    // unapplied for the whole of it.
    const sockets: FakeSocket[] = [];
    const feed = new MarketFeed({
      clob: fakeClob(() => ({ a: BOOK, b: BOOK })),
      now: () => 0,
      logger: { debug: () => {}, warn: () => {} },
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.deliver([change('a', 0.4, 77, 'BUY', { ts: '5000' })]);
        });
        return socket;
      },
    });

    await feed.start(['a', 'b']);
    expect(feed.book('a')!.bids[0]).toEqual({ price: 0.4, size: 77 });
  });

  it('buffers changes that arrive while the seed is in flight', async () => {
    const sockets: FakeSocket[] = [];
    let clock = 0;
    const feed = new MarketFeed({
      clob: fakeClob(() => ({ a: BOOK })),
      now: () => clock,
      logger: { debug: () => {}, warn: () => {} },
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          // Arrives after the socket opens but before the REST seed lands.
          socket.deliver([change('a', 0.4, 55, 'BUY', { ts: '5000' })]);
        });
        return socket;
      },
    });

    await feed.start(['a']);
    clock += 1;

    // Dropped, this level would read 100 — the pre-seed size — forever.
    expect(feed.book('a')!.bids[0]).toEqual({ price: 0.4, size: 55 });
  });

  it('timestamps a drained book from the newest change, not the snapshot', async () => {
    // Otherwise every violation the drain opens is measured from the venue's
    // last write to that market — minutes old on a quiet one — and the latency
    // histogram fills with an artefact of seeding.
    const sockets: FakeSocket[] = [];
    const feed = new MarketFeed({
      clob: fakeClob(() => ({ a: BOOK })), // snapshot timestamp 1000
      now: () => 0,
      logger: { debug: () => {}, warn: () => {} },
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.deliver([change('a', 0.4, 55, 'BUY', { ts: '9000' })]);
        });
        return socket;
      },
    });

    await feed.start(['a']);
    expect(feed.book('a')!.timestamp).toEqual(new Date(9000));
  });

  it('discards a buffered change older than the snapshot it would rewind', async () => {
    const sockets: FakeSocket[] = [];
    const feed = new MarketFeed({
      clob: fakeClob(() => ({ a: BOOK })), // snapshot timestamp 1000
      now: () => 0,
      logger: { debug: () => {}, warn: () => {} },
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.deliver([change('a', 0.4, 999, 'BUY', { ts: '500' })]);
        });
        return socket;
      },
    });

    await feed.start(['a']);

    // The snapshot already accounts for anything before its own timestamp.
    expect(feed.book('a')!.bids[0]).toEqual({ price: 0.4, size: 100 });
  });

  it('does not accumulate buffered changes for a token that never seeds', async () => {
    // 7,600 of the markets under constraint have no CLOB book at all. Their
    // buffers are never drained by an install, so they have to be dropped.
    const sockets: FakeSocket[] = [];
    const feed = new MarketFeed({
      clob: fakeClob(() => ({ a: BOOK })),
      now: () => 0,
      logger: { debug: () => {}, warn: () => {} },
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.deliver([change('ghost', 0.5, 10, 'BUY', { ts: '9000' })]);
        });
        return socket;
      },
    });

    await feed.start(['a', 'ghost']);
    // If the buffer survived, a later seed would replay a stale change onto it.
    await feed.seed(['ghost']);

    expect(feed.book('ghost')).toBeNull();
  });

  it('reports no book for a token the venue does not know', async () => {
    const { feed } = await harness(['a', 'unknown'], { a: BOOK });

    expect(feed.book('unknown')).toBeNull();
    expect(feed.stats().seeded).toBe(1);
  });
});

describe('reads', () => {
  it('has no midpoint for a one-sided book', async () => {
    const { feed } = await harness(['a'], { a: { bids: [[0.4, 10]], asks: [] } });

    expect(feed.top('a')).toEqual({ bid: 0.4, ask: null, mid: null, spread: null });
    expect(feed.mid('a')).toBeNull();
  });

  it('carries seed metadata the feed itself never sends', async () => {
    const { feed } = await harness(['a'], { a: BOOK });
    const book = feed.book('a')!;

    // `minOrderSize` gates the smallest tradeable basket in stage 2.
    expect(book.minOrderSize).toBe(5);
    expect(book.tickSize).toBe(0.01);
  });
});

describe('heartbeat and reconnection', () => {
  it('pings on the interval, because silence is not evidence of health', async () => {
    const h = await harness(['a'], { a: BOOK }, { shardSize: 100 });
    const socket = h.sockets[0]!;
    socket.sent.length = 0;

    h.clock.value = 10_000;
    h.feed.tick();

    expect(socket.sent).toEqual(['PING']);
  });

  it('recycles a connection that has gone silent past the deadline', async () => {
    const h = await harness(['a'], { a: BOOK });
    const first = h.sockets[0]!;

    h.clock.value = 31_000;
    h.feed.tick();

    expect(first.closedWith).not.toBeNull();
    expect(h.feed.stats().reconnects).toBe(1);
  });

  it('counts a recycled connection once, not twice', async () => {
    // Closing a socket fires its own `onclose`; without detaching first, one
    // stale connection would schedule two reconnects and double the backoff.
    const h = await harness(['a'], { a: BOOK });
    h.clock.value = 31_000;
    h.feed.tick();
    h.feed.tick();

    expect(h.feed.stats().reconnects).toBe(1);
  });

  it('backs off, then reconnects and resubscribes', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.sockets[0]!.drop();

    // Backoff is 0.5 * 500ms with the harness's fixed random.
    h.feed.tick();
    expect(h.sockets).toHaveLength(1);

    h.clock.value = 400;
    h.feed.tick();
    await Promise.resolve();

    expect(h.sockets).toHaveLength(2);
    expect(JSON.parse(h.sockets[1]!.sent[0]!)).toEqual({ assets_ids: ['a'], type: 'market' });
  });

  it('re-seeds after a reconnect rather than trusting the old book', async () => {
    const h = await harness(['a'], { a: BOOK });

    // The book moves while we are disconnected. Nothing is replayed for that
    // window, so keeping the old state would be stale and silent about it.
    h.sockets[0]!.drop();
    h.rest['a'] = { bids: [[0.6, 10]], asks: [[0.7, 10]], hash: 'moved' };

    h.clock.value = 400;
    h.feed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.feed.mid('a')).toBeCloseTo(0.65, 10);
  });

  it('stops reconnecting once stopped', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.feed.stop();
    const before = h.sockets.length;

    h.clock.value = 100_000;
    h.feed.tick();

    expect(h.sockets).toHaveLength(before);
  });
});

describe('frames that are not book updates', () => {
  it('accepts PONG without complaint', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.sockets[0]!.deliver('PONG');

    expect(h.feed.stats().messages).toBe(1);
  });

  it('survives an unparseable frame', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.sockets[0]!.deliver('{not json');
    h.sockets[0]!.deliver([change('a', 0.4, 40, 'BUY')]);

    expect(h.feed.book('a')!.bids[0]!.size).toBe(40);
  });

  it('ignores an unknown event type instead of failing', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.sockets[0]!.deliver([{ event_type: 'tick_size_change', asset_id: 'a', new_tick_size: '0.001' }]);

    expect(h.feed.book('a')!.bids).toHaveLength(2);
  });
});

describe('top-of-book hint', () => {
  it('stays quiet when the applied top matches the venue', async () => {
    const h = await harness(['a'], { a: BOOK });
    h.sockets[0]!.deliver([
      change('a', 0.41, 10, 'BUY', { best_bid: '0.41', best_ask: '0.42' }),
    ]);

    expect(h.feed.stats().topHints).toBe(0);
  });

  it('records a hint when the reported top runs ahead of ours', async () => {
    // Not a divergence: the reported top is the venue's *current* best, which
    // routinely leads the incremental stream (hazard 6). It means "you are
    // behind", which is a reason to reconcile this token next, not a defect.
    const h = await harness(['a'], { a: BOOK });
    h.sockets[0]!.deliver([
      change('a', 0.41, 10, 'BUY', { best_bid: '0.55', best_ask: '0.42' }),
    ]);

    expect(h.feed.stats().topHints).toBe(1);
    expect(h.feed.stats().contentDivergences).toBe(0);
  });

  it('reconciles a hinted token ahead of the rotation', async () => {
    const rest = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, { ...BOOK, hash: `h-${id}` }]),
    );
    const h = await harness(['a', 'b', 'c'], rest);

    // 'c' is last in the rotation, but the hint should promote it.
    h.sockets[0]!.deliver([
      change('c', 0.41, 10, 'BUY', { best_bid: '0.55', best_ask: '0.42' }),
    ]);
    const report = await h.feed.reconcile(1);

    expect(report.checked).toBe(1);
    expect(h.feed.stats().topHints).toBe(1);
  });

  it('does not hint on a one-sided book', async () => {
    const h = await harness(['a'], { a: { bids: [[0.4, 10]], asks: [] } });
    h.sockets[0]!.deliver([change('a', 0.4, 20, 'BUY', { best_bid: '0.4', best_ask: '0.42' })]);

    expect(h.feed.stats().topHints).toBe(0);
  });
});

describe('reconciliation', () => {
  it('agrees when the state hash and the levels both match', async () => {
    const h = await harness(['a'], { a: { ...BOOK, hash: 'h1' } });
    const report = await h.feed.reconcile(10);

    expect(report).toMatchObject({ checked: 1, agreed: 1, contentDivergences: 0, staleDivergences: 0 });
  });

  it('reports a divergence when the hash matches but the levels do not', async () => {
    // The one case that means the incremental apply is broken, and the one the
    // acceptance criterion is about.
    const h = await harness(['a'], { a: { ...BOOK, hash: 'h1' } });

    // Same hash the seed installed, different depth behind it.
    h.rest['a'] = { bids: [[0.4, 999]], asks: [[0.42, 150]], hash: 'h1' };
    const report = await h.feed.reconcile(10);

    expect(report.contentDivergences).toBe(1);
    // Repaired, not merely reported.
    expect(h.feed.book('a')!.bids[0]!.size).toBe(999);
  });

  it('treats a REST snapshot older than our state as expected, not divergence', async () => {
    const h = await harness(['a'], { a: { ...BOOK, hash: 'h1' } });

    // We advance past the seed state; REST still answers with the old hash.
    h.sockets[0]!.deliver([change('a', 0.4, 40, 'BUY', { hash: 'h2' })]);
    const report = await h.feed.reconcile(10);

    expect(report).toMatchObject({ ahead: 1, contentDivergences: 0, staleDivergences: 0 });
    // Not clobbered by the stale snapshot.
    expect(h.feed.book('a')!.bids[0]!.size).toBe(40);
  });

  it('defers judgment on an unrecognised state, then reports it if it persists', async () => {
    // An update still in flight and one that was never delivered look identical
    // in the moment. Calling the first one a divergence would keep the counter
    // permanently non-zero and make it meaningless.
    const h = await harness(['a'], { a: { ...BOOK, hash: 'h1' } });
    h.rest['a'] = { ...BOOK, hash: 'never-seen' };

    const first = await h.feed.reconcile(10);
    expect(first).toMatchObject({ staleDivergences: 0, pending: 1 });

    const second = await h.feed.reconcile(10);
    expect(second.staleDivergences).toBe(1);
  });

  it('clears a parked token when the in-flight update finally arrives', async () => {
    const h = await harness(['a'], { a: { ...BOOK, hash: 'h1' } });
    h.rest['a'] = { ...BOOK, hash: 'in-flight' };

    expect((await h.feed.reconcile(10)).pending).toBe(1);

    // The event that was in flight lands.
    h.sockets[0]!.deliver([change('a', 0.4, 100, 'BUY', { hash: 'in-flight' })]);
    const second = await h.feed.reconcile(10);

    expect(second).toMatchObject({ staleDivergences: 0, agreed: 1 });
  });

  it('rotates through the token set rather than rechecking the same ones', async () => {
    const rest = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, { ...BOOK, hash: `h-${id}` }]));
    const h = await harness(['a', 'b', 'c', 'd'], rest);

    const first = await h.feed.reconcile(2);
    const second = await h.feed.reconcile(2);

    expect(first.checked).toBe(2);
    expect(second.checked).toBe(2);
    expect(first.agreed + second.agreed).toBe(4);
  });

  it('keeps hints that do not fit in one pass instead of dropping them', async () => {
    // Hints arrive in the hundreds under load. Taking a slice and clearing the
    // whole queue would silently discard every one past the budget.
    const rest = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((id) => [id, { ...BOOK, hash: `h-${id}` }]),
    );
    const h = await harness(['a', 'b', 'c', 'd'], rest);

    for (const id of ['a', 'b', 'c', 'd']) {
      h.sockets[0]!.deliver([change(id, 0.41, 10, 'BUY', { best_bid: '0.55', best_ask: '0.42' })]);
    }

    // Budget of 1 leaves three hints outstanding; they must survive the pass.
    await h.feed.reconcile(2);
    expect(h.feed.stats().topHints).toBe(4);

    // Still reconciling rather than having lost them.
    const second = await h.feed.reconcile(2);
    expect(second.checked).toBeGreaterThan(0);
  });

  it('does nothing when no book has been seeded', async () => {
    const h = await harness(['unknown'], {});
    expect(await h.feed.reconcile(10)).toMatchObject({ checked: 0 });
  });
});
