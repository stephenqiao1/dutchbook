import { describe, expect, it } from 'vitest';

import { decide, meetsThreshold, type DeliveryState } from '../../src/alerts/dedupe.js';

/**
 * The rules, at their boundaries.
 *
 * These are unit tests of a pure function, which is the point: every "does it
 * fire twice?" question below would otherwise need a database, a webhook, and a
 * thirty-minute wall-clock wait to answer once.
 */

const OPTIONS = { cooldownMs: 30 * 60 * 1000, escalationFactor: 2 };

const T0 = new Date('2026-08-01T12:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const state = (over: Partial<DeliveryState> = {}): DeliveryState => ({
  lastSentAt: T0,
  lastAlertValue: 0.1,
  resolvedNotifiedAt: null,
  messageId: 'msg-1',
  sendCount: 1,
  ...over,
});

describe('first sighting', () => {
  it('sends when nothing has been sent before', () => {
    expect(decide({ state: null, value: 0.1, resolved: false, now: T0 }, OPTIONS)).toBe('send');
  });

  it('says nothing about a violation that opened and closed unseen', () => {
    // Nobody could have traded it, so announcing its death is pure noise.
    expect(decide({ state: null, value: null, resolved: true, now: T0 }, OPTIONS)).toBe('suppress');
  });
});

describe('one alert per violation, not one per check cycle', () => {
  it('suppresses an unchanged violation seen again immediately', () => {
    expect(decide({ state: state(), value: 0.1, resolved: false, now: at(1) }, OPTIONS)).toBe(
      'suppress',
    );
  });

  it('STILL suppresses long after the cooldown when nothing changed', () => {
    // The difference between "one alert per violation" and "one per cooldown
    // window". A violation persisting unchanged for six hours is one message.
    for (const minutes of [31, 60, 180, 360, 1440]) {
      expect(
        decide({ state: state(), value: 0.1, resolved: false, now: at(minutes) }, OPTIONS),
        `${minutes}m`,
      ).toBe('suppress');
    }
  });

  it('suppresses even when the edge shrank', () => {
    expect(decide({ state: state(), value: 0.02, resolved: false, now: at(60) }, OPTIONS)).toBe(
      'suppress',
    );
  });
});

describe('escalation', () => {
  it('fires when the edge doubles after the cooldown', () => {
    expect(decide({ state: state(), value: 0.2, resolved: false, now: at(31) }, OPTIONS)).toBe(
      'escalate',
    );
  });

  it('does NOT fire on doubling inside the cooldown', () => {
    // Otherwise an opportunity oscillating across the 2x line alerts on every
    // check, which is the exact noise the cooldown exists to prevent.
    expect(decide({ state: state(), value: 0.2, resolved: false, now: at(29) }, OPTIONS)).toBe(
      'suppress',
    );
  });

  it('needs the full factor, not merely growth', () => {
    expect(decide({ state: state(), value: 0.19, resolved: false, now: at(60) }, OPTIONS)).toBe(
      'suppress',
    );
    expect(decide({ state: state(), value: 0.2, resolved: false, now: at(60) }, OPTIONS)).toBe(
      'escalate',
    );
  });

  it('compares against the LAST alert, not the first', () => {
    // 0.1 → alert. 0.19 → silent. 0.2 → escalate, and the store moves
    // lastAlertValue to 0.2. From there 0.3 must stay silent even though it is
    // 3x the original, because it is only 1.5x what was last said.
    const afterEscalation = state({ lastAlertValue: 0.2, lastSentAt: at(31), sendCount: 2 });
    expect(
      decide({ state: afterEscalation, value: 0.3, resolved: false, now: at(90) }, OPTIONS),
    ).toBe('suppress');
    expect(
      decide({ state: afterEscalation, value: 0.4, resolved: false, now: at(90) }, OPTIONS),
    ).toBe('escalate');
  });

  it('does not escalate from a zero or missing baseline', () => {
    // Any positive value is infinitely more than zero; that is not information.
    expect(
      decide({ state: state({ lastAlertValue: 0 }), value: 0.5, resolved: false, now: at(60) }, OPTIONS),
    ).toBe('suppress');
    expect(
      decide({ state: state({ lastAlertValue: null }), value: 0.5, resolved: false, now: at(60) }, OPTIONS),
    ).toBe('suppress');
  });
});

describe('resolution', () => {
  it('fires once, even inside the cooldown', () => {
    // "It is over" is the message people are waiting for; the cooldown limits
    // noise about an ongoing thing.
    expect(decide({ state: state(), value: null, resolved: true, now: at(1) }, OPTIONS)).toBe(
      'resolve',
    );
  });

  it('never fires twice', () => {
    const notified = state({ resolvedNotifiedAt: at(5) });
    for (const minutes of [6, 30, 120]) {
      expect(
        decide({ state: notified, value: null, resolved: true, now: at(minutes) }, OPTIONS),
      ).toBe('suppress');
    }
  });

  it('stays quiet if the same key somehow fires again after resolving', () => {
    const notified = state({ resolvedNotifiedAt: at(5) });
    expect(decide({ state: notified, value: 0.9, resolved: false, now: at(90) }, OPTIONS)).toBe(
      'suppress',
    );
  });
});

describe('signals with no magnitude', () => {
  // Health alerts. Unlike a market violation these do not resolve themselves,
  // so an elapsed cooldown IS the reason to speak again.
  const health = state({ lastAlertValue: null });

  it('re-sends once the cooldown has elapsed', () => {
    expect(decide({ state: health, value: null, resolved: false, now: at(31) }, OPTIONS)).toBe(
      'send',
    );
  });

  it('stays quiet inside the cooldown', () => {
    expect(decide({ state: health, value: null, resolved: false, now: at(29) }, OPTIONS)).toBe(
      'suppress',
    );
  });
});

describe('meetsThreshold', () => {
  const floors = { minNetEdge: 0.01, minNetProfit: 5 };

  it('requires both floors', () => {
    expect(meetsThreshold(0.05, 50, floors)).toBe(true);
    // A huge per-unit edge on four shares.
    expect(meetsThreshold(0.5, 2, floors)).toBe(false);
    // A large notional built from an edge too thin to survive the next tick.
    expect(meetsThreshold(0.001, 500, floors)).toBe(false);
  });

  it('is inclusive at the boundary', () => {
    expect(meetsThreshold(0.01, 5, floors)).toBe(true);
  });

  it('rejects missing or non-finite values', () => {
    expect(meetsThreshold(null, 50, floors)).toBe(false);
    expect(meetsThreshold(0.05, null, floors)).toBe(false);
    expect(meetsThreshold(Number.NaN, 50, floors)).toBe(false);
    expect(meetsThreshold(Number.POSITIVE_INFINITY, Number.NaN, floors)).toBe(false);
  });
});
