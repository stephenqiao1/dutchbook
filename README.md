# dutchbook

[![CI](https://github.com/stephenqiao1/dutchbook/actions/workflows/ci.yml/badge.svg)](https://github.com/stephenqiao1/dutchbook/actions/workflows/ci.yml)
<!-- Uptime badge: paste the Better Stack badge here once a monitor exists.
     See "Uptime monitoring" below — it needs an account, so it is not set up yet. -->

TypeScript backend service that reconciles the Polymarket catalog into Postgres
and keeps an audit trail of every upstream edit.

**Live:** <https://dutchbook.fly.dev> — [`/health`](https://dutchbook.fly.dev/health) · [`/metrics`](https://dutchbook.fly.dev/metrics)

Fastify HTTP, Postgres via Drizzle, BullMQ jobs on Redis, deployed on Fly.io.

## Quickstart

From a fresh clone. Requires **Node 22+**, **pnpm 10+**, and **Docker**.

```bash
# 1. Install dependencies
pnpm install

# 2. Create your env file (defaults already match docker-compose.yml)
cp .env.example .env

# 3. Start Postgres 16 and Redis 7
docker compose up -d

# 4. Wait until both report healthy
docker compose ps

# 5. Run the service
pnpm dev
```

Then, in another terminal:

```bash
curl -s localhost:3000/health
# {"status":"ok","uptimeSeconds":3,"version":"0.1.0"}
```

Run the tests:

```bash
pnpm test
```

Most of the suite runs against fakes and needs nothing. Two files exercise real
infrastructure and start throwaway containers for themselves, so they need
**Docker running**:

| File                              | Needs    | Why                                         |
| --------------------------------- | -------- | ------------------------------------------- |
| `test/idempotency.test.ts`        | Postgres | Upsert semantics and the dedupe constraint  |
| `test/jobs/catalog-queue.test.ts` | Redis    | `SET NX`, key expiry, BullMQ retry behaviour |

Without Docker they **skip loudly** rather than fail — watch for the warning, and
do not read a green run as proof they passed. Set `TEST_DATABASE_URL` and
`TEST_REDIS_URL` to use existing throwaway instances instead of containers.

To tear the infrastructure down (`-v` also drops the named volumes and their data):

```bash
docker compose down      # keep data
docker compose down -v   # wipe data
```

## Scripts

| Script             | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `pnpm dev`         | Run from source with `tsx`, restarting on change           |
| `pnpm build`       | Type-check and emit JavaScript to `dist/`                  |
| `pnpm start`       | Run the built output (`dist/index.js`) — use in production |
| `pnpm test`        | Run the Vitest suite once                                  |
| `pnpm job:ingest`  | Trigger a catalog ingest by hand (`--inline` runs it here) |
| `pnpm lint`        | Lint with oxlint                                           |
| `pnpm test:crash-drill` | SIGKILL an ingest mid-run and verify it reconciles    |
| `pnpm typecheck`   | Type-check everything, including tests, without emitting   |
| `pnpm db:generate` | Diff `src/db/schema.ts` and write a migration to `drizzle/`|
| `pnpm db:migrate`  | Apply pending migrations to `DATABASE_URL`                 |
| `pnpm db:studio`   | Open Drizzle Studio against `DATABASE_URL`                 |

`pnpm start` requires `pnpm build` first.

## Layout

```
src/
  config.ts       env parsed through Zod; fails fast, reporting every problem at once
  logger.ts       the pino instance — JSON in production, pretty in development
  errors.ts       flattens wrapped/aggregate errors into one readable line
  redis.ts        shared ioredis connection, configured for BullMQ
  db/
    schema.ts     Drizzle tables: events, markets, revisions, prices, raw payloads
    client.ts     Drizzle instance, connection pool, health probe
  polymarket/
    gamma.ts      Gamma catalog client: keyset pagination, rate limiting, retries
    schemas.ts    Zod schemas that coerce Gamma's inconsistent payloads
  jobs/
    ingest-catalog.ts  catalog reconciliation: hash, diff, revise, reconcile
    catalog-queue.ts   BullMQ schedule, worker, dead letter queue, job metrics
    lock.ts            Redis mutual exclusion that spans deployed instances
    trigger-ingest.ts  `pnpm job:ingest`
  server.ts       Fastify app and routes
  index.ts        process entrypoint: start, signal handling, graceful shutdown
test/
```

## Configuration

Every variable is documented in [`.env.example`](.env.example). `DATABASE_URL` and
`REDIS_URL` are required; everything else has a default.

Configuration is validated once, at import, in [`src/config.ts`](src/config.ts).
A bad environment stops the process before it binds a port, and reports **every**
problem in one message rather than one restart per variable:

```
ConfigError: Invalid environment configuration.

Missing required variables (2):
  DATABASE_URL
  REDIS_URL

Invalid value (1):
  PORT="abc" — Invalid input: expected number, received NaN

See .env.example for the full list of supported variables.
```

Import `config` anywhere you need a setting; do not read `process.env` directly
outside of `config.ts`.

## Health

`GET /health` probes Postgres and Redis on every request.

Both reachable — **200**:

```json
{
  "status": "ok",
  "uptimeSeconds": 412,
  "version": "0.1.0",
  "jobs": {
    "queue": { "waiting": 0, "active": 1, "delayed": 1, "failed": 0, "completed": 143 },
    "deadLettered": 0,
    "lastSuccessAt": "2026-08-01T02:50:11.402Z",
    "lastFailure": null
  }
}
```

The `jobs` block reports catalog ingest state, read from Redis so every replica
answers the same — the instance serving the check is usually not the one that ran
the job. It is **reported, never used to set `status`**: a failed ingest is an
operational problem, not an unhealthy process, and letting it flip readiness
would have an orchestrator restart a pod that is serving traffic perfectly well.
Alert on `lastSuccessAt` going stale and on `deadLettered` rising instead.

If Redis cannot answer, the block degrades on its own and the check still passes:

```json
{ "status": "ok", "jobs": { "error": "connection is closed" } }
```

Either unreachable — **503**, with a `checks` field naming what failed:

```json
{
  "status": "degraded",
  "uptimeSeconds": 412,
  "version": "0.1.0",
  "checks": {
    "postgres": "ok",
    "redis": "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:6379"
  }
}
```

Each probe is bounded by `HEALTHCHECK_TIMEOUT_MS`, so a hung dependency returns
503 rather than holding the connection open. Point your orchestrator's readiness
probe at this route.

## Logging

Everything goes through the pino logger in [`src/logger.ts`](src/logger.ts) —
there are no `console.*` calls in `src/`, and new code should not add any.

- Inside a Fastify handler, use `request.log` so lines carry `reqId`.
- Elsewhere, use `createLogger('<component>')` for a tagged child logger.

Development gets human-readable output via `pino-pretty`; every other
environment emits one JSON object per line. `LOG_LEVEL` controls verbosity.
Authorization headers, cookies, and any field named `password`, `secret`,
`token`, or `apiKey` are redacted.

## Database

Tables are defined in [`src/db/schema.ts`](src/db/schema.ts). The workflow:

1. Add or change a `pgTable` in `src/db/schema.ts`
2. `pnpm db:generate` — writes SQL to `drizzle/`
3. Review the generated SQL, and commit it
4. `pnpm db:migrate` — applies it

Query through the `db` export from [`src/db/client.ts`](src/db/client.ts).

### The catalog tables

The schema treats Polymarket as a **mutable** upstream. Markets are renamed,
re-tagged, closed, and reopened in place, and the vendor keeps no history of it.

| Table              | Holds                                                        |
| ------------------ | ------------------------------------------------------------ |
| `events`           | Event groups, keyed by Polymarket's event id                  |
| `markets`          | Current state of each market, keyed by `condition_id`         |
| `market_revisions` | One row per field per edit — the audit trail                  |
| `price_snapshots`  | Top-of-book per outcome token, keyed `(condition_id, token_id, ts)` |
| `raw_payloads`     | Every response received, archived before validation           |

Two choices are worth knowing about:

- **`markets` is keyed on `condition_id`, not Polymarket's numeric `id`.** The
  condition id is the identifier shared with the CLOB and the chain, and it
  survives the vendor renumbering its own catalog. A market that arrives without
  one is skipped and counted, because it can be neither reconciled nor priced.
- **`first_seen_at` / `last_seen_at` are ours, not the vendor's.** They record
  when *we* observed a row, which is the only trustworthy basis for deciding
  something has disappeared.

## Jobs

[`src/jobs/`](src/jobs/) is where scheduled work lives. Reuse the shared `redis`
client from [`src/redis.ts`](src/redis.ts) — it is already configured with
`maxRetriesPerRequest: null`, which BullMQ workers require.

Job bodies are plain async functions rather than BullMQ workers, so they are
callable and testable without Redis; a worker is a thin wrapper around one.

### Catalog ingest

[`src/jobs/ingest-catalog.ts`](src/jobs/ingest-catalog.ts) reconciles the
Polymarket catalog into Postgres. It is a **reconciliation, not an append**:

```ts
import { ingestCatalog } from './jobs/index.js';

const summary = await ingestCatalog();
```

**Content hashing.** Each market is hashed over its semantic fields only —
`question`, `description`, `resolution_source`, `outcomes`, `clob_token_ids`,
`end_date`, `active`, `closed`. Volume, liquidity, prices, and spreads are
excluded: they move on every crawl, and including them would mark every market
as edited every run, burying the handful of edits that actually matter.

`clob_token_ids` is in the set for a different reason than the others. It is not
editorial content, but an unchanged hash writes nothing but `last_seen_at`, and
Polymarket routinely publishes a market before its CLOB tokens are minted. Left
out, a market first seen with null token ids would keep them null until its text
happened to change, and price collection would have nothing to key on.

The hash is taken over canonicalised JSON, so object keys are sorted before
hashing and a `Date` and its ISO string produce the same hash. Array order is
*preserved* — `outcomes[i]` is the outcome for `clob_token_ids[i]`, so a swap is
a different market, not a re-sort, and sorting would erase which token is "Yes".

**Three paths per market**, decided by that hash:

| Hash        | What is written                                              |
| ----------- | ------------------------------------------------------------ |
| new         | An insert                                                     |
| unchanged   | `last_seen_at` only — no content write, no revision           |
| changed     | The updated row, plus one `market_revisions` row per changed field |

A revision records the old and new values as jsonb, and brackets the edit with
`content_hash_before` / `content_hash_after` — every revision from one crawl
shares that pair, which is what lets a market's state be replayed. Reverts are
recorded like any other edit, and the hashes chain.

**Nothing is ever deleted.** A market the crawl stops returning keeps its row
and gets `missing_since` stamped with the last crawl that *did* return it — not
with the time we noticed. The flag clears the moment it reappears; markets do
come back. Read it with `findMissingMarkets()`.

The sweep only runs after a crawl that was supposed to cover the whole catalog.
After a filtered or page-capped crawl it would flag everything the filter
excluded, so it defaults off there — override with `reconcileMissing`.

**Transactions.** Each batch of ~250 markets commits as one transaction: events,
then markets, then their revisions. A crash mid-crawl leaves the batches that
committed and nothing from the one that did not. Because every write is keyed on
`condition_id` and revisions are only written when the hash actually moved, the
next run re-crawls from the start and produces no duplicate rows or revisions.

**Raw archival.** Payloads are written from the client hook — before parsing,
and outside the batch transaction. That ordering is deliberate: a body that fails
to parse is the one worth keeping. `response_hash` is unique, so a catalog that
has not changed between crawls costs one row rather than one per run.

Every run logs a summary, successful or not:

```json
{
  "level": "info",
  "component": "ingest-catalog",
  "runStartedAt": "2026-08-01T03:00:00.000Z",
  "durationMs": 48213,
  "complete": true,
  "batches": 37,
  "events": { "seen": 4212 },
  "markets": { "seen": 9188, "created": 12, "updated": 4, "unchanged": 9170, "skipped": 2 },
  "revisions": 7,
  "rawPayloads": { "archived": 41, "duplicate": 51 },
  "missing": 118,
  "errors": 0,
  "msg": "catalog ingest complete"
}
```

`created + updated + unchanged + skipped` always equals `seen`. A failed run logs
the same object at `error` with `complete: false` and the error attached, then
rethrows.

**What still lags.** `slug`, `event_id`, and `archived` sit outside the hashed
set, so they are only refreshed on a run where a hashed field also moved. None
of them is load-bearing for pricing or resolution, so a lagging value is a
cosmetic staleness rather than a correctness problem — but a market renamed with
no other edit will keep its old slug until something else about it changes. Move
a column into `HASHED_FIELDS` to close that, at the cost of one revision row per
affected market on the run that catches up.

### Scheduling

[`catalog-queue.ts`](src/jobs/catalog-queue.ts) runs the ingest every ten
minutes on BullMQ. Three layers keep two crawls from overlapping:

1. `concurrency: 1` — one job at a time **within** a worker.
2. A BullMQ job scheduler — one *scheduled* job per interval, cluster-wide.
3. A Redis lock — the backstop that actually spans replicas.

The first two are optimisations. Only the third helps when a crawl outlasts its
own ten-minute interval, or when several replicas are deployed, so it is the one
that carries the guarantee. It is a `SET NX` with a compare-and-delete release,
renewed continuously while held — so `CATALOG_INGEST_LOCK_TTL_MS` bounds how long
a *crashed* instance blocks the next run, not how long a run may take.

A job that finds the lock held completes as `{ ran: false }` rather than failing.
That is the correct outcome: the catalog is being crawled right now, and retrying
would only queue up behind it.

Two things stop a run mid-flight, and both reach the HTTP client rather than only
the loop between events — a hung request is interrupted, not waited out:

- the job deadline, `CATALOG_INGEST_TIMEOUT_MS`
- **losing the lock** — a failover, an eviction, a long GC pause. Another replica
  may already have started, so the run must stop, not finish.

**Failure handling.** `CATALOG_INGEST_ATTEMPTS` attempts with exponential
backoff. A job that exhausts them is copied to the `catalog-ingest-dlq` queue
with its payload, attempt count, and error, and recorded as `lastFailure` on
`/health`. Dead letters are never auto-removed — they are evidence.

**Shutdown.** On `SIGTERM` the HTTP server stops accepting connections first,
then the worker drains: an in-flight job holds the lock and a database
transaction, and interrupting it wastes the whole crawl where waiting costs the
rest of one batch. The drain gets `JOB_DRAIN_TIMEOUT_MS` *on top of*
`SHUTDOWN_TIMEOUT_MS`, because the HTTP server's ten seconds would kill a crawl
mid-batch on every deploy. A job still running at that deadline is returned to
the queue for another replica rather than lost.

Set `CATALOG_INGEST_ENABLED=false` on web-only replicas so scaling HTTP does not
multiply crawlers.

### Running one by hand

```bash
pnpm job:ingest            # enqueue a job and wait for a worker to run it
pnpm job:ingest --inline   # run it in this process
```

Enqueuing is the default: it goes through the same lock, retries, and
dead-lettering as a scheduled run, which is what you want against a live
deployment. `--inline` is for a laptop with no worker running — it still takes
the lock, so it cannot collide with a deployed crawl.

## External APIs

### Polymarket Gamma

[`src/polymarket/gamma.ts`](src/polymarket/gamma.ts) is the client for
`https://gamma-api.polymarket.com`, the public market and event catalog. No
authentication.

The crawl surface is a pair of async generators, so a caller never holds more
than one page:

```ts
import { iterateMarkets } from './polymarket/index.js';

for await (const market of iterateMarkets({ params: { closed: false } })) {
  await ingest(market); // one market at a time; pages are fetched on demand
}
```

Construct a `GammaClient` directly to override the defaults — the rate, the
retry budget, or the raw-payload hook:

```ts
const client = new GammaClient({
  requestsPerSecond: 20,
  maxRetries: 6,
  onRawResponse: async (raw) => archive(raw.url, raw.text),
});
```

`onRawResponse` fires for **every** response, including error statuses and
retries, and receives the body before validation — that is the hook to archive
raw payloads from. It is awaited, so a slow archive applies backpressure; a hook
that throws is logged and ignored.

**Pagination.** `/markets/keyset` and `/events/keyset` take `after_cursor` and
`limit` (max 100, and clamped here) and return `next_cursor` until the last
page. Sending `offset` to a keyset endpoint is a 422, so the client never sends
one and strips it from caller-supplied `params`.

**Rate limiting.** Polymarket's limits are Cloudflare-driven and shared globally
across callers rather than per-key, so a 429 is possible at any rate. A token
bucket caps outgoing requests at 20/s — far under the published ceiling — and
429s and 5xx are retried with exponential backoff and *full* jitter, honouring
`Retry-After` as a floor. After six retries the client throws a typed
`RateLimitExceededError` carrying `attempts` and the last `retryAfterMs`.

**Schemas.** [`schemas.ts`](src/polymarket/schemas.ts) is where the vendor's
inconsistency is absorbed. Numbers arrive as numbers or as decimal strings;
`outcomes` and `outcomePrices` are usually JSON-encoded strings rather than
arrays; optional fields come and go between records; dates appear as ISO-8601,
bare `YYYY-MM-DD`, Postgres-style offsets, and epoch numbers. Every field is
coerced through a Zod transform into a clean domain type.

Coercion failures are **field-local**. A market whose `outcomePrices` is
`["0.51", "abc"]` is still yielded, with that one field `null` and a structured
warning naming the market id, the field, and the value:

```json
{
  "level": "warn",
  "component": "polymarket-gamma",
  "kind": "market",
  "marketId": "900001",
  "field": "outcomePrices",
  "reason": "1: expected a number, got \"abc\"",
  "msg": "gamma field dropped: kept record with field null"
}
```

The only record the client discards is one with no usable `id`, since it can be
neither stored nor meaningfully complained about. A single malformed market
never halts a catalog crawl.

## Metrics

`GET /metrics` serves the Prometheus text exposition format, and Fly's managed
Prometheus scrapes it over the private network (`[metrics]` in `fly.toml`).

| Metric | Type | Notes |
| --- | --- | --- |
| `ingest_runs_total{result}` | counter | `success` \| `failure` \| `skipped` (another replica held the lock) |
| `ingest_errors_total{kind}` | counter | `run` for a failed run, `record` for salvaged-but-broken records |
| `ingest_duration_seconds` | histogram | buckets 1s → 20m |
| `ingest_markets_total{outcome}` | counter | `created` / `updated` / `unchanged` / `skipped` |
| `revisions_written_total` | counter | revision rows written by this process |
| `api_requests_total{method,status}` | counter | HTTP served |
| `rate_limit_hits_total{status}` | counter | 429s and 5xx from Polymarket that forced a backoff |
| `markets_tracked` | gauge | from Postgres at scrape time |
| `markets_missing` | gauge | retained but no longer returned by a crawl |
| `revisions_stored` | gauge | all-time revision rows |
| `ingest_last_success_timestamp_seconds` | gauge | from Redis, so every replica agrees |

Counters are per-process and reset on restart — normal for Prometheus, and
`rate()` handles it. Anything that must survive a restart is a gauge read from
Postgres or Redis at scrape time instead. A gauge whose source cannot be read is
**omitted** rather than reported as zero, so a scrape never invents a number.

Useful alerts:

```promql
# The ingest has not succeeded in an hour.
time() - ingest_last_success_timestamp_seconds > 3600

# Jobs are dead-lettering.
increase(ingest_runs_total{result="failure"}[1h]) > 3

# Polymarket is throttling us harder than usual.
rate(rate_limit_hits_total[15m]) > 0.5
```

## Deployment

Deployed to [Fly.io](https://fly.io) as a single machine in `iad`.

```bash
flyctl deploy --remote-only --ha=false
```

- **`Dockerfile`** — three stages. Production `node_modules` are installed in
  their own stage so the runtime image never contains a dev dependency; the
  final image is `node:22-alpine`, runs as the unprivileged `node` user, and
  uses `tini` as PID 1 so SIGTERM actually reaches Node and the graceful drain
  runs.
- **`release_command`** — `node dist/db/migrate.js` applies pending migrations
  before the new version takes traffic. It uses the migrator from `drizzle-orm`
  rather than the `drizzle-kit` CLI, because drizzle-kit is a dev dependency and
  the production image does not carry one. A non-zero exit aborts the deploy and
  leaves the previous version serving.
- **`kill_timeout = "90s"`** — must exceed `SHUTDOWN_TIMEOUT_MS +
  JOB_DRAIN_TIMEOUT_MS`. Fly's 5s default would SIGKILL the machine mid-batch on
  every deploy.
- **`auto_stop_machines = false`** — this is a scheduler, not a request handler.
  Suspending an idle machine would stop the ingest entirely.

Attached services:

```bash
flyctl mpg create   --name dutchbook-db    --plan Basic --region iad
flyctl redis create --name dutchbook-redis --region iad --disable-eviction
flyctl secrets set DATABASE_URL=... REDIS_URL=...
```

Redis eviction is **disabled deliberately**: BullMQ stores job state in Redis,
and an eviction policy would silently drop queued jobs under memory pressure.

Fly's Managed Postgres hands out a PgBouncer hostname. `src/db/client.ts`
detects a pooled endpoint from the URL and disables prepared statements, which
transaction pooling cannot support — without it, queries fail intermittently
with `prepared statement "s1" does not exist` once more than one connection is
in play.

## Uptime monitoring

**Not yet set up** — it needs a Better Stack account, which this environment has
no credentials for. To finish it:

1. Create a free Better Stack account.
2. Add an HTTP monitor for `https://dutchbook.fly.dev/health`, expecting `200`,
   checked every 3 minutes.
3. Copy the badge markdown into the placeholder at the top of this file.

Fly's own health check (`/health`, every 15s) is already running and will
restart an unresponsive machine, but it is not an external monitor — it cannot
tell you the app is unreachable from outside Fly.

## Notes

- **Strict TypeScript.** `strict`, plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `noUnusedLocals`. ESM throughout, so relative
  imports carry a `.js` extension — that is the compiled path, and correct in
  `.ts` source under `NodeNext`.
- **Shutdown** is graceful: on `SIGINT`/`SIGTERM` the server stops accepting
  connections, then Postgres and Redis are released. If that exceeds
  `SHUTDOWN_TIMEOUT_MS`, the process force-exits non-zero.
- **`pnpm-workspace.yaml`** exists only to let `esbuild` run its install script,
  which `tsx`, Vitest, and drizzle-kit all depend on.
