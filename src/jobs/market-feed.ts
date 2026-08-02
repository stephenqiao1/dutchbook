import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { loadConstraints, loadScreenTokens } from '../coherence/load.js';
import { CoherenceWatcher, type Detection } from '../coherence/watch.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { MarketFeed } from '../polymarket/ws.js';

/**
 * The market feed as a running component: subscription, heartbeat,
 * reconciliation, and the event-driven screen that hangs off it.
 *
 * Four cadences, deliberately unrelated to each other:
 *
 * - **tick** (1s) — heartbeat and reconnect scheduling.
 * - **flush** (250ms) — re-screen whatever moved. This is the one the latency
 *   target lives or dies on.
 * - **reconcile** (60s) — a slice of books against fresh REST snapshots.
 * - **refresh** (15m) — rebuild the subscription from the constraint graph.
 *
 * None of them is the coherence check. The feed *triggers* a check when it sees
 * a constraint break; it never confirms one itself. Stage 2 needs live depth on
 * both legs of every market in the basket, and those are not subscribed — a
 * midpoint is enough to raise a hypothesis and never enough to price a trade.
 */

const log = createLogger('market-feed');

type Database = PostgresJsDatabase<typeof schema>;

export interface MarketFeedRunnerOptions {
  database?: Database;
  feed?: MarketFeed;
  /** Queues a coherence check. Injected so this can be tested without BullMQ. */
  trigger?: (reason: string) => Promise<unknown>;
  epsilon?: number;
  shardSize?: number;
  tickIntervalMs?: number;
  debounceMs?: number;
  reconcileIntervalMs?: number;
  reconcileBatch?: number;
  refreshIntervalMs?: number;
  triggerCooldownMs?: number;
  now?: () => number;
  /** Skip the timers, so a test can drive every phase by hand. */
  timers?: boolean;
}

export interface MarketFeedRunner {
  readonly feed: MarketFeed;
  readonly watcher: CoherenceWatcher;
  /** Rebuilds the subscription from the current constraint graph. */
  refresh(signal?: AbortSignal): Promise<{ constraints: number; tokens: number }>;
  /** One debounce step: screen what moved, trigger if anything broke. */
  flush(): Promise<Detection[]>;
  reconcile(signal?: AbortSignal): Promise<void>;
  close(): void;
}

export async function startMarketFeed(
  options: MarketFeedRunnerOptions = {},
): Promise<MarketFeedRunner> {
  const database = options.database ?? db;
  const epsilon = options.epsilon ?? config.COHERENCE_EPSILON;
  const now = options.now ?? Date.now;
  const cooldownMs = options.triggerCooldownMs ?? config.MARKET_FEED_TRIGGER_COOLDOWN_MS;
  const reconcileBatch = options.reconcileBatch ?? config.MARKET_FEED_RECONCILE_BATCH;

  const feed =
    options.feed ??
    new MarketFeed({
      shardSize: options.shardSize ?? config.MARKET_FEED_SHARD_SIZE,
      pingIntervalMs: config.MARKET_FEED_PING_INTERVAL_MS,
      staleTimeoutMs: config.MARKET_FEED_STALE_TIMEOUT_MS,
      now,
    });

  const watcher = new CoherenceWatcher({ feed, epsilon, now });

  // Attached here rather than at construction, so an injected feed is wired up
  // the same way one built here is. Wiring only the constructed case would make
  // every injected feed screen nothing at all.
  feed.addUpdateListener((update) => watcher.observe(update));

  // Negative infinity, not zero: zero reads as "triggered at the epoch", which
  // makes the cooldown a window measured from the wrong origin and swallows the
  // first detection outright on any clock that starts near zero.
  let lastTriggerAt = Number.NEGATIVE_INFINITY;
  let refreshing = false;

  const trigger = options.trigger;

  async function refresh(signal?: AbortSignal): Promise<{ constraints: number; tokens: number }> {
    if (refreshing) return { constraints: 0, tokens: 0 };
    refreshing = true;

    try {
      const { constraints, conditionIds } = await loadConstraints(database);
      const tokenOf = await loadScreenTokens(conditionIds, database);

      watcher.load(constraints, tokenOf);
      await feed.start([...new Set(tokenOf.values())], signal);

      const stats = feed.stats();
      log.info(
        {
          constraints: constraints.length,
          markets: conditionIds.length,
          tokens: stats.subscribed,
          seeded: stats.seeded,
          shards: stats.shards,
        },
        'market feed subscription rebuilt',
      );
      return { constraints: constraints.length, tokens: stats.subscribed };
    } finally {
      refreshing = false;
    }
  }

  async function flush(): Promise<Detection[]> {
    const detections = watcher.flush();
    if (detections.length === 0) return detections;

    const worst = detections.reduce((a, b) => (Math.abs(b.magnitude) > Math.abs(a.magnitude) ? b : a));
    const latencies = detections.map((d) => d.latencyMs).filter((ms): ms is number => ms !== null);

    log.info(
      {
        detections: detections.length,
        worst: { key: worst.constraintKey, magnitude: worst.magnitude, latencyMs: worst.latencyMs },
        medianLatencyMs: median(latencies),
      },
      'feed screen opened violations',
    );

    if (trigger === undefined) return detections;

    // A whole event re-pricing produces dozens of detections in one flush. They
    // all need the same thing — one two-stage check — so the burst collapses to
    // a single trigger, and the cooldown keeps a churning market from queueing a
    // check per debounce window.
    const at = now();
    if (at - lastTriggerAt < cooldownMs) return detections;
    lastTriggerAt = at;

    try {
      await trigger(`feed:${detections.length} detection(s), worst ${worst.constraintKey}`);
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not queue a feed-triggered coherence check');
    }

    return detections;
  }

  async function reconcile(signal?: AbortSignal): Promise<void> {
    try {
      const report = await feed.reconcile(reconcileBatch, signal);
      if (report.checked === 0) return;

      const level = report.contentDivergences > 0 ? 'warn' : 'debug';
      log[level](
        { ...report },
        report.contentDivergences > 0
          ? 'reconciliation found books that disagree with the venue at an identical state hash'
          : 'reconciliation pass complete',
      );
    } catch (error) {
      log.warn({ error: describeError(error) }, 'reconciliation pass failed');
    }
  }

  await refresh();

  const timers: NodeJS.Timeout[] = [];
  if (options.timers !== false) {
    const every = (ms: number, fn: () => void | Promise<void>): void => {
      const timer = setInterval(() => void fn(), ms);
      timer.unref();
      timers.push(timer);
    };

    every(options.tickIntervalMs ?? 1_000, () => feed.tick());
    every(options.debounceMs ?? config.MARKET_FEED_SCREEN_DEBOUNCE_MS, async () => {
      await flush();
    });
    every(options.reconcileIntervalMs ?? config.MARKET_FEED_RECONCILE_INTERVAL_MS, reconcile);
    every(options.refreshIntervalMs ?? config.MARKET_FEED_REFRESH_INTERVAL_MS, async () => {
      try {
        await refresh();
      } catch (error) {
        log.warn({ error: describeError(error) }, 'subscription refresh failed; keeping the current one');
      }
    });
  }

  return {
    feed,
    watcher,
    refresh,
    flush,
    reconcile,
    close() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      feed.stop();
    },
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
