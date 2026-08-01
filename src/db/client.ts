import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as schema from './schema.js';

const log = createLogger('db');

/**
 * Raw postgres.js handle. Prefer `db` for queries; this is exported for the
 * things Drizzle doesn't cover (LISTEN/NOTIFY, COPY, connection teardown).
 *
 * postgres.js connects lazily, so importing this module does not open a socket.
 */
/**
 * A connection through a transaction-pooling proxy cannot use prepared
 * statements: the pooler hands each transaction whichever backend is free, and
 * a statement prepared on one is not there on the next. postgres.js prepares by
 * default, so this must be turned off or queries start failing with
 * `prepared statement "s1" does not exist` under concurrency — intermittently,
 * and only once more than one connection is in play.
 *
 * Fly's Managed Postgres hands out a PgBouncer hostname, so this is detected
 * from the URL rather than left to an operator to remember. `?prepare=true`
 * forces it back on for a direct connection that happens to be named this way.
 */
export function poolerAwareOptions(url: string): { prepare: boolean; pooled: boolean } {
  const parsed = new URL(url);
  const forced = parsed.searchParams.get('prepare');
  if (forced !== null) return { prepare: forced === 'true', pooled: false };

  const pooled =
    parsed.hostname.includes('pgbouncer') ||
    parsed.hostname.includes('pooler') ||
    parsed.searchParams.get('pgbouncer') === 'true';

  return { prepare: !pooled, pooled };
}

const { prepare, pooled } = poolerAwareOptions(config.DATABASE_URL);
if (pooled) log.info('postgres: pooled endpoint detected, prepared statements disabled');

export const queryClient = postgres(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  prepare,
  onnotice: (notice) => {
    log.debug({ notice }, 'postgres notice');
  },
});

export const db: PostgresJsDatabase<typeof schema> = drizzle(queryClient, { schema });

/**
 * Round-trips a trivial query. Throws if Postgres is unreachable.
 *
 * Deliberately uses the raw client rather than `db.execute`: Drizzle rewraps
 * driver failures as `Failed query: select 1`, which hides the ECONNREFUSED an
 * operator actually needs to see.
 */
export async function pingDatabase(): Promise<void> {
  await queryClient`select 1`;
}

export interface CatalogCounts {
  /** Markets a recent crawl still returns. */
  readonly tracked: number;
  /** Markets retained but no longer returned. */
  readonly missing: number;
  readonly revisions: number;
}

/**
 * Row counts for the `/metrics` gauges.
 *
 * One round trip, three aggregates, no sequential scan of the revision table:
 * `count(*) filter (...)` lets Postgres answer both market counts from a single
 * pass. Called on every scrape, so it must stay cheap as the catalog grows.
 */
export async function countCatalog(): Promise<CatalogCounts> {
  const [row] = await queryClient<
    Array<{ tracked: string; missing: string; revisions: string }>
  >`
    select
      (select count(*) filter (where missing_since is null) from markets) as tracked,
      (select count(*) filter (where missing_since is not null) from markets) as missing,
      (select count(*) from market_revisions) as revisions
  `;

  return {
    tracked: Number(row?.tracked ?? 0),
    missing: Number(row?.missing ?? 0),
    revisions: Number(row?.revisions ?? 0),
  };
}

/** Drains the pool. Safe to call more than once. */
export async function closeDatabase(): Promise<void> {
  await queryClient.end({ timeout: 5 });
  log.info('postgres pool closed');
}
