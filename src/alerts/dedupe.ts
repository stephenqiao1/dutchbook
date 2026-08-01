/**
 * When to send, when to stay quiet.
 *
 * This is the module the whole feature turns on. An alerter without it is a
 * loop that posts the same violation to Discord every sixty seconds until
 * someone mutes the channel, at which point it has negative value — it is worse
 * than no alerting, because it also trains people to ignore the one message
 * that mattered.
 *
 * Pure and total: state in, decision out. No clock (the caller passes `now`),
 * no I/O, no throwing. Every rule below is therefore testable without a
 * database, a webhook, or a wall-clock wait.
 */

export type AlertDecision = 'send' | 'escalate' | 'resolve' | 'suppress';

/** What has already been sent for one alert key. */
export interface DeliveryState {
  readonly lastSentAt: Date;
  /** Net edge (or other scalar) quoted by the most recent message. */
  readonly lastAlertValue: number | null;
  readonly resolvedNotifiedAt: Date | null;
  readonly messageId: string | null;
  readonly sendCount: number;
}

export interface DedupeOptions {
  /**
   * Minimum gap between two messages about the same key.
   *
   * Gates escalations as well as repeats. Without that an opportunity
   * oscillating either side of the 2x line would alert on every check, which is
   * precisely the failure mode the cooldown exists to prevent.
   */
  readonly cooldownMs: number;
  /**
   * Growth factor that justifies breaking silence. 2 means "twice as good as
   * when we last said something".
   */
  readonly escalationFactor: number;
}

export interface DedupeInput {
  /** Null when nothing has ever been sent for this key. */
  readonly state: DeliveryState | null;
  /** Current scalar being alerted on. Null for signals with no magnitude. */
  readonly value: number | null;
  /** True when the underlying condition has ended and wants a follow-up. */
  readonly resolved: boolean;
  readonly now: Date;
}

/**
 * The rule set, in priority order.
 *
 * 1. **Resolution wins over everything.** A violation that ended must get its
 *    follow-up even if the cooldown is still running — the cooldown exists to
 *    limit noise about an ongoing thing, and "it is over" is the message people
 *    are actually waiting for. Guarded by `resolvedNotifiedAt` so it happens
 *    exactly once.
 * 2. **Never seen before → send.**
 * 3. **Inside the cooldown → silence, always.** Including escalations. See
 *    {@link DedupeOptions.cooldownMs}.
 * 4. **Outside the cooldown → still silence, unless it got materially worse.**
 *    This is the difference between "one alert per violation" and "one alert
 *    per cooldown window". A violation that persists unchanged for six hours
 *    produces exactly one message, not seventy-two.
 */
export function decide(input: DedupeInput, options: DedupeOptions): AlertDecision {
  const { state, value, resolved, now } = input;

  if (state === null) {
    // Nothing was ever sent, so there is nothing to follow up on. A violation
    // that opened and closed between two checks is simply never mentioned,
    // which is right: nobody could have traded it.
    return resolved ? 'suppress' : 'send';
  }

  if (resolved) {
    return state.resolvedNotifiedAt === null ? 'resolve' : 'suppress';
  }

  // A key that has already been resolved and then fires again is a bug in the
  // caller's keying, not something to paper over here — but staying quiet is
  // the safe response.
  if (state.resolvedNotifiedAt !== null) return 'suppress';

  const elapsed = now.getTime() - state.lastSentAt.getTime();
  if (elapsed < options.cooldownMs) return 'suppress';

  if (value === null || state.lastAlertValue === null || state.lastAlertValue <= 0) {
    // No magnitude to compare. Signals like "the ingest is stale" have no
    // value, and for them an elapsed cooldown *is* the reason to speak again:
    // the condition is still true and still needs attention.
    return value === null && state.lastAlertValue === null ? 'send' : 'suppress';
  }

  return value >= state.lastAlertValue * options.escalationFactor ? 'escalate' : 'suppress';
}

/**
 * Whether a violation is worth announcing at all.
 *
 * Applied before {@link decide}, because the cheapest alert is the one never
 * considered. Both floors must clear: a huge per-unit edge on four shares is
 * not worth a notification, and neither is a large notional built from an edge
 * too thin to survive the next tick.
 */
export function meetsThreshold(
  netEdge: number | null,
  netProfit: number | null,
  floors: { readonly minNetEdge: number; readonly minNetProfit: number },
): boolean {
  if (netEdge === null || netProfit === null) return false;
  if (!Number.isFinite(netEdge) || !Number.isFinite(netProfit)) return false;
  return netEdge >= floors.minNetEdge && netProfit >= floors.minNetProfit;
}
