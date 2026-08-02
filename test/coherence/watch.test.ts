import { beforeEach, describe, expect, it } from 'vitest';

import type { Constraint } from '../../src/coherence/constraints.js';
import { CoherenceWatcher, type PriceSource } from '../../src/coherence/watch.js';
import { resetMetrics } from '../../src/metrics.js';
import type { BookUpdate } from '../../src/polymarket/ws.js';

/**
 * The event-driven screen.
 *
 * The reason this exists rather than just handing live prices to the scheduled
 * check: a poll finds a violation an average of half its interval after it
 * opens, so a sixty-second schedule has a thirty-second median however fresh its
 * prices are. Price freshness and detection latency are different quantities.
 */

class Prices implements PriceSource {
  readonly values = new Map<string, number | null>();

  mid(tokenId: string): number | null {
    return this.values.get(tokenId) ?? null;
  }

  set(tokenId: string, value: number | null): this {
    this.values.set(tokenId, value);
    return this;
  }
}

const implies = (key: string, a: string, b: string): Constraint => ({
  key,
  kind: 'implies',
  relationIds: [1],
  groupId: null,
  members: [
    { conditionId: a, price: null },
    { conditionId: b, price: null },
  ],
});

const partition = (key: string, members: string[]): Constraint => ({
  key,
  kind: 'partition',
  relationIds: [],
  groupId: 'g1',
  members: members.map((conditionId) => ({ conditionId, price: null })),
});

const TOKENS = new Map([
  ['A', 'tokA'],
  ['B', 'tokB'],
  ['C', 'tokC'],
]);

const update = (tokenId: string, at: number | null): BookUpdate => ({
  tokenId,
  conditionId: null,
  at: at === null ? null : new Date(at),
  receivedAt: at ?? 0,
});

beforeEach(() => {
  resetMetrics();
});

describe('detection', () => {
  it('reports a constraint that crosses into violation', () => {
    const prices = new Prices().set('tokA', 0.4).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, epsilon: 0.005, now: () => 1_000 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    // P(A) <= P(B) held; now it does not.
    prices.set('tokA', 0.8);
    watcher.observe(update('tokA', 900));

    const [detection] = watcher.flush();
    expect(detection).toMatchObject({ constraintKey: 'implies:1', direction: 'over', latencyMs: 100 });
    expect(detection!.magnitude).toBeCloseTo(0.2, 10);
  });

  it('reports a violation once, not on every subsequent update', () => {
    const prices = new Prices().set('tokA', 0.8).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(1);

    prices.set('tokA', 0.85);
    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(0);
  });

  it('re-reports after the violation closes and reopens', () => {
    const prices = new Prices().set('tokA', 0.8).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(1);

    prices.set('tokA', 0.5);
    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(0);
    expect(watcher.stats().resolutions).toBe(1);

    prices.set('tokA', 0.9);
    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(1);
  });

  it('only re-screens the constraints the moved token participates in', () => {
    const prices = new Prices().set('tokA', 0.8).set('tokB', 0.6).set('tokC', 0.1);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B'), implies('implies:2', 'B', 'C')], TOKENS);

    // Only C moved, and only implies:2 involves it.
    prices.set('tokC', 0.05);
    watcher.observe(update('tokC', 0));

    const detections = watcher.flush();
    expect(detections.map((d) => d.constraintKey)).toEqual(['implies:2']);
  });

  it('finds a broken partition', () => {
    const prices = new Prices().set('tokA', 0.5).set('tokB', 0.5).set('tokC', 0.4);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([partition('partition:g1', ['A', 'B', 'C'])], TOKENS);

    watcher.observe(update('tokC', 0));
    const [detection] = watcher.flush();

    // Sums to 1.4: over, by 0.4.
    expect(detection).toMatchObject({ kind: 'partition', direction: 'over' });
    expect(detection!.magnitude).toBeCloseTo(0.4, 10);
  });
});

describe('latency', () => {
  it('measures from the last member to move, not the first', () => {
    // A constraint breaks when its final input moves. Measuring from the
    // earliest would charge the detection for however long the other leg sat
    // still, inflating the number with time nothing was wrong.
    const prices = new Prices().set('tokA', 0.4).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 10_000 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 1_000));
    prices.set('tokA', 0.9);
    watcher.observe(update('tokA', 9_500));

    expect(watcher.flush()[0]!.latencyMs).toBe(500);
  });

  it('falls back to receive time when the venue sent no timestamp', () => {
    const prices = new Prices().set('tokA', 0.9).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 5_000 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe({ tokenId: 'tokA', conditionId: null, at: null, receivedAt: 4_800 });
    expect(watcher.flush()[0]!.latencyMs).toBe(200);
  });

  it('never reports a negative latency from a clock that disagrees', () => {
    const prices = new Prices().set('tokA', 0.9).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 1_000 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    // The venue's clock is ahead of ours. That is not a violation from the
    // future.
    watcher.observe(update('tokA', 3_000));
    expect(watcher.flush()[0]!.latencyMs).toBe(0);
  });
});

describe('missing prices', () => {
  it('concludes nothing when a member has no live book', () => {
    const prices = new Prices().set('tokA', 0.9);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));

    expect(watcher.flush()).toHaveLength(0);
    expect(watcher.stats().unscreenable).toBe(1);
  });

  it('concludes nothing for a market with no token mapping', () => {
    const prices = new Prices().set('tokA', 0.9);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'Z')], TOKENS);

    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(0);
  });
});

describe('reloading the index', () => {
  it('drops constraints that no longer exist', () => {
    const prices = new Prices().set('tokA', 0.9).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));
    watcher.flush();

    watcher.load([], TOKENS);
    expect(watcher.stats()).toMatchObject({ constraints: 0, violating: 0 });
  });

  it('does not re-detect a violation that was already open', () => {
    // Markets closing and opening rebuilds this index every fifteen minutes. A
    // violation that survives the rebuild is the same violation, and reporting
    // it again would restart its measured lifetime.
    const prices = new Prices().set('tokA', 0.9).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    const constraints = [implies('implies:1', 'A', 'B')];

    watcher.load(constraints, TOKENS);
    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(1);

    watcher.load(constraints, TOKENS);
    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(0);
  });

  it('clears dirt for a token that is no longer indexed', () => {
    const prices = new Prices().set('tokA', 0.9).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));
    watcher.load([], TOKENS);

    expect(watcher.flush()).toHaveLength(0);
  });
});

describe('epsilon', () => {
  it('ignores a gap inside the venue tick', () => {
    const prices = new Prices().set('tokA', 0.6004).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, epsilon: 0.005, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(0);
  });

  it('reports a gap past it', () => {
    const prices = new Prices().set('tokA', 0.61).set('tokB', 0.6);
    const watcher = new CoherenceWatcher({ feed: prices, epsilon: 0.005, now: () => 0 });
    watcher.load([implies('implies:1', 'A', 'B')], TOKENS);

    watcher.observe(update('tokA', 0));
    expect(watcher.flush()).toHaveLength(1);
  });
});
