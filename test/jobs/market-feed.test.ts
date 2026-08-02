import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { beforeEach, describe, expect, it } from 'vitest';

import type * as schema from '../../src/db/schema.js';
import { startMarketFeed } from '../../src/jobs/market-feed.js';
import { resetMetrics } from '../../src/metrics.js';
import { ClobClient } from '../../src/polymarket/clob.js';
import { MarketFeed, type WebSocketLike } from '../../src/polymarket/ws.js';

/**
 * The runner: subscription rebuild, the debounced screen, and the trigger.
 *
 * The interesting behaviour is what it does *not* do. A whole event re-pricing
 * produces dozens of detections in one flush and they all want the same thing —
 * one two-stage check — so a burst must collapse to a single trigger, and a
 * market churning across the epsilon must not queue a check per debounce window.
 */

type Database = PostgresJsDatabase<typeof schema>;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

/**
 * A database that answers exactly the three reads the runner performs:
 * relations, partition groups, and the market→token mapping.
 */
function fakeDatabase(
  edges: { id: number; from_condition_id: string; to_condition_id: string; type: string }[],
  tokens: { conditionId: string; clobTokenIds: string[] }[],
): Database {
  // `loadConstraints` reads edges then partition groups, so the answers
  // alternate and a second refresh sees the same graph as the first.
  let call = 0;
  return {
    execute: () => {
      call += 1;
      return Promise.resolve(call % 2 === 1 ? edges.map((e) => ({ ...e, rationale: null })) : []);
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve(tokens) }) }),
  } as unknown as Database;
}

function fakeClob(books: Record<string, { bid: number; ask: number }>): ClobClient {
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
      const payload = requested
        .filter((r) => books[r.token_id] !== undefined)
        .map((r) => ({
          asset_id: r.token_id,
          market: 'c',
          hash: `h-${r.token_id}`,
          timestamp: '1000',
          bids: [{ price: String(books[r.token_id]!.bid), size: '100' }],
          asks: [{ price: String(books[r.token_id]!.ask), size: '100' }],
        }));
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
}

/** A → B entailment, priced so it holds: 0.40 <= 0.60. */
async function scenario(options: { triggerCooldownMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const clock = { value: 0 };
  const triggers: string[] = [];

  const feed = new MarketFeed({
    clob: fakeClob({ tokA: { bid: 0.39, ask: 0.41 }, tokB: { bid: 0.59, ask: 0.61 } }),
    now: () => clock.value,
    logger: { debug: () => {}, warn: () => {} },
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });

  const runner = await startMarketFeed({
    database: fakeDatabase(
      [{ id: 1, from_condition_id: 'A', to_condition_id: 'B', type: 'implies' }],
      [
        { conditionId: 'A', clobTokenIds: ['tokA', 'tokA2'] },
        { conditionId: 'B', clobTokenIds: ['tokB', 'tokB2'] },
      ],
    ),
    feed,
    epsilon: 0.005,
    now: () => clock.value,
    timers: false,
    trigger: (reason) => {
      triggers.push(reason);
      return Promise.resolve();
    },
    ...(options.triggerCooldownMs === undefined ? {} : { triggerCooldownMs: options.triggerCooldownMs }),
  });

  return { runner, sockets, clock, triggers, feed };
}

/** Moves A's book so P(A) becomes ~0.9 and the entailment breaks. */
function breakIt(socket: FakeSocket): void {
  socket.deliver([
    {
      event_type: 'price_change',
      market: 'c',
      timestamp: '1500',
      price_changes: [
        { asset_id: 'tokA', price: '0.39', size: '0', side: 'BUY', best_bid: '0.89', best_ask: '0.41' },
        { asset_id: 'tokA', price: '0.89', size: '50', side: 'BUY', best_bid: '0.89', best_ask: '0.91' },
        { asset_id: 'tokA', price: '0.41', size: '0', side: 'SELL', best_bid: '0.89', best_ask: '0.91' },
        { asset_id: 'tokA', price: '0.91', size: '50', side: 'SELL', best_bid: '0.89', best_ask: '0.91' },
      ],
    },
  ]);
}

beforeEach(() => {
  resetMetrics();
});

describe('startMarketFeed', () => {
  it('subscribes to the outcome-0 token of every market under constraint', async () => {
    const { runner, sockets } = await scenario();

    // Not tokA2/tokB2: the second outcome is one minus the first, so
    // subscribing to it doubles the bandwidth to learn a known number.
    expect(JSON.parse(sockets[0]!.sent[0]!).assets_ids).toEqual(['tokA', 'tokB']);
    expect(runner.feed.stats().seeded).toBe(2);
    runner.close();
  });

  it('triggers a check when a live book breaks a constraint', async () => {
    const { runner, sockets, triggers } = await scenario();

    breakIt(sockets[0]!);
    const detections = await runner.flush();

    expect(detections.map((d) => d.constraintKey)).toEqual(['implies:1']);
    expect(triggers).toHaveLength(1);
    runner.close();
  });

  it('measures detection latency from the venue timestamp', async () => {
    const { runner, sockets, clock } = await scenario();

    clock.value = 3_000; // venue said 1500
    breakIt(sockets[0]!);
    const [detection] = await runner.flush();

    expect(detection!.latencyMs).toBe(1_500);
    runner.close();
  });

  it('collapses a burst of detections into one trigger', async () => {
    const { runner, sockets, triggers } = await scenario();

    breakIt(sockets[0]!);
    await runner.flush();
    // Same violation, still open, more updates.
    breakIt(sockets[0]!);
    await runner.flush();

    expect(triggers).toHaveLength(1);
    runner.close();
  });

  it('holds the cooldown when a second violation opens straight away', async () => {
    const { runner, sockets, triggers, clock } = await scenario({ triggerCooldownMs: 5_000 });

    breakIt(sockets[0]!);
    await runner.flush();
    expect(triggers).toHaveLength(1);

    // It closes and reopens inside the cooldown: a real second detection, but
    // not a reason for a second check — the first one has not even run.
    sockets[0]!.deliver([
      {
        event_type: 'price_change',
        timestamp: '1600',
        price_changes: [{ asset_id: 'tokA', price: '0.89', size: '0', side: 'BUY' }],
      },
    ]);
    await runner.flush();
    clock.value = 1_000;
    breakIt(sockets[0]!);
    await runner.flush();

    expect(triggers).toHaveLength(1);

    clock.value = 10_000;
    sockets[0]!.deliver([
      {
        event_type: 'price_change',
        timestamp: '1700',
        price_changes: [{ asset_id: 'tokA', price: '0.9', size: '10', side: 'BUY' }],
      },
    ]);
    await runner.flush();
    expect(triggers).toHaveLength(1);
    runner.close();
  });

  it('does not trigger while the constraint holds', async () => {
    const { runner, sockets, triggers } = await scenario();

    sockets[0]!.deliver([
      {
        event_type: 'price_change',
        timestamp: '1500',
        price_changes: [{ asset_id: 'tokA', price: '0.38', size: '10', side: 'BUY' }],
      },
    ]);

    expect(await runner.flush()).toHaveLength(0);
    expect(triggers).toHaveLength(0);
    runner.close();
  });

  it('survives a trigger that throws', async () => {
    const sockets: FakeSocket[] = [];
    const feed = new MarketFeed({
      clob: fakeClob({ tokA: { bid: 0.39, ask: 0.41 }, tokB: { bid: 0.59, ask: 0.61 } }),
      now: () => 0,
      logger: { debug: () => {}, warn: () => {} },
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const runner = await startMarketFeed({
      database: fakeDatabase(
        [{ id: 1, from_condition_id: 'A', to_condition_id: 'B', type: 'implies' }],
        [
          { conditionId: 'A', clobTokenIds: ['tokA'] },
          { conditionId: 'B', clobTokenIds: ['tokB'] },
        ],
      ),
      feed,
      now: () => 0,
      timers: false,
      // A broken queue must not stop the feed from screening.
      trigger: () => Promise.reject(new Error('redis is down')),
    });

    breakIt(sockets[0]!);
    await expect(runner.flush()).resolves.toHaveLength(1);
    runner.close();
  });

  it('rebuilds the subscription on refresh', async () => {
    const { runner, sockets } = await scenario();
    const before = sockets.length;

    await runner.refresh();

    expect(sockets.length).toBeGreaterThan(before);
    expect(JSON.parse(sockets.at(-1)!.sent[0]!).assets_ids).toEqual(['tokA', 'tokB']);
    runner.close();
  });
});
