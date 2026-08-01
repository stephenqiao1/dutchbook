import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { config } from '../config.js';
import { poolerAwareOptions } from './client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';

/**
 * Applies pending migrations. This is Fly's `release_command`.
 *
 * Uses the migrator from `drizzle-orm` rather than the `drizzle-kit` CLI,
 * because drizzle-kit is a dev dependency and the production image does not
 * carry one. The migrator reads the same `drizzle/` folder and records applied
 * migrations in `drizzle.__drizzle_migrations`, so it is interchangeable with
 * `pnpm db:migrate` locally.
 *
 * A release command that exits non-zero aborts the deploy and leaves the
 * previous version serving — which is what should happen when a migration
 * fails.
 */

const log = createLogger('migrate');

/** Migrations run on a dedicated single connection, never the app pool. */
const client = postgres(config.DATABASE_URL, {
  max: 1,
  prepare: poolerAwareOptions(config.DATABASE_URL).prepare,
  onnotice: () => {},
});

/** Resolves from `dist/db/` to the `drizzle/` folder beside it in the image. */
const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname;

try {
  log.info({ migrationsFolder }, 'applying migrations');
  await migrate(drizzle(client), { migrationsFolder });
  log.info('migrations up to date');
} catch (error) {
  log.fatal({ error: describeError(error) }, 'migration failed, aborting the release');
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await client.end({ timeout: 5 });
process.exit(0);
