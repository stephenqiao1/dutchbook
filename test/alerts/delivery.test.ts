import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sendHourlyDigest } from '../../src/alerts/digest.js';
import type { AlertTransport, DiscordMessage, SentMessage } from '../../src/alerts/discord.js';
import { alertSystem, evaluateSystem, type SystemSnapshot } from '../../src/alerts/system.js';
import {
  alertConfirmedViolations,
  alertResolvedViolations,
  type AlertableViolation,
  type ResolvedViolation,
} from '../../src/alerts/violations.js';
import type { CorrectingTrade } from '../../src/coherence/trade.js';
import * as schema from '../../src/db/schema.js';
import { alertDeliveries, events, markets, violations } from '../../src/db/schema.js';

/**
 * "Fires exactly once" — proven against a real database.
 *
 * The dedup rules are unit-tested in `dedupe.test.ts`. This file tests the thing
 * those rules exist to guarantee: that calling the alerter repeatedly, the way
 * a 60-second scheduler does, produces one message. That claim is about the
 * unique index and the claim-before-send ordering, so a fake store would prove
 * nothing about it.
 */

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const explicitUrl = process.env['TEST_DATABASE_URL'];
const canRun = explicitUrl !== undefined || dockerAvailable();

if (!canRun) {
  console.warn('\n  SKIPPED test/alerts/delivery.test.ts — needs Postgres.\n');
}

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql;
let database: Database;
let stopContainer: (() => Promise<void>) | undefined;

/** Counts every send and edit, so "exactly once" is a number. */
class RecordingTransport implements AlertTransport {
  #next = 0;
  readonly sent: DiscordMessage[] = [];
  readonly edited: Array<{ messageId: string; message: DiscordMessage }> = [];

  send(message: DiscordMessage): Promise<SentMessage | null> {
    this.sent.push(message);
    this.#next += 1;
    return Promise.resolve({ id: `msg-${this.#next}` });
  }

  edit(messageId: string, message: DiscordMessage): Promise<boolean> {
    this.edited.push({ messageId, message });
    return Promise.resolve(true);
  }

  get titles(): string[] {
    return this.sent.map((m) => m.embeds?.[0]?.title ?? '(none)');
  }
}

const OPTIONS = {
  cooldownMs: 30 * 60 * 1000,
  escalationFactor: 2,
  minNetEdge: 0.01,
  minNetProfit: 5,
};

const T0 = new Date('2026-08-01T12:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

function trade(netEdge: number, size = 500): CorrectingTrade {
  return {
    constraintKey: 'implies:1',
    kind: 'implies',
    direction: 'over',
    summary: 'buy No(A) + Yes(B)',
    legs: [
      {
        conditionId: '0xa',
        tokenId: 't1',
        outcomeIndex: 1,
        outcome: 'No',
        side: 'buy',
        size,
        avgPrice: 0.3,
        notional: size * 0.3,
        fee: 1,
        cost: size * 0.3 + 1,
        touchPrice: 0.29,
        slippage: 0.01,
        levelsConsumed: 2,
        availableDepth: size * 4,
      },
    ],
    size,
    maxExecutableSize: size * 2,
    guaranteedPayout: 1,
    totalPayout: size,
    totalNotional: size * (1 - netEdge),
    totalFees: 1,
    totalCost: size * (1 - netEdge),
    grossEdge: netEdge,
    netEdge,
    netProfit: netEdge * size,
    returnOnCost: 0.1,
  };
}

async function insertViolation(
  over: Partial<typeof violations.$inferInsert> = {},
): Promise<number> {
  const [row] = await database
    .insert(violations)
    .values({
      constraintKey: 'implies:1',
      kind: 'implies',
      relationIds: [1],
      conditionIds: ['0xa', '0xb'],
      status: 'confirmed',
      everConfirmed: true,
      detectedAt: T0,
      screenMagnitude: '0.3',
      ...over,
    })
    .returning({ id: violations.id });
  return row!.id;
}

function alertable(violationId: number, netEdge: number): AlertableViolation {
  return {
    violationId,
    constraintKey: 'implies:1',
    kind: 'implies',
    conditionIds: ['0xa', '0xb'],
    trade: trade(netEdge),
    screenMagnitude: 0.3,
    detectedAt: T0,
  };
}

beforeAll(async () => {
  if (!canRun) return;
  let url = explicitUrl;
  if (url === undefined) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    url = container.getConnectionUri();
    stopContainer = async () => {
      await container.stop();
    };
  }

  client = postgres(url, { max: 6, onnotice: () => {} });
  database = drizzle(client, { schema });

  const dir = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).toSorted()) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed !== '') await client.unsafe(trimmed);
    }
  }
}, 240_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await stopContainer?.();
});

beforeEach(async () => {
  if (!canRun) return;
  await database.execute(
    sql`truncate alert_deliveries, violations, market_quotes, markets, events restart identity cascade`,
  );
  await database.insert(events).values({ id: 'e1', slug: 'trump-approval-2026', title: 'E' });
  await database.insert(markets).values([
    {
      conditionId: '0xa',
      eventId: 'e1',
      slug: 'will-x-happen',
      question: 'Will X happen in 2026?',
      contentHash: 'h1',
    },
    {
      conditionId: '0xb',
      eventId: 'e1',
      slug: 'will-y-happen',
      question: 'Will Y happen in 2026?',
      contentHash: 'h2',
    },
  ]);
});

describe.skipIf(!canRun)('confirmed violation alerts fire exactly once', () => {
  it('sends one message across twenty consecutive checks', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    // Twenty checks, one minute apart — a real scheduler doing its job.
    for (let minute = 0; minute < 20; minute += 1) {
      await alertConfirmedViolations(
        [alertable(id, 0.1)],
        transport,
        OPTIONS,
        database,
        at(minute),
      );
    }

    expect(transport.sent).toHaveLength(1);
    expect(transport.titles[0]).toContain('Confirmed violation');

    const [row] = await database.select().from(alertDeliveries);
    expect(Number(row?.sendCount)).toBe(1);
    expect(row?.messageId).toBe('msg-1');
  });

  it('includes both questions, prices, constraint, edge, max size, and links', async () => {
    const id = await insertViolation();
    await database.insert(schema.marketQuotes).values([
      { conditionId: '0xa', yesPrice: '0.72' },
      { conditionId: '0xb', yesPrice: '0.41' },
    ]);

    const transport = new RecordingTransport();
    await alertConfirmedViolations([alertable(id, 0.1)], transport, OPTIONS, database, T0);

    const embed = transport.sent[0]!.embeds![0]!;
    const body = JSON.stringify(embed);

    expect(embed.description).toContain('Will X happen in 2026?');
    expect(embed.description).toContain('Will Y happen in 2026?');
    expect(embed.description).toContain('72.00¢');
    expect(embed.description).toContain('41.00¢');
    expect(embed.description).toContain('https://polymarket.com/market/will-x-happen');
    expect(body).toContain('P(A) ≤ P(B)');
    expect(body).toContain('10.00¢'); // net edge
    expect(body).toContain('1000 units'); // max executable
    expect(embed.title).toContain('$50.00'); // net profit
  });

  it('stays silent below the thresholds no matter how often it is seen', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    for (let minute = 0; minute < 10; minute += 1) {
      // Real edge, trivial money.
      await alertConfirmedViolations(
        [{ ...alertable(id, 0.5), trade: trade(0.5, 4) }],
        transport,
        OPTIONS,
        database,
        at(minute),
      );
    }

    expect(transport.sent).toHaveLength(0);
    expect(await database.select().from(alertDeliveries)).toHaveLength(0);
  });

  it('two replicas racing produce one message', async () => {
    const id = await insertViolation();
    const a = new RecordingTransport();
    const b = new RecordingTransport();

    // Both decide to send in the same instant; the unique index picks a winner.
    await Promise.all([
      alertConfirmedViolations([alertable(id, 0.1)], a, OPTIONS, database, T0),
      alertConfirmedViolations([alertable(id, 0.1)], b, OPTIONS, database, T0),
    ]);

    expect(a.sent.length + b.sent.length).toBe(1);
    expect(await database.select().from(alertDeliveries)).toHaveLength(1);
  });

  it('a new episode for the same constraint alerts again', async () => {
    // Keyed on the episode, not the constraint — otherwise a violation
    // recurring next week is silent forever.
    const first = await insertViolation({ resolvedAt: at(5), status: 'closed' });
    const transport = new RecordingTransport();
    await alertConfirmedViolations([alertable(first, 0.1)], transport, OPTIONS, database, T0);

    const second = await insertViolation({ detectedAt: at(600) });
    await alertConfirmedViolations([alertable(second, 0.1)], transport, OPTIONS, database, at(600));

    expect(transport.sent).toHaveLength(2);
  });
});

describe.skipIf(!canRun)('escalation', () => {
  it('sends exactly one escalation when the edge doubles', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    await alertConfirmedViolations([alertable(id, 0.1)], transport, OPTIONS, database, T0);

    // Doubled, and repeatedly observed at the doubled value.
    for (let minute = 31; minute < 50; minute += 1) {
      await alertConfirmedViolations(
        [alertable(id, 0.2)],
        transport,
        OPTIONS,
        database,
        at(minute),
      );
    }

    expect(transport.sent).toHaveLength(2);
    expect(transport.titles[1]).toContain('Escalation');

    const [row] = await database.select().from(alertDeliveries);
    expect(Number(row?.escalations)).toBe(1);
    expect(Number(row?.lastAlertValue)).toBeCloseTo(0.2, 8);
  });

  it('does not escalate inside the cooldown', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    await alertConfirmedViolations([alertable(id, 0.1)], transport, OPTIONS, database, T0);
    for (let minute = 1; minute < 30; minute += 1) {
      await alertConfirmedViolations([alertable(id, 0.5)], transport, OPTIONS, database, at(minute));
    }

    expect(transport.sent).toHaveLength(1);
  });

  it('escalates again only on a further doubling of the NEW baseline', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    await alertConfirmedViolations([alertable(id, 0.1)], transport, OPTIONS, database, T0);
    await alertConfirmedViolations([alertable(id, 0.2)], transport, OPTIONS, database, at(31));
    // 3x the original but only 1.5x the last message: silent.
    await alertConfirmedViolations([alertable(id, 0.3)], transport, OPTIONS, database, at(70));
    expect(transport.sent).toHaveLength(2);

    // 4x the original, 2x the last message: speaks.
    await alertConfirmedViolations([alertable(id, 0.4)], transport, OPTIONS, database, at(110));
    expect(transport.sent).toHaveLength(3);
  });
});

describe.skipIf(!canRun)('resolution follow-up', () => {
  const resolved = (id: number): ResolvedViolation => ({
    violationId: id,
    constraintKey: 'implies:1',
    kind: 'implies',
    detectedAt: T0,
    resolvedAt: at(45),
    peakNetEdge: 0.2,
    peakNetProfit: 100,
    everConfirmed: true,
  });

  it('follows up once, with the lifetime, replying to the original', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    await alertConfirmedViolations([alertable(id, 0.1)], transport, OPTIONS, database, T0);

    for (let i = 0; i < 10; i += 1) {
      await alertResolvedViolations([resolved(id)], transport, OPTIONS, database, at(46 + i));
    }

    expect(transport.sent).toHaveLength(2);
    expect(transport.titles[1]).toBe('Resolved after 45.0m');
    // Threaded onto the alert it closes.
    expect(transport.sent[1]!.message_reference?.message_id).toBe('msg-1');

    const [row] = await database.select().from(alertDeliveries);
    expect(row?.resolvedNotifiedAt).not.toBeNull();
  });

  it('says nothing about a violation that was never alerted', async () => {
    const id = await insertViolation();
    const transport = new RecordingTransport();

    await alertResolvedViolations([resolved(id)], transport, OPTIONS, database, at(46));

    expect(transport.sent).toHaveLength(0);
  });

  it('two replicas both noticing the resolution produce one follow-up', async () => {
    const id = await insertViolation();
    const setup = new RecordingTransport();
    await alertConfirmedViolations([alertable(id, 0.1)], setup, OPTIONS, database, T0);

    const a = new RecordingTransport();
    const b = new RecordingTransport();
    await Promise.all([
      alertResolvedViolations([resolved(id)], a, OPTIONS, database, at(46)),
      alertResolvedViolations([resolved(id)], b, OPTIONS, database, at(46)),
    ]);

    expect(a.sent.length + b.sent.length).toBe(1);
  });
});

describe.skipIf(!canRun)('hourly digest', () => {
  // Distinct keys per batch: `violations` allows only one *open* episode per
  // constraint, and reusing keys would trip that index rather than test the
  // digest.
  async function seedApparent(count: number, detectedAt: Date, prefix = 'a'): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await database.insert(violations).values({
        constraintKey: `partition:${prefix}${i}`,
        kind: 'partition',
        relationIds: [],
        conditionIds: ['0xa'],
        status: 'apparent',
        everConfirmed: false,
        detectedAt,
        screenMagnitude: String(0.5 - i * 0.01),
        reason: 'net edge is -12.00¢ per unit at the minimum size — the spread and fees exceed the mispricing',
      });
    }
  }

  it('sends one digest per hour however often the job runs', async () => {
    // The digest covers the previous complete hour.
    await seedApparent(5, new Date('2026-08-01T11:30:00Z'));
    const transport = new RecordingTransport();

    for (let minute = 0; minute < 30; minute += 1) {
      await sendHourlyDigest(transport, database, at(minute));
    }

    expect(transport.sent).toHaveLength(1);
    expect(transport.titles[0]).toContain('5 apparent');
  });

  it('groups reasons rather than listing every row', async () => {
    await seedApparent(37, new Date('2026-08-01T11:30:00Z'));
    const transport = new RecordingTransport();
    await sendHourlyDigest(transport, database, T0);

    const body = JSON.stringify(transport.sent[0]);
    expect(body).toContain('37×');
    expect(body).toContain('spread and fees exceed the mispricing');
  });

  it('sends a separate digest for the next hour', async () => {
    await seedApparent(2, new Date('2026-08-01T11:30:00Z'));
    const transport = new RecordingTransport();
    await sendHourlyDigest(transport, database, T0);

    await seedApparent(3, new Date('2026-08-01T12:30:00Z'), 'b');
    await sendHourlyDigest(transport, database, at(61));

    expect(transport.sent).toHaveLength(2);
  });

  it('stays quiet in an hour with nothing to report', async () => {
    const transport = new RecordingTransport();
    await sendHourlyDigest(transport, database, T0);
    expect(transport.sent).toHaveLength(0);
  });
});

describe.skipIf(!canRun)('system health alerts', () => {
  const snapshot = (over: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
    at: T0,
    lastIngestSuccessAt: T0,
    rateLimitHitsTotal: 0,
    coherenceQueueDepth: 0,
    gammaRecordsTotal: 0,
    gammaParseIssuesTotal: 0,
    ...over,
  });

  it('ingest staleness fires once and then holds until the cooldown', async () => {
    const transport = new RecordingTransport();

    for (let minute = 0; minute < 20; minute += 1) {
      const findings = evaluateSystem(
        snapshot({ at: at(minute), lastIngestSuccessAt: new Date(T0.getTime() - 45 * 60_000) }),
        null,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.name).toBe('ingest-stale');
      await alertSystem(findings, transport, OPTIONS, database, at(minute));
    }

    expect(transport.sent).toHaveLength(1);
    expect(transport.titles[0]).toContain('Catalog ingest silent');
  });

  it('re-sends a still-broken ingest after the cooldown, since it will not self-resolve', async () => {
    const transport = new RecordingTransport();
    const stale = (minute: number) =>
      evaluateSystem(
        snapshot({ at: at(minute), lastIngestSuccessAt: new Date(T0.getTime() - 45 * 60_000) }),
        null,
      );

    await alertSystem(stale(0), transport, OPTIONS, database, T0);
    await alertSystem(stale(31), transport, OPTIONS, database, at(31));

    expect(transport.sent).toHaveLength(2);
  });

  it('does not fire while the ingest is healthy', async () => {
    const findings = evaluateSystem(
      snapshot({ lastIngestSuccessAt: new Date(T0.getTime() - 5 * 60_000) }),
      null,
    );
    expect(findings).toHaveLength(0);
  });

  it('rate-limit spike fires once across repeated observation', async () => {
    const transport = new RecordingTransport();
    const previous = {
      at: T0,
      rateLimitHitsTotal: 0,
      coherenceQueueDepth: 0,
      gammaRecordsTotal: 0,
      gammaParseIssuesTotal: 0,
    };

    for (let minute = 1; minute < 15; minute += 1) {
      // 500 hits in one minute — far past 50 per ten minutes.
      const findings = evaluateSystem(
        snapshot({ at: at(minute), rateLimitHitsTotal: 500 * minute }),
        previous,
      );
      expect(findings.some((f) => f.name === 'rate-limit-spike')).toBe(true);
      await alertSystem(findings, transport, OPTIONS, database, at(minute));
    }

    expect(transport.sent).toHaveLength(1);
  });

  it('queue depth alerts only when deep AND growing', async () => {
    const base = {
      at: T0,
      rateLimitHitsTotal: 0,
      coherenceQueueDepth: 8,
      gammaRecordsTotal: 0,
      gammaParseIssuesTotal: 0,
    };

    // Deep but draining — the system absorbing a burst, which is it working.
    expect(
      evaluateSystem(snapshot({ at: at(1), coherenceQueueDepth: 6 }), base).some(
        (f) => f.name === 'queue-depth-growing',
      ),
    ).toBe(false);

    // Growing but shallow — noise.
    expect(
      evaluateSystem(snapshot({ at: at(1), coherenceQueueDepth: 2 }), { ...base, coherenceQueueDepth: 1 }).some(
        (f) => f.name === 'queue-depth-growing',
      ),
    ).toBe(false);

    // Deep and growing — work arriving faster than it completes.
    const findings = evaluateSystem(snapshot({ at: at(1), coherenceQueueDepth: 12 }), base);
    expect(findings.some((f) => f.name === 'queue-depth-growing')).toBe(true);

    const transport = new RecordingTransport();
    for (let i = 0; i < 8; i += 1) {
      await alertSystem(findings, transport, OPTIONS, database, at(1 + i));
    }
    expect(transport.sent).toHaveLength(1);
  });

  it('parse-failure spike fires once — the vendor-changed-schema alarm', async () => {
    const transport = new RecordingTransport();
    const previous = {
      at: T0,
      rateLimitHitsTotal: 0,
      coherenceQueueDepth: 0,
      gammaRecordsTotal: 0,
      gammaParseIssuesTotal: 0,
    };

    // 1000 records, 300 of them with a nulled field: 30% against a 5% floor.
    const findings = evaluateSystem(
      snapshot({ at: at(5), gammaRecordsTotal: 1000, gammaParseIssuesTotal: 300 }),
      previous,
    );
    expect(findings.some((f) => f.name === 'gamma-parse-failures')).toBe(true);

    for (let i = 0; i < 10; i += 1) {
      await alertSystem(findings, transport, OPTIONS, database, at(5 + i));
    }
    expect(transport.sent).toHaveLength(1);
    expect(transport.titles[0]).toContain('30.0%');
  });

  it('ignores a parse-failure rate computed from too small a sample', async () => {
    // 3 of 10 records is 30%, but ten records says nothing about the schema.
    const findings = evaluateSystem(
      snapshot({ at: at(5), gammaRecordsTotal: 10, gammaParseIssuesTotal: 3 }),
      {
        at: T0,
        rateLimitHitsTotal: 0,
        coherenceQueueDepth: 0,
        gammaRecordsTotal: 0,
        gammaParseIssuesTotal: 0,
      },
    );
    expect(findings.some((f) => f.name === 'gamma-parse-failures')).toBe(false);
  });

  it('says nothing at all on the first run, before there is a baseline', async () => {
    // Counters are cumulative: a fresh process has seen zero rate-limit hits
    // because it just started, not because everything is fine.
    const findings = evaluateSystem(
      snapshot({ rateLimitHitsTotal: 999_999, coherenceQueueDepth: 99 }),
      null,
    );
    expect(findings).toHaveLength(0);
  });

  it('each signal dedupes independently', async () => {
    const transport = new RecordingTransport();
    const previous = {
      at: T0,
      rateLimitHitsTotal: 0,
      coherenceQueueDepth: 1,
      gammaRecordsTotal: 0,
      gammaParseIssuesTotal: 0,
    };

    const findings = evaluateSystem(
      snapshot({
        at: at(1),
        lastIngestSuccessAt: new Date(T0.getTime() - 45 * 60_000),
        rateLimitHitsTotal: 5000,
        coherenceQueueDepth: 20,
        gammaRecordsTotal: 1000,
        gammaParseIssuesTotal: 400,
      }),
      previous,
    );
    expect(findings).toHaveLength(4);

    for (let i = 0; i < 5; i += 1) {
      await alertSystem(findings, transport, OPTIONS, database, at(1 + i));
    }

    // Four distinct signals, one message each.
    expect(transport.sent).toHaveLength(4);
    expect(await database.select().from(alertDeliveries)).toHaveLength(4);
  });
});
