/**
 * Jobs: the work that runs on a schedule rather than on a request.
 *
 * `ingest-catalog.ts` is a plain async function, not a BullMQ worker. Keeping
 * the work callable on its own is what makes it testable without Redis, and
 * lets a worker be a thin wrapper when one is added:
 *
 *   import { Queue, Worker } from 'bullmq';
 *   import { redis } from '../redis.js';
 *   import { ingestCatalog } from './ingest-catalog.js';
 *
 *   export const catalogQueue = new Queue('catalog', { connection: redis });
 *   new Worker('catalog', () => ingestCatalog(), { connection: redis });
 *
 * Reuse the shared `redis` client from `src/redis.ts` — it is already set up
 * with `maxRetriesPerRequest: null`, which BullMQ workers require. Log through
 * `createLogger('jobs')`; never `console.*`.
 */

export {
  CATALOG_DLQ_NAME,
  CATALOG_QUEUE_NAME,
  catalogJobStats,
  startCatalogJobs,
  type CatalogJobResult,
  type CatalogJobStats,
  type CatalogJobs,
  type CatalogJobsOptions,
} from './catalog-queue.js';

export {
  LockLostError,
  acquireLock,
  withLock,
  type AcquireLockOptions,
  type HeldLock,
} from './lock.js';

export {
  HASHED_FIELDS,
  canonicalize,
  contentHash,
  contentOf,
  createCatalogStore,
  diffContent,
  findMarketRevisions,
  findMissingMarkets,
  ingestCatalog,
  responseHash,
  toEventRow,
  toMarketRow,
  toRawPayloadRow,
  type CatalogStore,
  type CatalogTx,
  type FieldChange,
  type HashedField,
  type IngestLogger,
  type IngestOptions,
  type IngestSummary,
  type MarketContent,
} from './ingest-catalog.js';
