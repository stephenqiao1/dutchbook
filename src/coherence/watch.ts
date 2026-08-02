import { createLogger } from '../logger.js';
import { detectionLatency } from '../metrics.js';
import type { BookUpdate } from '../polymarket/ws.js';
import { evaluate, DEFAULT_SCREEN_EPSILON, type Constraint, type Direction } from './constraints.js';

/**
 * Event-driven stage 1.
 *
 * Feeding live prices into a check that runs every sixty seconds does not make
 * detection fast. A poll finds a violation an average of half its interval after
 * it opens, so a sixty-second schedule has a thirty-second median no matter how
 * fresh the prices are — the freshness of the data and the latency of noticing
 * are different quantities, and only the second one is what a trader loses to.
 *
 * So the feed drives the screen instead. A book update marks the constraints
 * that market participates in as dirty; a short debounce later, only those are
 * re-evaluated. Sixty thousand constraints do not need re-screening because one
 * token moved, and the ones that do are known exactly.
 *
 * The scheduled check stays, unchanged, as the floor. It re-screens everything
 * against cached quotes, so a market whose book never seeds — or whose shard is
 * disconnected — is still covered, just at the old speed. Replacing the poll
 * rather than backing it up would turn any feed outage into silent blindness.
 */

const log = createLogger('coherence:watch');

/** The slice of {@link MarketFeed} the watcher needs. */
export interface PriceSource {
  mid(tokenId: string): number | null;
}

/** A constraint that just crossed from satisfied to violated. */
export interface Detection {
  readonly constraintKey: string;
  readonly kind: Constraint['kind'];
  readonly magnitude: number;
  readonly direction: Direction;
  /** Venue timestamp of the most recent change among the constraint's members. */
  readonly at: Date | null;
  /** Venue timestamp to detection. Null when the venue sent no timestamp. */
  readonly latencyMs: number | null;
}

export interface WatcherOptions {
  readonly feed: PriceSource;
  readonly epsilon?: number;
  readonly now?: () => number;
}

export interface WatcherStats {
  readonly constraints: number;
  readonly tokens: number;
  readonly dirty: number;
  readonly violating: number;
  /** Flushed constraints where at least one member had no live book. */
  readonly unscreenable: number;
  readonly detections: number;
  readonly resolutions: number;
}

export class CoherenceWatcher {
  readonly #feed: PriceSource;
  readonly #epsilon: number;
  readonly #now: () => number;

  readonly #constraints = new Map<string, Constraint>();
  /** tokenId → the constraints that token can move. The whole point of the index. */
  readonly #byToken = new Map<string, string[]>();
  /** conditionId → the token whose midpoint prices it. Outcome 0, as stage 1 uses. */
  readonly #tokenOf = new Map<string, string>();

  readonly #dirty = new Set<string>();
  readonly #violating = new Set<string>();
  /** tokenId → venue time of its latest update, for the latency measurement. */
  readonly #lastChange = new Map<string, number>();

  #unscreenable = 0;
  #detections = 0;
  #resolutions = 0;

  constructor(options: WatcherOptions) {
    this.#feed = options.feed;
    this.#epsilon = options.epsilon ?? DEFAULT_SCREEN_EPSILON;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Installs the constraint set and the market→token mapping.
   *
   * Replaces wholesale rather than merging: constraints come and go as markets
   * close, and a stale index would keep screening a relation that no longer
   * exists. The violating set is intersected rather than cleared, so a violation
   * that is still open across a reload is not re-detected and re-reported as new.
   */
  load(constraints: readonly Constraint[], tokenOf: ReadonlyMap<string, string>): void {
    this.#constraints.clear();
    this.#byToken.clear();
    this.#tokenOf.clear();

    for (const [conditionId, tokenId] of tokenOf) this.#tokenOf.set(conditionId, tokenId);

    for (const constraint of constraints) {
      this.#constraints.set(constraint.key, constraint);
      for (const member of constraint.members) {
        const tokenId = this.#tokenOf.get(member.conditionId);
        if (tokenId === undefined) continue;
        const keys = this.#byToken.get(tokenId);
        if (keys === undefined) this.#byToken.set(tokenId, [constraint.key]);
        else if (!keys.includes(constraint.key)) keys.push(constraint.key);
      }
    }

    for (const key of this.#violating) {
      if (!this.#constraints.has(key)) this.#violating.delete(key);
    }

    log.info(
      { constraints: this.#constraints.size, tokens: this.#byToken.size, stillViolating: this.#violating.size },
      'watcher index rebuilt',
    );
  }

  /** Wire this to the feed's `onUpdate`. Cheap by design — it only marks. */
  observe(update: BookUpdate): void {
    const keys = this.#byToken.get(update.tokenId);
    if (keys === undefined) return;

    this.#lastChange.set(update.tokenId, update.at?.getTime() ?? update.receivedAt);
    for (const key of keys) this.#dirty.add(key);
  }

  /**
   * Re-evaluates everything marked dirty and reports the new violations.
   *
   * Only *transitions* are reported. A violation that stays open across a
   * hundred book updates is one detection, not a hundred — the same distinction
   * the alerting layer draws, and for the same reason.
   */
  flush(): Detection[] {
    if (this.#dirty.size === 0) return [];

    const keys = [...this.#dirty];
    this.#dirty.clear();

    const now = this.#now();
    const detections: Detection[] = [];

    for (const key of keys) {
      const constraint = this.#constraints.get(key);
      if (constraint === undefined) continue;

      const priced = this.#price(constraint);
      const result = evaluate(priced, this.#epsilon);

      if (result.unscreenable) {
        // A member with no live book. The scheduled check still covers it from
        // the cached quote; here it is simply not a determination.
        this.#unscreenable += 1;
        continue;
      }

      if (!result.violated) {
        if (this.#violating.delete(key)) this.#resolutions += 1;
        continue;
      }

      if (this.#violating.has(key)) continue;
      this.#violating.add(key);
      this.#detections += 1;

      const at = this.#latestChange(constraint);
      const latencyMs = at === null ? null : Math.max(0, now - at);
      if (latencyMs !== null) detectionLatency.observe(latencyMs / 1_000);

      detections.push({
        constraintKey: key,
        kind: constraint.kind,
        magnitude: result.magnitude,
        direction: result.direction ?? 'over',
        at: at === null ? null : new Date(at),
        latencyMs,
      });
    }

    return detections;
  }

  stats(): WatcherStats {
    return {
      constraints: this.#constraints.size,
      tokens: this.#byToken.size,
      dirty: this.#dirty.size,
      violating: this.#violating.size,
      unscreenable: this.#unscreenable,
      detections: this.#detections,
      resolutions: this.#resolutions,
    };
  }

  /** Attaches live midpoints to a constraint's members. */
  #price(constraint: Constraint): Constraint {
    return {
      ...constraint,
      members: constraint.members.map((member) => {
        const tokenId = this.#tokenOf.get(member.conditionId);
        return {
          conditionId: member.conditionId,
          price: tokenId === undefined ? null : this.#feed.mid(tokenId),
        };
      }),
    };
  }

  /**
   * The venue timestamp of the most recent change among the members.
   *
   * The latest, not the earliest: a constraint becomes violated at the moment
   * its *last* input moves. Measuring from the earliest would charge this
   * detection for however long the other leg happened to sit still, which
   * inflates the number with time nothing was wrong.
   */
  #latestChange(constraint: Constraint): number | null {
    let latest: number | null = null;
    for (const member of constraint.members) {
      const tokenId = this.#tokenOf.get(member.conditionId);
      if (tokenId === undefined) continue;
      const at = this.#lastChange.get(tokenId);
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }
}
