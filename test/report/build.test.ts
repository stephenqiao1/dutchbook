import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { events, markets, relationGroups, relations, violations } from '../../src/db/schema.js';
import { buildReport } from '../../src/report/build.js';
import { Canvas } from '../../src/report/png.js';

/**
 * The report end to end, against a real database.
 *
 * The point of these is that a report is a document people quote. A chart that
 * silently writes a corrupt PNG, or a median that is computed over the wrong
 * subset, is worse than no report — it is a number someone repeats.
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
  console.warn('\n  SKIPPED test/report/build.test.ts — needs Postgres.\n');
}

let client: postgres.Sql;
let database: PostgresJsDatabase<typeof schema>;
let stopContainer: (() => Promise<void>) | undefined;
let outDir: string;

const T0 = Date.parse('2026-08-01T12:00:00.000Z');

async function seed(): Promise<void> {
  await database.execute(
    sql`truncate violations, relation_groups, relations, markets, events restart identity cascade`,
  );

  await database.insert(events).values([{ id: 'e1', slug: 'e1', title: 'E1' }]);
  await database.insert(markets).values([
    {
      conditionId: '0xa',
      eventId: 'e1',
      question: 'Will Bitcoin close above $150,000?',
      slug: 'btc-150k',
      contentHash: 'h1',
      endDate: new Date(T0 + 40 * 86_400_000),
    },
    {
      conditionId: '0xb',
      eventId: 'e1',
      question: 'Will Bitcoin close above $120,000?',
      slug: 'btc-120k',
      contentHash: 'h2',
      endDate: new Date(T0 + 40 * 86_400_000),
    },
    {
      conditionId: '0xc',
      eventId: 'e1',
      question: 'Will the Senate confirm the nominee?',
      slug: 'senate-nominee',
      contentHash: 'h3',
      endDate: new Date(T0 + 5 * 86_400_000),
    },
  ]);

  await database.insert(relations).values([
    { fromConditionId: '0xa', toConditionId: '0xb', type: 'implies', source: 'ladder', confidence: '1' },
    { fromConditionId: '0xb', toConditionId: '0xc', type: 'implies', source: 'temporal', confidence: '1' },
  ]);
  await database
    .insert(relationGroups)
    .values({ key: 'g1', type: 'partition', source: 'neg-risk-event', confidence: '1' });

  // Three closed episodes with known lifetimes (10s, 100s, 1000s) and one open.
  await database.insert(violations).values([
    {
      constraintKey: 'implies:1',
      kind: 'implies',
      relationIds: [1],
      conditionIds: ['0xa', '0xb'],
      status: 'confirmed',
      everConfirmed: true,
      detectedAt: new Date(T0),
      resolvedAt: new Date(T0 + 10_000),
      peakMagnitude: '0.0400',
      peakNetEdge: '0.0300',
      peakNetProfit: '30.00',
    },
    {
      constraintKey: 'implies:2',
      kind: 'implies',
      relationIds: [2],
      conditionIds: ['0xb', '0xc'],
      status: 'apparent',
      everConfirmed: false,
      detectedAt: new Date(T0 + 60_000),
      resolvedAt: new Date(T0 + 160_000),
      peakMagnitude: '0.0800',
    },
    {
      constraintKey: 'partition:1',
      kind: 'partition',
      relationIds: [],
      conditionIds: ['0xc'],
      status: 'apparent',
      everConfirmed: false,
      detectedAt: new Date(T0 + 200_000),
      resolvedAt: new Date(T0 + 1_200_000),
      peakMagnitude: '0.1500',
    },
    {
      constraintKey: 'implies:1',
      kind: 'implies',
      relationIds: [1],
      conditionIds: ['0xa', '0xb'],
      status: 'apparent',
      everConfirmed: false,
      detectedAt: new Date(T0 + 3_000_000),
      resolvedAt: null,
      peakMagnitude: '0.0200',
    },
  ]);
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

  client = postgres(url, { max: 4, onnotice: () => {} });
  database = drizzle(client, { schema });

  const dir = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).toSorted()) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed !== '') await client.unsafe(trimmed);
    }
  }

  await seed();
  outDir = mkdtempSync(join(tmpdir(), 'dutchbook-report-'));
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await stopContainer?.();
});

describe.skipIf(!canRun)('buildReport', () => {
  it('writes a report and every chart', async () => {
    const result = await buildReport({ database, outDir, now: new Date(T0 + 4_000_000) });

    expect(result.reportPath).toBe(join(outDir, 'REPORT.md'));
    expect(result.charts.length).toBeGreaterThanOrEqual(7);
    for (const chart of result.charts) {
      expect(readFileSync(join(outDir, chart)).length).toBeGreaterThan(0);
    }
  });

  it('emits valid PNGs, not just files with the right extension', async () => {
    // A corrupt image renders as a broken-image icon in the one place anyone
    // looks at it, so the header and dimensions are checked rather than assumed.
    const result = await buildReport({ database, outDir, now: new Date(T0 + 4_000_000) });

    for (const chart of result.charts) {
      const png = readFileSync(join(outDir, chart));
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
      expect(png.readUInt32BE(16)).toBeGreaterThan(100); // width
      expect(png.readUInt32BE(20)).toBeGreaterThan(100); // height
      expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
    }
  });

  it('measures lifetime over closed episodes only', async () => {
    // Closed: 10s, 100s, 1000s -> median 100s, printed as 1.7m. The open
    // episode must not appear as "however long it has been so far", which would
    // make the published median depend on when the report happened to run.
    const { markdown } = await buildReport({ database, outDir, now: new Date(T0 + 4_000_000) });

    // The lifetime table is the three-column one: all-closed and confirmed-only.
    const row = markdown
      .split('\n')
      .find((l) => l.startsWith('| median |') && l.split('|').length === 5);
    expect(row).toBe('| median | 1.7m | 10s |');
  });

  it('reports the observation window rather than implying thirty days', async () => {
    const { markdown, windowHours } = await buildReport({
      database,
      outDir,
      now: new Date(T0 + 4_000_000),
    });

    expect(windowHours).toBeGreaterThan(0);
    expect(markdown).toContain('## Observation window');
    expect(markdown).toContain('This is not thirty days of data');
  });

  it('separates apparent from confirmed and says so', async () => {
    const { markdown } = await buildReport({ database, outDir, now: new Date(T0 + 4_000_000) });

    // One confirmed of four episodes.
    expect(markdown).toContain('**25.0% of episodes were executable.**');
    expect(markdown).toContain('No partition violation was ever confirmed.');
  });

  it('always carries the limitations section', async () => {
    const { markdown } = await buildReport({ database, outDir, now: new Date(T0 + 4_000_000) });

    for (const heading of [
      '## 7. Limitations',
      '### What the extraction misses',
      '### Where the fee model could be wrong',
      '### Measurement floor and censoring',
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it('refuses to claim a weekday effect it cannot measure', async () => {
    const { markdown } = await buildReport({ database, outDir, now: new Date(T0 + 4_000_000) });
    expect(markdown).toContain('**Day-of-week is not measurable from this data.**');
  });

  it('survives a database with no violations at all', async () => {
    // Production is currently in exactly this state, and a report that throws
    // on an empty table is a report nobody can run against production.
    await database.execute(sql`truncate violations restart identity cascade`);
    const { markdown } = await buildReport({ database, outDir, now: new Date(T0) });

    expect(markdown).toContain('## 7. Limitations');
    expect(markdown).not.toContain('NaN');
    expect(markdown).not.toContain('undefined');
    await seed();
  });
});

describe('Canvas', () => {
  it('round-trips its dimensions through the PNG header', () => {
    const png = new Canvas(321, 123).toPNG();
    expect(png.readUInt32BE(16)).toBe(321);
    expect(png.readUInt32BE(20)).toBe(123);
  });

  it('clips drawing outside its bounds instead of corrupting neighbours', () => {
    // A negative x wrapping to the previous row is the classic framebuffer bug
    // and shows up as a stripe down the far edge of the image.
    const canvas = new Canvas(10, 10);
    expect(() => {
      canvas.fillRect(-50, -50, 20, 20, [0, 0, 0]);
      canvas.set(999, 999, [0, 0, 0]);
      canvas.text('overflowing text', 8, 8, [0, 0, 0], 3);
    }).not.toThrow();
    expect(canvas.toPNG().length).toBeGreaterThan(0);
  });

  it('measures text width consistently with what it draws', () => {
    const canvas = new Canvas(10, 10);
    expect(canvas.textWidth('', 2)).toBe(0);
    expect(canvas.textWidth('A', 2)).toBe(10);
    // Six columns of advance per character, minus the trailing gap.
    expect(canvas.textWidth('AB', 2)).toBe(22);
  });
});
