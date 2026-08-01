/**
 * Deliberately fires every alert path and asserts no duplicates.
 *
 * `pnpm alerts:drill [--webhook=<url>]`
 *
 * The acceptance criterion for this feature is "every alert path triggered, no
 * duplicates confirmed". A unit test proves the rules; this proves the wiring —
 * real database, real dedup, and a real Discord webhook when one is supplied.
 *
 * Everything it creates is namespaced with a run id and deleted afterwards, so
 * it can be run against a live database without leaving violations or delivery
 * rows that the checker or the digest would later trip over.
 */
import { createServer, type Server } from 'node:http';

import { sql } from 'drizzle-orm';

import { hourBucket, sendHourlyDigest } from '../src/alerts/digest.js';
import { DiscordClient, type AlertTransport, type DiscordMessage, type SentMessage } from '../src/alerts/discord.js';
import { alertSystem, evaluateSystem, type SystemSnapshot } from '../src/alerts/system.js';
import {
  alertConfirmedViolations,
  alertResolvedViolations,
  type AlertableViolation,
} from '../src/alerts/violations.js';
import type { CorrectingTrade } from '../src/coherence/trade.js';
import { closeDatabase, db } from '../src/db/client.js';
import { events, markets, violations } from '../src/db/schema.js';

const webhook =
  process.argv.find((a) => a.startsWith('--webhook='))?.split('=')[1] ??
  process.env['DISCORD_WEBHOOK_URL'];

/**
 * A local stand-in for Discord, used when no real webhook is supplied.
 *
 * It speaks enough of the protocol to exercise the *real* `DiscordClient` over
 * *real* HTTP — `?wait=true` returning a message id, `PATCH .../messages/{id}`,
 * and a 429 with a float `retry_after` on the first request so the backoff path
 * runs too. Without this the drill would only ever prove the dedup logic, and
 * the transport — serialization, headers, retry, id extraction — would be
 * exercised for the first time in production.
 */
interface MockDiscord {
  readonly url: string;
  readonly received: Array<{ method: string; path: string; body: unknown }>;
  close(): Promise<void>;
}

async function startMockDiscord(): Promise<MockDiscord> {
  const received: Array<{ method: string; path: string; body: unknown }> = [];
  let nextId = 1;
  let throttledOnce = false;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }

      // Throttle once, so the retry-and-backoff path is genuinely taken.
      if (!throttledOnce) {
        throttledOnce = true;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }));
        return;
      }

      received.push({ method: req.method ?? '?', path: req.url ?? '/', body });
      nextId += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: String(nextId), channel_id: '1', content: '' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/webhooks/123/token`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const RUN = `drill-${Date.now()}`;
const T0 = new Date();
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const OPTIONS = { cooldownMs: 30 * 60 * 1000, escalationFactor: 2, minNetEdge: 0.01, minNetProfit: 5 };

/** Wraps the real transport so every send is counted as well as delivered. */
class CountingTransport implements AlertTransport {
  readonly sent: DiscordMessage[] = [];
  constructor(private readonly inner: AlertTransport) {}

  async send(message: DiscordMessage): Promise<SentMessage | null> {
    this.sent.push(message);
    return this.inner.send(message);
  }
  async edit(messageId: string, message: DiscordMessage): Promise<boolean> {
    return this.inner.edit(messageId, message);
  }
  get titles(): string[] {
    return this.sent.map((m) => m.embeds?.[0]?.title ?? '(none)');
  }
}

function trade(netEdge: number, size = 500): CorrectingTrade {
  return {
    constraintKey: `${RUN}:implies`,
    kind: 'implies',
    direction: 'over',
    summary: 'buy No(A) + Yes(B)',
    legs: [
      {
        conditionId: `${RUN}-a`, tokenId: 't1', outcomeIndex: 1, outcome: 'No', side: 'buy',
        size, avgPrice: 0.62, notional: size * 0.62, fee: 4.2, cost: size * 0.62 + 4.2,
        touchPrice: 0.6, slippage: 0.033, levelsConsumed: 3, availableDepth: size * 3,
      },
      {
        conditionId: `${RUN}-b`, tokenId: 't2', outcomeIndex: 0, outcome: 'Yes', side: 'buy',
        size, avgPrice: 0.28, notional: size * 0.28, fee: 3.1, cost: size * 0.28 + 3.1,
        touchPrice: 0.27, slippage: 0.037, levelsConsumed: 2, availableDepth: size * 5,
      },
    ],
    size,
    maxExecutableSize: size * 2,
    guaranteedPayout: 1,
    totalPayout: size,
    totalNotional: size * (1 - netEdge) - 7.3,
    totalFees: 7.3,
    totalCost: size * (1 - netEdge),
    grossEdge: netEdge + 0.015,
    netEdge,
    netProfit: netEdge * size,
    returnOnCost: netEdge / (1 - netEdge),
  };
}

const results: Array<{ path: string; expected: number; actual: number }> = [];
function check(path: string, expected: number, actual: number): void {
  results.push({ path, expected, actual });
  const ok = expected === actual;
  console.log(`  ${ok ? '✓' : '✗'} ${path.padEnd(46)} expected ${expected}, sent ${actual}`);
}

async function main(): Promise<number> {
  const useReal = webhook !== undefined && webhook !== '';
  const mock = useReal ? null : await startMockDiscord();

  const transport = new CountingTransport(
    new DiscordClient({ webhookUrl: useReal ? webhook : mock!.url }),
  );

  console.log(
    `\n  alert drill ${RUN}\n  transport: ${
      useReal ? 'REAL Discord webhook' : `real DiscordClient over HTTP → local mock at ${mock!.url}`
    }\n`,
  );

  // --- fixtures ------------------------------------------------------------
  await db.insert(events).values({ id: RUN, slug: `${RUN}-event`, title: 'Alert drill' }).onConflictDoNothing();
  await db.insert(markets).values([
    {
      conditionId: `${RUN}-a`, eventId: RUN, slug: 'will-trump-approval-hit-35-2026',
      question: "Will Trump's approval rating hit 35% in 2026?", contentHash: `${RUN}-a`,
    },
    {
      conditionId: `${RUN}-b`, eventId: RUN, slug: 'will-trump-approval-hit-30-2026',
      question: "Will Trump's approval rating hit 30% in 2026?", contentHash: `${RUN}-b`,
    },
  ]).onConflictDoNothing();
  await db.execute(sql`
    insert into market_quotes (condition_id, yes_price) values
      (${`${RUN}-a`}, 0.72), (${`${RUN}-b`}, 0.41)
    on conflict (condition_id) do update set yes_price = excluded.yes_price
  `);

  const [confirmedRow] = await db.insert(violations).values({
    constraintKey: `${RUN}:implies`, kind: 'implies', relationIds: [1],
    conditionIds: [`${RUN}-a`, `${RUN}-b`], status: 'confirmed', everConfirmed: true,
    detectedAt: T0, screenMagnitude: '0.31',
  }).returning({ id: violations.id });
  const violationId = confirmedRow!.id;

  const alertable = (netEdge: number): AlertableViolation => ({
    violationId,
    constraintKey: `${RUN}:implies`,
    kind: 'implies',
    conditionIds: [`${RUN}-a`, `${RUN}-b`],
    trade: trade(netEdge),
    screenMagnitude: 0.31,
    detectedAt: T0,
  });

  // --- 1. confirmed violation, seen 20 times -------------------------------
  let before = transport.sent.length;
  for (let m = 0; m < 20; m += 1) {
    await alertConfirmedViolations([alertable(0.1)], transport, OPTIONS, db, at(m));
  }
  check('confirmed violation × 20 checks', 1, transport.sent.length - before);

  // --- 2. below threshold, seen 10 times -----------------------------------
  const [smallRow] = await db.insert(violations).values({
    constraintKey: `${RUN}:small`, kind: 'implies', relationIds: [2],
    conditionIds: [`${RUN}-a`, `${RUN}-b`], status: 'confirmed', everConfirmed: true,
    detectedAt: T0, screenMagnitude: '0.02',
  }).returning({ id: violations.id });

  before = transport.sent.length;
  for (let m = 0; m < 10; m += 1) {
    await alertConfirmedViolations(
      [{ ...alertable(0.5), violationId: smallRow!.id, constraintKey: `${RUN}:small`, trade: trade(0.5, 4) }],
      transport, OPTIONS, db, at(m),
    );
  }
  check('below threshold × 10 checks', 0, transport.sent.length - before);

  // --- 3. escalation: doubled, then observed repeatedly --------------------
  before = transport.sent.length;
  for (let m = 31; m < 50; m += 1) {
    await alertConfirmedViolations([alertable(0.2)], transport, OPTIONS, db, at(m));
  }
  check('escalation (2× edge) × 19 checks', 1, transport.sent.length - before);

  // --- 4. sub-2x growth after the escalation -------------------------------
  before = transport.sent.length;
  for (let m = 61; m < 70; m += 1) {
    await alertConfirmedViolations([alertable(0.3)], transport, OPTIONS, db, at(m));
  }
  check('1.5× growth after escalation × 9', 0, transport.sent.length - before);

  // --- 5. resolution, seen 10 times ----------------------------------------
  const resolvedAt = at(75);
  await db.update(violations).set({ resolvedAt, status: 'closed' }).where(sql`id = ${violationId}`);

  before = transport.sent.length;
  for (let m = 76; m < 86; m += 1) {
    await alertResolvedViolations(
      [{
        violationId, constraintKey: `${RUN}:implies`, kind: 'implies',
        detectedAt: T0, resolvedAt, peakNetEdge: 0.2, peakNetProfit: 100, everConfirmed: true,
      }],
      transport, OPTIONS, db, at(m),
    );
  }
  check('resolution follow-up × 10 checks', 1, transport.sent.length - before);

  // --- 6. every system signal, each seen 8 times ---------------------------
  const snapshot: SystemSnapshot = {
    at: at(90),
    lastIngestSuccessAt: new Date(T0.getTime() - 45 * 60_000),
    rateLimitHitsTotal: 5000,
    coherenceQueueDepth: 20,
    gammaRecordsTotal: 1000,
    gammaParseIssuesTotal: 400,
  };
  const previous = {
    at: at(89), rateLimitHitsTotal: 0, coherenceQueueDepth: 1,
    gammaRecordsTotal: 0, gammaParseIssuesTotal: 0,
  };
  const findings = evaluateSystem(snapshot, previous);
  console.log(`\n  system signals detected: ${findings.map((f) => f.name).join(', ')}\n`);

  before = transport.sent.length;
  for (let i = 0; i < 8; i += 1) {
    await alertSystem(findings, transport, OPTIONS, db, at(90 + i));
  }
  check('4 system signals × 8 checks', 4, transport.sent.length - before);

  // --- 7. hourly digest, called 30 times inside one hour -------------------
  //
  // Seeded relative to the digest's actual window, not to "30 minutes ago":
  // the digest covers the previous *complete* hour, so a fixed offset only
  // lands inside it when the drill happens to start in the first half of an
  // hour. That made this check pass or fail depending on the wall clock.
  const windowStart = new Date(hourBucket(T0).getTime() - 60 * 60_000);
  const lastHour = new Date(windowStart.getTime() + 30 * 60_000);
  for (let i = 0; i < 6; i += 1) {
    await db.insert(violations).values({
      constraintKey: `${RUN}:apparent-${i}`, kind: 'partition', relationIds: [],
      conditionIds: [`${RUN}-a`], status: 'apparent', everConfirmed: false,
      detectedAt: lastHour, screenMagnitude: String(0.4 - i * 0.01),
      reason: 'net edge is -12.00¢ per unit at the minimum size — the spread and fees exceed the mispricing',
    }).onConflictDoNothing();
  }

  // The digest key is the hour bucket, not the run id, so a previous drill in
  // the same hour would still hold the claim. Clearing it is the drill being
  // repeatable — the claim surviving is the dedup working across processes,
  // which is the behaviour being tested everywhere else in this file.
  const digestKeys = [windowStart, hourBucket(T0)].map((d) => `digest:${d.toISOString()}`);
  await db.execute(sql`delete from alert_deliveries where alert_key = any(${sql.param(digestKeys)}::text[])`);

  before = transport.sent.length;
  for (let m = 0; m < 30; m += 1) {
    await sendHourlyDigest(transport, db, at(m));
  }
  check('hourly digest × 30 calls in one hour', 1, transport.sent.length - before);

  // --- report ---------------------------------------------------------------
  const deliveries = await db.execute<{ kind: string; n: number; msgs: number }>(sql`
    select kind, count(*)::int n, coalesce(sum(send_count),0)::int msgs
    from alert_deliveries where alert_key like ${`%${RUN}%`} or kind = 'system'
    group by kind order by kind
  `);

  console.log('\n  delivery rows:');
  for (const row of deliveries) {
    console.log(`    ${row.kind.padEnd(12)} ${row.n} keys, ${row.msgs} messages`);
  }

  const failures = results.filter((r) => r.expected !== r.actual);
  console.log(
    `\n  ${failures.length === 0 ? 'ALL PATHS FIRED EXACTLY AS EXPECTED — no duplicates' : `${failures.length} PATH(S) WRONG`}`,
  );
  console.log(`  total messages sent: ${transport.sent.length}\n`);

  // --- cleanup --------------------------------------------------------------
  await db.execute(sql`delete from alert_deliveries where alert_key like ${`%${RUN}%`} or kind in ('system', 'digest')`);
  await db.execute(sql`delete from violations where constraint_key like ${`${RUN}%`}`);
  await db.execute(sql`delete from market_quotes where condition_id like ${`${RUN}%`}`);
  await db.execute(sql`delete from markets where event_id = ${RUN}`);
  await db.execute(sql`delete from events where id = ${RUN}`);
  console.log('  fixtures cleaned up');

  if (mock !== null) {
    // Every counted send must have reached the wire. A message the dedup let
    // through but the transport dropped would look identical in the counters.
    const delivered = mock.received.filter((r) => r.method === 'POST').length;
    console.log(`  HTTP requests actually delivered: ${delivered} (counted ${transport.sent.length})`);
    if (delivered !== transport.sent.length) {
      console.log('  ✗ transport dropped messages');
      await mock.close();
      return 1;
    }
    await mock.close();
  }
  console.log('');

  return failures.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('drill failed:', error);
}
await closeDatabase().catch(() => {});
process.exit(code);
