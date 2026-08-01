import { describe, expect, it } from 'vitest';

import { DiscordClient, DiscordError, DISCORD_LIMITS } from '../../src/alerts/discord.js';
import {
  clamp,
  fitEmbeds,
  formatDigest,
  formatViolationAlert,
  humanDuration,
  polymarketUrl,
  summariseReason,
} from '../../src/alerts/format.js';
import type { CorrectingTrade } from '../../src/coherence/trade.js';

/**
 * The transport and the formatting.
 *
 * Discord rejects an over-long message with a 400, which would mean the alerts
 * that fail to send are exactly the ones about the wordiest markets. So the
 * limits are enforced in `format.ts` and asserted here, rather than discovered
 * in production.
 */

const WEBHOOK = 'https://discord.com/api/webhooks/123/token-abc';

/**
 * A client wired to canned responses, on a fake clock that a stubbed sleep
 * advances.
 *
 * The clock has to move. The token bucket refills as a function of elapsed
 * time, so a frozen `now` plus a sleep that returns immediately spins forever
 * once the bucket's capacity is spent — which at the default 2 req/s is the
 * third request.
 */
function clientFor(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  let index = 0;
  let clock = 0;

  const client = new DiscordClient({
    webhookUrl: WEBHOOK,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    random: () => 0,
    now: () => clock,
    logger: { debug: () => {}, warn: () => {} },
    fetch: (input, init) => {
      const spec = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(spec.body === undefined ? '' : JSON.stringify(spec.body), {
          status: spec.status ?? 200,
          headers: { 'content-type': 'application/json', ...spec.headers },
        }),
      );
    },
  });

  return { client, calls, callCount: () => index };
}

describe('DiscordClient', () => {
  it('always asks for the message id', async () => {
    // Without `wait=true` Discord answers 204 with no body, and nothing can
    // ever be edited or replied to afterwards.
    const { client, calls } = clientFor([{ body: { id: '999' } }]);
    const sent = await client.send({ content: 'hi' });

    expect(calls[0]!.url).toBe(`${WEBHOOK}?wait=true`);
    expect(calls[0]!.method).toBe('POST');
    expect(sent).toEqual({ id: '999' });
  });

  it('never pings anyone', async () => {
    // Market questions are attacker-influenced — anyone can create a market —
    // so an @everyone in one must not notify the server.
    const { client, calls } = clientFor([{ body: { id: '1' } }]);
    await client.send({ content: '@everyone look' });
    expect(calls[0]!.body['allowed_mentions']).toEqual({ parse: [] });
  });

  it('edits through the messages sub-path', async () => {
    const { client, calls } = clientFor([{ body: { id: '5' } }]);
    await client.edit('5', { content: 'updated' });

    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe(`${WEBHOOK}/messages/5`);
  });

  it('honours the float retry_after from the 429 body', async () => {
    const waits: number[] = [];
    let clock = 0;
    const client = new DiscordClient({
      webhookUrl: WEBHOOK,
      random: () => 0, // no jitter, so the floor is the only input
      now: () => clock,
      logger: { debug: () => {}, warn: () => {} },
      sleep: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      fetch: (() => {
        let n = 0;
        return () => {
          n += 1;
          return Promise.resolve(
            n === 1
              ? new Response(JSON.stringify({ retry_after: 1.75, global: false }), { status: 429 })
              : new Response(JSON.stringify({ id: '7' }), { status: 200 }),
          );
        };
      })(),
    });

    await client.send({ content: 'x' });
    // 1.75s rounded up to whole ms — rounding down is how you earn a second 429.
    expect(waits).toContain(1750);
  });

  it('retries a 429 and then succeeds', async () => {
    const { client, callCount } = clientFor([
      { status: 429, body: { retry_after: 0.1 } },
      { status: 429, body: { retry_after: 0.1 } },
      { body: { id: '3' } },
    ]);
    expect(await client.send({ content: 'x' })).toEqual({ id: '3' });
    expect(callCount()).toBe(3);
  });

  it('fails fast on a revoked webhook rather than burning retries', async () => {
    const { client, callCount } = clientFor([{ status: 401, body: { message: 'Unauthorized' } }]);
    await expect(client.send({ content: 'x' })).rejects.toBeInstanceOf(DiscordError);
    expect(callCount()).toBe(1);
  });

  it('treats a deleted message as a non-error on edit', async () => {
    // Someone tidied the channel. That is not a reason to fail the run that was
    // only trying to append a lifetime.
    const { client } = clientFor([{ status: 404, body: { message: 'Unknown Message' } }]);
    expect(await client.edit('gone', { content: 'x' })).toBe(false);
  });

  it('retries 5xx', async () => {
    const { client, callCount } = clientFor([{ status: 503 }, { body: { id: '8' } }]);
    await client.send({ content: 'x' });
    expect(callCount()).toBe(2);
  });
});

describe('polymarketUrl', () => {
  it('prefers the market slug', () => {
    expect(polymarketUrl({ slug: 'will-x', eventSlug: 'ev' })).toBe(
      'https://polymarket.com/market/will-x',
    );
  });

  it('falls back to the event slug', () => {
    // A grouped market is only served under its event; a broader link beats a
    // dead one.
    expect(polymarketUrl({ slug: null, eventSlug: 'ev' })).toBe('https://polymarket.com/event/ev');
  });

  it('returns null when neither exists rather than a broken link', () => {
    expect(polymarketUrl({ slug: null, eventSlug: null })).toBeNull();
    expect(polymarketUrl({ slug: '', eventSlug: '' })).toBeNull();
  });
});

describe('humanDuration', () => {
  it.each([
    [5_000, '5s'],
    [89_000, '89s'],
    [120_000, '2.0m'],
    [3_600_000, '60.0m'],
    [7_200_000, '2.0h'],
    [86_400_000 * 3, '3.0d'],
  ])('%i ms → %s', (ms, expected) => {
    expect(humanDuration(ms)).toBe(expected);
  });
});

const bigTrade = (): CorrectingTrade => ({
  constraintKey: 'partition:1',
  kind: 'partition',
  direction: 'under',
  summary: 's',
  legs: Array.from({ length: 30 }, (_, i) => ({
    conditionId: `0x${i}`,
    tokenId: `t${i}`,
    outcomeIndex: 0 as const,
    outcome: `Outcome number ${i} with a fairly long label`,
    side: 'buy' as const,
    size: 1000,
    avgPrice: 0.1,
    notional: 100,
    fee: 1,
    cost: 101,
    touchPrice: 0.09,
    slippage: 0.1,
    levelsConsumed: 2,
    availableDepth: 5000,
  })),
  size: 1000,
  maxExecutableSize: 2000,
  guaranteedPayout: 1,
  totalPayout: 1000,
  totalNotional: 900,
  totalFees: 30,
  totalCost: 930,
  grossEdge: 0.1,
  netEdge: 0.07,
  netProfit: 70,
returnOnCost: 0.075,
});

describe('Discord limits', () => {
  it('keeps a huge partition alert inside every limit', () => {
    const message = formatViolationAlert(
      {
        violationId: 1,
        constraintKey: 'partition:1',
        kind: 'partition',
        markets: Array.from({ length: 30 }, (_, i) => ({
          conditionId: `0x${i}`,
          question: `Will candidate number ${i} win the extremely long election name 2026? `.repeat(4),
          slug: `candidate-${i}`,
          eventSlug: 'election',
          price: 0.03,
        })),
        trade: bigTrade(),
        screenMagnitude: 0.2,
        detectedAt: new Date('2026-08-01T12:00:00Z'),
      },
      'confirmed',
    );

    const embed = message.embeds![0]!;
    expect(embed.title!.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedTitle);
    expect(embed.description!.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
    expect(embed.fields!.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedFields);
    for (const field of embed.fields!) {
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedFieldValue);
    }

    const total =
      embed.title!.length +
      embed.description!.length +
      embed.footer!.text.length +
      embed.fields!.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
  });

  it('caps embeds per message', () => {
    const many = Array.from({ length: 25 }, () => ({ title: 't', description: 'd' }));
    expect(fitEmbeds(many)).toHaveLength(DISCORD_LIMITS.embedsPerMessage);
  });

  it('leaves evidence when it truncates', () => {
    expect(clamp('abcdefghij', 5)).toBe('abcd…');
    expect(clamp('abc', 10)).toBe('abc');
  });

  it('keeps a 500-entry digest inside the limits', () => {
    const message = formatDigest({
      windowStart: new Date('2026-08-01T11:00:00Z'),
      windowEnd: new Date('2026-08-01T12:00:00Z'),
      entries: Array.from({ length: 500 }, (_, i) => ({
        kind: 'partition',
        constraintKey: `partition:${i}`,
        question: `A really quite long market question number ${i} that goes on`.repeat(2),
        screenMagnitude: 0.5 - i * 0.0001,
        reason: 'net edge is -12.00¢ per unit at the minimum size — the spread and fees exceed the mispricing',
      })),
      confirmedInWindow: 2,
    });

    const embed = message.embeds![0]!;
    for (const field of embed.fields!) {
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedFieldValue);
    }
    // Grouped, not listed: 500 rows collapse to one counted reason.
    expect(embed.fields![0]!.value).toContain('500×');
  });
});

describe('summariseReason', () => {
  it('collapses per-violation prose into groupable classes', () => {
    // The numbers differ on every row; the class is what is worth counting.
    expect(summariseReason('net edge is -12.00¢ per unit at the minimum size — the spread and fees exceed the mispricing')).toBe(
      'spread and fees exceed the mispricing',
    );
    expect(summariseReason('net edge is -3.10¢ per unit at the minimum size — the spread and fees exceed the mispricing')).toBe(
      'spread and fees exceed the mispricing',
    );
    expect(summariseReason('nothing offered on 0xabc outcome 1: the leg cannot be bought at any price')).toBe(
      'a leg has nothing offered',
    );
    expect(summariseReason(null)).toBe('unknown');
  });
});
