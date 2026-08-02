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
| `pnpm coherence:check` | Run one coherence check by hand and print every trade construction |
| `pnpm coherence:report` | Median violation lifetime and why apparent ones failed |
| `pnpm pricing:verify <token_id> [size] [category]` | Price an order against the live book |
| `pnpm relations:extract` | Run every deterministic extractor over the catalog and persist |
| `pnpm relations:propose` | Embed, draw candidates, classify — writes only `pending` proposals |
| `pnpm relations:review` | Decide pending proposals; the only path from a proposal to an edge |
| `pnpm relations:calibrate` | Score the classifier against known answers; writes nothing |
| `pnpm relations:inspect <condition_id>` | Print everything related to a market |
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
    http.ts       token bucket, backoff, retry — shared by every Polymarket client
    gamma.ts      Gamma catalog client: keyset pagination, rate limiting, retries
    clob.ts       CLOB order book client: batched /books, normalised depth
    schemas.ts    Zod schemas that coerce Gamma's inconsistent payloads
  coherence/
    constraints.ts  the three constraints, their magnitudes, and the corrections
    trade.ts        prices a correcting basket; refuses when it does not pay
    check.ts        the two-stage screen-then-confirm orchestration
    load.ts         constraints from the graph, quotes for the cheap screen
    violations-store.ts  episodes, peaks, and lifetime
    inspect-cli.ts  `pnpm coherence:check` / `--report`
  pricing/
    costs.ts      every fee and cost assumption, each with its source
    executable.ts walks the book level by level; partial fill, slippage, fees
    snapshots.ts  persists books to price_snapshots with full depth
  relations/
    types.ts           shared vocabulary: pairwise edges and set-valued groups
    ladders.ts         threshold ladders — pure, total, no I/O
    temporal.ts        deadline nesting: "by June 30" entails "by December 31"
    complements.ts     mechanical negations, P(A) + P(B) = 1
    partitions.ts      negRisk events, and the conflict check they ground
    graph.ts           DAG, cycle rejection, transitive reduction, queries
    extract.ts         runs every extractor and validates against partitions
    bands.ts           band arithmetic — the ground truth calibration leans on
    inspect.ts         `pnpm relations:inspect`
    extract-cli.ts     `pnpm relations:extract`
    store.ts           idempotent persistence
    embeddings.ts      local sentence-transformer; questions only, never criteria
    candidates.ts      pgvector kNN minus everything already known
    proposer.ts        the one module that calls an LLM — returns proposals only
    propose-cli.ts     `pnpm relations:propose`
    proposals-store.ts pending proposals, verdicts, and the only path to an edge
    review.ts          `pnpm relations:review`
    calibrate.ts       `pnpm relations:calibrate` — scores the model, writes nothing
  jobs/
    ingest-catalog.ts  catalog reconciliation: hash, diff, revise, reconcile
    catalog-queue.ts   BullMQ schedule, worker, dead letter queue, job metrics
    coherence-queue.ts the independent 60-second coherence schedule
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

### Polymarket CLOB

[`src/polymarket/clob.ts`](src/polymarket/clob.ts) reads the live order book.
Read-only: no auth, no wallet, no order placement.

**Gamma's prices are not tradeable.** They lag the book by seconds, and a
midpoint is not a price you can transact at even when current — it ignores the
spread and it ignores whether there is any size behind it. A violation computed
from Gamma midpoints is usually an illusion, so everything downstream prices
against real depth.

Rate limiting, backoff, and retry are *literally* the Gamma client's, extracted
into [`http.ts`](src/polymarket/http.ts) and imported by both. Polymarket's
budget is enforced per-IP at the Cloudflare edge and is therefore shared across
every client in this process: two independent token buckets would each believe
it was under budget while together exceeding it.

The client batches through `POST /books` rather than looping `/book`. The two
have nearly the same per-request budget — 500 vs 1,500 req / 10s — so batching
buys up to two orders of magnitude against the same limit. Note that `/books`
has its own allowance, far tighter than the 9,000 req / 10s general CLOB
budget; the tighter one is what the token bucket targets.

#### Three ways the live API will silently corrupt your prices

Each was found by probing the running service, and each is pinned by a test.
None of them throws — they produce confident, wrong numbers.

| What it does | What it costs you |
| --- | --- |
| **Levels arrive worst-first.** `bids` ascend and `asks` descend, so on *both* sides the best price is the **last** element. | Reading `bids[0]` as the top of book returned **0.001** against a real best bid of **0.024** on a live market. |
| **`POST /books` answers out of order.** A six-token request came back permuted. | Mapping responses to requests positionally attributes every book to the wrong market. Responses are keyed by `asset_id`. |
| **Unknown tokens are dropped, not rejected.** Six requested, five returned, HTTP 200. | A caller assuming one response per request shifts its own bookkeeping. `fetchBooks` returns a `missing` list — always check it. |

The client sorts both sides explicitly rather than trusting the wire order, and
drops levels that cannot be traded against (unparseable numbers, non-positive
sizes, prices outside `(0, 1]`) rather than coercing them to zero — a
zero-priced level looks like free depth to the book walker.

## Pricing against real depth

### `executableCost(book, side, size)`

[`src/pricing/executable.ts`](src/pricing/executable.ts) walks the book level by
level. **No level is assumed to absorb the order**, depth running out is a
partial fill rather than an error or an extrapolation, and slippage is measured
against the **touch** rather than the midpoint — measuring against the midpoint
silently folds half the spread into "slippage" and makes a wide market look deep.

Pure and total: no I/O, no clock, and no throwing. A nonsensical request returns
a zero fill, because a pricing function that throws inside a sweep over
thousands of markets is one that stops the sweep.

Here is the whole argument for the module, from a live market on 2026-08-01 —
buying 500 shares of a book whose touch is 65¢:

```
  best ask         65.00¢     spread 4.00¢     ask depth 155.5 over 5 levels

  filled           155.5 / 500  (PARTIAL — book too thin)
  avg price        68.96¢
  total (no fee)   $107.23
  slippage vs ask  6.090%
  levels consumed  5

     65.00¢ ×    60      69.00¢ ×  20
     66.00¢ ×  41.5      96.00¢ ×  14   ← the last 14 shares
     68.00¢ ×    20
```

Quoting the touch would have claimed 500 shares for $325. The truth is 155.5
shares for $107.23, with the final fill 48% worse than the top of book. The
naive number is wrong about the price *and* the quantity.

### Fees and costs

[`src/pricing/costs.ts`](src/pricing/costs.ts) holds every fee, cost, and
execution assumption, each with its source and the date it was checked. Nothing
else in the pricing path is allowed to hardcode one.

Polymarket charges takers `fee = C × feeRate × p × (1 - p)`, in USDC; makers are
never charged. Two consequences the code depends on:

- **It must be applied per level, not at the average price.** `p(1-p)` is
  concave, so charging once at the average *systematically understates* the fee
  on an order spanning a range of prices.
- **It is symmetric about 0.5 in dollars but not as a fraction of notional** —
  that fraction is `feeRate × (1 - p)`, so at 5¢ and a 5% rate the fee is 4.75%
  of the amount staked.

Two things the API will mislead you about:

- **`base_fee` is not a rate.** `GET /fee-rate/{token_id}` returns an integer
  the spec calls "basis points"; the live value is `1000`, which read literally
  is 10% — between 1.4× and 2.5× every published rate. Sampling 2,000 markets,
  it takes exactly two values: `0` (84 markets, precisely the documented
  geopolitics carve-out — Duma seats, Greenland, Maduro, Iran) and `1000`
  (1,916, spanning categories the schedule prices at 0.04, 0.05, *and* 0.07). A
  field that cannot distinguish 0.04 from 0.07 is not carrying the rate. It is
  treated as a fee-enabled flag: its zero is authoritative, its magnitude ignored.
- **The fee category is not published anywhere.** Neither CLOB nor Gamma exposes
  one; Gamma has free-form tags (a Fed market carries `Fed`, `Economic Policy`,
  `Jerome Powell`), none of which is one of the eleven categories in the
  schedule. So the category must come from the caller, and the default when it
  does not is 0.07 — the *highest* rate, so an unknown market looks worse than it
  is rather than better. Notional and average price are exact regardless; only
  the fee line moves.

### Snapshots keep depth, not midpoints

`price_snapshots` stores the **top ten levels on both sides**, the full-book
depth totals, the spread, and the venue's own book timestamp alongside our
capture time — the gap between those two *is* the staleness that makes Gamma
unusable, and it is only measurable if both are kept.

A stored row re-prices through the same `executableCost` as a live book, with no
special case: `bookFromSnapshot` returns an `OrderBook`. That is the entire
point. A history of midpoints cannot answer "what would 500 shares have cost at
that moment", and would make every past opportunity look executable at any size.

Storing ten levels while recording depth over the *whole* book means truncation
is visible rather than silent — a re-price against a truncated snapshot
under-promises, never over-promises.

### Verifying against the venue

```bash
pnpm pricing:verify <token_id> [size] [category]
```

Fetches the live book, prices the order, and prints the numbers a Polymarket
order ticket shows so the two can be compared directly. It runs a second,
deliberately independent calculation straight off the raw JSON — sorting nothing
and sharing no code with `executableCost` — because a walker checked only
against itself proves nothing.

Verified on 2026-08-01 against *Fed rate hike in 2026?* (Yes), buying 60,000
shares so the order spans levels:

```
45,786.81 × 0.68 = 31,135.0308
14,213.19 × 0.69 =  9,807.1011
                   ───────────
                   40,942.1319   avg 68.24¢ vs a 68¢ touch, 0.348% slippage
```

Both calculations agree to the cent, and the arithmetic checks by hand.

## Relations

[`src/relations/ladders.ts`](src/relations/ladders.ts) extracts **threshold
ladders**: families of markets sharing a subject and a resolution date that
differ only in a numeric threshold.

```
Will the price of XRP be above $2.70 on September 4 at 12PM ET?
Will the price of XRP be above $2.73 on September 4 at 12PM ET?
Will the price of XRP be above $2.76 on September 4 at 12PM ET?
```

Within a family the constraint is arithmetic, not statistical: a price above
$2.76 is necessarily above $2.73. So the edges carry `confidence 1.0` — they are
entailments, and `P(from) <= P(to)` is exact.

The module is **pure and total**: no network, no LLM, no clock, no I/O, and it
returns `null` rather than throwing on anything it cannot read. Persistence
lives in [`store.ts`](src/relations/store.ts) precisely so the extractor can be
tested exhaustively against real question strings with no database present.

### Coverage

Measured over the live catalog — **187,691 markets, 2026-08-01**:

| | markets | share |
| --- | ---: | ---: |
| parse to a threshold rung | 27,184 | 14.48% |
| **land in some ladder** | **16,602** | **8.85%** |

1,769 ladders, 14,813 edges, median 11 rungs. `pnpm test` recomputes this from a
committed corpus of whole events sampled from the same snapshot (8.50% — events
rather than markets, because sampling markets independently shatters families
and halves the measured number).

**8.85% is below the 10–30% one might expect, and the reason is specific:** the
largest numeric family in the catalog is not thresholds at all. 10,064 markets
are phrased as *bands* — `between $104K and $105K` — and a band is not monotone.
Landing in [104K, 105K] implies nothing about landing in [103K, 104K]. Reading
the first number as a threshold would roughly double coverage while emitting
implications that are false, so they are rejected. The remaining gap is exact
values (`by 25 bps`), parlays, and races (`hit $80k or $100k first`) — all of
which carry numbers but no monotone order.

### The other three sources

| Source | Relation | Constraint | Where it comes from |
| --- | --- | --- | --- |
| `ladder` | `implies` | P(from) ≤ P(to) | threshold families |
| `temporal` | `implies` | P(from) ≤ P(to) | nested deadlines |
| `complement` | `complement` | P(A) + P(B) = 1 | mechanical negation |
| `neg-risk-event` | `partition` | Σ P = 1 | the venue's own flag |

**Partitions are ground truth.** Polymarket flags an event `negRisk` when its
markets are mutually exclusive and exhaustive — a three-way soccer result, a
"top performing Magnificent 7 company" set, a league winner list with an
"another team" catch-all. Exactly one resolves Yes, so the Yes legs sum to 1.
That is asserted by the venue rather than inferred from text, which makes it the
yardstick for everything else: `findPartitionConflicts` reports any inferred
relation that contradicts one, and `buildRelationGraph` drops it. An implication
between two members of a mutually exclusive set cannot be true, so when the two
disagree it is the text extractor that is wrong.

A partition is a **hyperedge**, not a pair, and gets its own tables
(`relation_groups`, `relation_group_members`). Decomposing it into pairs loses
half its content: pairwise exclusivity only bounds the sum at 1, and it is
exhaustiveness — a property of the whole set — that pins it to exactly 1.

**Temporal nesting** turns on one distinction: `by` and `before` accumulate,
`on` and `at` do not. "Above $2.70 **on** September 4" says nothing about
September 5 — the price can fall back — so instants are refused however much
they look like dates. And a `by` mid-question is usually a magnitude
("inflation increase **by** 2.2%", "lead in RCP **by** 0-0.4"), so the deadline
clause is anchored to the end of the question. Ordering uses the market's
resolution timestamp, because a written deadline is often yearless and guessing
a year would invent the fact the edge depends on. Subjects must match
character-for-character.

**Complements** recognise a negation only by *removing* it and finding another
market whose question is then character-identical. That needs no exception list:
`Will "I Am Not Okay" by Jelly Roll win Best Country Song?` de-negates to a
question no market asks, so no pair forms. Ambiguous matches — one negation with
two candidate positives — are dropped rather than guessed.

## LLM-assisted proposals

The four deterministic sources only fire when the relation is visible in the
*text*. Many related pairs do not oblige:

```
Will Carlos Alcaraz win 3:1 against Taylor Fritz?
Will Carlos Alcaraz win 3:2 against Taylor Fritz?     ← exclusive, no shared threshold

Spread: Nuggets (-8.5)
Spread: Nuggets (-0.5)                                ← entailment, no shared phrasing
```

A model reads these correctly. So the pipeline asks one — and then declines to
take its word for it.

### The constraint

> **LLM output is a proposal, never an edge. Nothing enters the graph without a
> persisted verdict.**

Enforced in three places rather than by convention:

| Where | How |
| --- | --- |
| Types | `proposeRelations` returns `RelationProposal`, which is not a `RelationEdge` and cannot be passed where one is expected. |
| Tables | Proposals land in `relation_proposals` with `status = 'pending'`. Nothing in [`proposer.ts`](src/relations/proposer.ts) or [`propose-cli.ts`](src/relations/propose-cli.ts) can write to `relations`. |
| Transaction | [`recordVerdict`](src/relations/proposals-store.ts) is the only path between them. It writes the verdict and the edge together, and refuses to run on a proposal that is not `pending` — so a rejection is permanent and a later pass cannot quietly overturn it. |

[`test/relations/proposals-store.test.ts`](test/relations/proposals-store.test.ts)
holds each of these against a real Postgres, including the one that matters
most: a re-run reaching an already-rejected pair leaves the rejection, the
original type, and the original rationale untouched.

### The pipeline

```bash
pnpm relations:extract               # deterministic first — not optional, see below
pnpm relations:propose --limit=200   # embed → candidates → classify → pending
pnpm relations:review                # accept / reject / skip, one at a time
pnpm relations:calibrate             # score the model against known answers
```

**1 — Candidates.** Every pair is O(n²); at 300k markets that is 45 billion
comparisons. So each market is embedded once (`Xenova/all-MiniLM-L6-v2`, 384
dims, running locally — no API call), stored in a `vector(384)` column behind an
HNSW index, and candidates are its nearest neighbours above a cosine floor of
0.82.

Only the **question** is embedded, never the resolution criteria. Criteria are
near-identical boilerplate across an entire event; including them makes every
market in an event look alike and destroys exactly the signal the index exists
to provide. They are given to the *classifier*, where they matter, and withheld
from the *retriever*, where they do not.

Four anti-joins then subtract what is already known: pairs with a deterministic
edge in either direction, pairs **reachable through a chain** of such edges,
pairs already sharing a partition, and pairs already proposed — whatever their
verdict.

That third exclusion was a correctness fix, not an optimisation. Ladders store
*adjacent* rungs only, because implication is transitive and an 88-rung ladder is
87 edges rather than 3,828. So `above $222` and `above $212` are joined by a path
and not by an edge — and a direct-edge test alone let **99 of one 220-pair
sample (45%)** through as "uncovered". Those were model calls spent rediscovering
arithmetic, and worse, they would have flattered every number below with pairs
that were never in question.

**Running `relations:extract` first is therefore load-bearing.** A stale
`relations` table does not merely miss edges; it pays the model to re-derive
them.

**2 — Classification.** One call per pair — both questions and both resolution
criteria — for exactly one of `implies` / `implied_by` / `mutually_exclusive` /
`complement` / `unrelated`, plus a one-sentence rationale and a confidence.

The response is validated by a **strict** zod schema: unknown keys are rejected,
not stripped. A response that fails to parse is logged with its raw text and the
pair is **dropped** — never repaired, re-prompted, or guessed at. A malformed
answer is evidence the model did not understand the question, and inventing a
relation from it is the precise failure this design exists to prevent. Across
330 live calls, 6 (1.8%) failed to parse: five omitted `confidence`, one emitted
a stray `;` between JSON fields.

**3 — Review.** [`relations:review`](src/relations/review.ts) shows one proposal
at a time with both questions, the proposed relation *and what it would mean as a
constraint*, the rationale, and `[d]etail` for the full resolution criteria.
Accepting writes an edge with source `llm_reviewed`; rejecting is permanent.
Every verdict records **who** made it, because a precision figure with no named
judge cannot be interpreted.

`mutually_exclusive` is accepted but writes **no edge**, deliberately. Pairwise
exclusivity bounds a sum at 1; a partition pins it to exactly 1. `relations`
stores implications and complements, and inventing a pairwise encoding for
exclusivity would put a constraint into the graph that a solver would read as
stronger than what was actually verified.

### Re-runs cost nothing

The guarantee is that a full pipeline re-run makes **zero** model calls for
already-reviewed pairs. Measured directly against the live database after 225
verdicts: 3,271 candidates remained, and **0** of them were a pair already
carrying a verdict. [`test/relations/candidates.test.ts`](test/relations/candidates.test.ts)
pins it for every verdict (`accepted`, `rejected`, `skipped`, still-`pending`) in
both pair orderings; deleting the anti-join fails six of those tests.

### How reliable is the model?

Two numbers, measuring two different things. **Read the second one.**

**Acceptance rate — 98.5%** (131 of 133 relation-claiming proposals accepted;
99.1% including `unrelated`), over 225 reviewed proposals drawn as a uniform
sample of the eligible population rather than the most-similar pairs:

| Proposed | Accepted | Rejected | Rate |
| --- | ---: | ---: | ---: |
| `implies` | 68 | 1 | 98.6% |
| `implied_by` | 60 | 0 | 100% |
| `mutually_exclusive` | 3 | 1 | 75% |
| `unrelated` | 92 | 0 | 100% |
| **relation-claiming** | **131** | **2** | **98.5%** |

⚠️ **The reviewer was Claude Code, not an independent human.** The spec this was
built to asks for a human verdict, and that is what the `reviewed_by` column
records — verbatim, so nobody can mistake this figure for something it is not.
An agent grading a model's output is measuring agreement, not reliability, and
the two rejections below are the kind an aligned grader is *least* likely to
catch. Re-run `pnpm relations:review` yourself for the number the spec actually
asks for; the pipeline is what is being delivered here, not this percentage.

The two rejections are worth stating, since 98.5% otherwise says nothing:

- **A direction inversion.** `Favorite(Clippers) vs Underdog(Grizzlies) Line:
  1.5` → `Line: 7.5`, proposed `implies`. The market's outcomes are
  `["Favorite","Underdog"]`, so Yes means *the Clippers cover*; covering a 1.5
  line does not imply covering 7.5 — the implication runs the other way. The
  model had reasoned about the **underdog** leg. Its own confidence, 0.60, was
  the lowest in that batch, and it answered two structurally identical pairs
  correctly, so this is an inconsistency rather than a misunderstood convention.
- **An unverifiable external fact.** `Will Oregon make the CFP National
  Championship Game?` vs the same for Texas, proposed `mutually_exclusive` on the
  grounds that both were "on the same side of the bracket". Two teams can in
  general both reach a final. Nothing in either question or either resolution
  criteria establishes the bracket, so the claim rests on recalled trivia.

**Calibration — 100.0% (120/120).** [`relations:calibrate`](src/relations/calibrate.ts)
scores the classifier against answers known *before* it is asked, from sources it
never sees:

| Class | Ground truth | Score |
| --- | --- | ---: |
| `implies` | pairs the ladder and temporal extractors already connected, half presented reversed | 40/40 |
| `mutually_exclusive` | disjoint numeric bands over an identical subject and date — arithmetic | 40/40 |
| `unrelated` | markets drawn from two different events | 40/40 |

Identical scores with resolution criteria supplied and withheld. The direction
test matters: half the entailment pairs are reversed, so a classifier that always
answered `implies` would score 50%, and it scored 100%.

**What this does not show.** All three classes are drawn from families where a
right answer demonstrably exists — that is what makes them usable as ground truth
and also what makes them easy. It is a floor on competence, not an estimate of
field precision, and it says nothing about *recall*: the pairs the model called
`unrelated` when a relation was really there are, by construction, not in any
denominator here. Corrupting the labels drops the harness to 0/4 on the affected
class, so the 100% is a measurement rather than a plumbing artefact.

## Coherence checking

The point of everything above. A relation says two prices *must* stand in some
order; the checker asks whether they do, and — when they do not — whether the
correction can actually be executed at a profit.

### The three constraints

| Relation | Requires | Violation magnitude |
| --- | --- | --- |
| `implies(A, B)` | P(A) ≤ P(B) | P(A) − P(B), **signed** |
| `complement(A, B)` | P(A) + P(B) = 1 | \|sum − 1\| |
| `partition(S)` | Σ P over S = 1 | \|sum − 1\| |

The `implies` magnitude stays signed on purpose: a satisfied entailment has a
negative magnitude, which is slack. Taking an absolute value would report every
comfortably-satisfied constraint as a large violation.

### Every correction is a basket of buys

Polymarket has no short. You cannot sell a token you do not hold — but every
market has two complementary outcome tokens that together always pay exactly 1,
so *selling Yes is buying No*. Each correction is therefore a basket of **buy**
orders, each priced against its own real book, with a payout that is bounded
below in every state the constraint permits:

| Constraint | Direction | Basket | Worst-case payout |
| --- | --- | --- | ---: |
| `implies(A,B)` | over | No(A), Yes(B) | 1 |
| `complement(A,B)` | over | No(A), No(B) | 1 |
| `complement(A,B)` | under | Yes(A), Yes(B) | 1 |
| `partition(S)` | under | Yes of every member | 1 |
| `partition(S)` | over | No of every member | **n − 1** |

The `implies` row is the non-obvious one. A entails B, so the state A=1,B=0
cannot occur. Buy one No(A) and one Yes(B):

```
A=1, B=1 →  0 + 1  =  1
A=0, B=1 →  1 + 1  =  2
A=0, B=0 →  1 + 0  =  1
A=1, B=0 →  excluded by the entailment
```

Never less than 1, so any cost below 1 is free money. That is exactly the naive
"sell A, buy B" trade, expressed in instruments that exist at prices you can get.

The `partition` over-priced row pays **n − 1**, not 1: exactly one member
resolves Yes, so every *other* No pays out. Scoring a five-member partition
against a payout of 1 would reject a genuinely profitable trade.

### Two stages, in that order for a reason

**Stage 1** evaluates every constraint against cached Gamma midpoints. One Gamma
request covers 100 markets; the equivalent CLOB coverage is one order book per
*token*, two per market. Running stage 2 over the whole graph would be four
orders of magnitude more expensive and would spend the entire CLOB budget
rediscovering that almost everything is priced consistently.

**Stage 2** fetches live books for the survivors, builds the basket, walks each
leg through [`executableCost`](src/pricing/executable.ts), and asks whether
anything is left. A violation is **CONFIRMED** only if net profit clears a
materiality floor; everything else is **APPARENT**, with the reason recorded.

A partial fill is fatal, not merely worse: three legs of a four-leg partition is
not three quarters of an arbitrage, it is an unhedged directional bet. A leg
that cannot fill kills the size.

**The two numbers that are not the same:**

- `size` — the basket size that maximises *total net profit*.
- `maxExecutableSize` — the brief's "max size before edge goes to zero".

Pricing the trade at the second one reports every real mispricing as a $0.00
opportunity, because that size is *defined* as break-even. The first live run of
this checker did exactly that and confirmed five violations all worth precisely
nothing.

### Lifetime

`violations` records **episodes**, not observations: one row per interval a
constraint was violated, opened when it starts and closed when it stops. A
partial unique index enforces at most one open episode per constraint. Peaks
rather than latest values, ranked on total profit — a violation briefly worth
$40 and now worth $2 should answer $40.

`resolved_at − detected_at` over confirmed episodes gives the headline. Median,
not mean: most violations close on the next tick and a few persist for hours, so
a mean is dominated by the tail and describes nothing anyone experiences.

Critically, an episode is closed only when the constraint is examined *and found
satisfied*. A run that never looked at a constraint — a truncated stage 2, a
missing quote — must not resolve it, or every lifetime it touches is wrong.

### ⚠️ What the first live run found

The checker confirmed a **$435 risk-free arbitrage** on Trump approval-rating
markets. It was not risk-free. It was a bet that pays **zero** in one of three
states, and the checker was right to derive it — because the *relation it was
given* was false.

The ladder extractor read `hit 35%` as an upward threshold. Polymarket's own
resolution criteria for that family say:

> "…resolve to Yes if Donald Trump's approval rating … is **equal to or below**
> the listed value…"

So falling to 30% entails having passed 35%: `hit 30%` implies `hit 35%`, the
exact reverse of what was recorded. Under the true relation the basket's minimum
payout is 0, not 1.

**888 live markets pair a hit/reach question with a below-style rule.** Worse,
Polymarket uses both directions in the same-looking family — the 2025 approval
markets resolve "at or above", the 2026 ones "at or below" — so no amount of
reading question text would have settled it.

`hit` and `reach` are now flagged ambiguous and resolved against the resolution
criteria, and **refused outright when the criteria do not say**. A missing edge
costs an opportunity; a reversed one costs whatever someone traded behind it.

This is what the "verify by hand" acceptance criterion is *for*. A reversed
entailment does not look wrong anywhere upstream — it produces a confident,
well-formed, fully-priced trade construction that happens to be a guaranteed
loss.

## The relation graph

[`src/relations/graph.ts`](src/relations/graph.ts) loads every edge into an
in-memory DAG.

**Cycles are rejected, not tolerated.** A cycle in the implication relation means
A entails B entails … entails A, which forces every market on it to the same
probability. That is essentially never a real discovery and essentially always a
bug — a subject normalized too aggressively, a threshold read off the wrong
number. `RelationGraph.build` logs each cycle with its path and question text and
throws `RelationCycleError`; `{ tolerateCycles: true }` drops the cyclic edges and
keeps the rest.

**Transitive reduction** leaves the covering edges only, so a consistency check
tests each genuine link once instead of re-testing every implied pair — 87 edges
for an 88-rung ladder rather than 3,828. The implementation releases each
reachable set once its last predecessor is done, and reuses a successor's set
when it is the sole remaining consumer; without that a long chain is quadratic
in memory and a 20,000-node chain exhausts the heap.

Queries: `ancestors` (stronger claims that entail this one), `descendants`
(weaker claims it entails), `partitionsContaining`, `complementsOf`.

### Validation status

| Check | Result |
| --- | --- |
| Graph over a 12,008-market real corpus | **0 cycles**, 0 conflicts (runs in CI) |
| Ten random live `negRisk` partitions | **10/10 genuinely exclusive** |
| Cycle detection, 5,000-node chain closed into a loop | detected |
| Transitive reduction, 20,000-node chain | correct, linear memory |

Building over the **full** 300k-market catalog is still outstanding: the Fly
Managed Postgres Basic instance cannot serve a full-table scan of `markets`
without the backend crashing, so the load never completes. See the operational
note in [Deployment](#deployment).

```bash
pnpm relations:inspect 0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff
```

prints every related market, the relation type, the extractor that produced it,
and whether the link is a stored edge or only reachable transitively.

### What the parser refuses

A false edge asserts a probability bound that is not true and corrupts anything
built on it; a missed edge only costs coverage. Every ambiguity resolves to
`null`:

- **bands** — `between $X and $Y`, and dashed ranges like `25-30%`
- **exact values** — `by 25 bps`, which partitions outcomes rather than ordering them
- **multiple thresholds** — parlays and races, detected by a threshold surviving
  in the subject after the matched clause is stripped
- **subjectless markets without an event** — the catalog holds ~2,350 bare
  `Over 231.5` lines; on subject-and-date alone every one sharing a date joins a
  single group spanning unrelated games

Grouping is exact-match on normalized subject, direction, unit, and date. No
fuzzy matching. Event scoping is on by default and only ever *splits* a group.

### Edges

```ts
{ fromConditionId, toConditionId, type: 'implies', source: 'ladder',
  confidence: 1.0, rationale }
```

Adjacent rungs only — implication is transitive, so an 88-rung ladder is 87
edges rather than 3,828. Pass `{ transitive: true }` for every ordered pair.

Stored in `relations`, unique on `(from_condition_id, to_condition_id, type)`,
so re-extraction refreshes `last_seen_at` instead of inserting duplicates.
`first_seen_at` never moves, and a `CHECK` rejects self-edges.

## The live market feed

[`src/polymarket/ws.ts`](src/polymarket/ws.ts) holds an in-memory order book for
every token under constraint, fed by the CLOB market WebSocket
(`wss://ws-subscriptions-clob.polymarket.com/ws/market`). Stage 1 screens on
those books instead of on cached Gamma quotes.

Read-only, like the rest of [src/polymarket/](src/polymarket/). No auth, no
wallet, no orders.

### Freshness is not latency

Handing live prices to a check that runs every sixty seconds does not make
detection fast. **A poll finds a violation an average of half its interval after
it opens**, so a sixty-second schedule has a thirty-second median however fresh
its inputs are. Price freshness and detection latency are different quantities,
and only the second is what a trader loses to.

So the feed drives the screen. [`watch.ts`](src/coherence/watch.ts) keeps a
`token → constraints` index; a book update marks only the constraints that token
participates in as dirty, and 250ms later only those are re-evaluated. When one
crosses epsilon, a check is queued immediately.

The scheduled check stays, unchanged, as the floor. It still re-screens
everything against cached quotes, so a market whose book never seeded or whose
shard is disconnected is still covered — just at the old speed. Replacing the
poll rather than backing it up would turn any feed outage into silent blindness.

Only *transitions* are reported. A violation open across a hundred book updates
is one detection, not a hundred, and a burst of detections collapses to one
queued check.

### Seven things the venue does

All measured against the running service on 2026-08-01. Every one of them
corrupts a book **silently** if assumed the other way — a wrong book does not
throw, it produces a confident, well-formed, wrong price.

| # | Behaviour | How it was established |
| --- | --- | --- |
| 1 | `price_change.size` is the new **absolute** size at that level, not a delta | Both interpretations applied side by side over 214 changes on 8 tokens, then compared to REST: **absolute 6/8, delta 0/8** |
| 2 | Levels arrive worst-first — bids ascending, asks descending | Observed; identical to REST |
| 3 | The initial `book` snapshot is **not reliable at scale** | 24 assets → 24 snapshots. 1,000 assets → **zero**. 25,548 → eight |
| 4 | A second `subscribe` on an open socket is rejected | Answered `INVALID OPERATION`; the new assets never delivered |
| 5 | `PING` → `PONG` as a text frame | Sent and answered |
| 6 | `best_bid`/`best_ask` on an event are the venue's **current** top, which runs *ahead* of the incremental stream | 24 of 3,914 changes disagreed with the applied book; every sampled case needed changes not yet delivered |
| 7 | Each state carries a `hash` that identifies it | Over 60 comparisons, equal hash ⇒ identical level maps, 60/60 |

Hazard 3 is the dangerous one. Alongside those missing snapshots, **5,780
assets sent `price_change` events for books that were never snapshotted**. A
book assembled from those changes alone contains only the levels that happened
to move and none of the resting depth behind them — it looks entirely normal.

So **REST seeds every book**, and a change for an unseeded token is dropped and
counted (`changesUnseeded`). The feed is the fast path, never the source of
truth about what exists.

### Sizing the subscription

The stated mitigation — subscribe only to tokens in at least one relation rather
than the whole catalog — turns out to save less than it sounds like:

| Set | Tokens |
| --- | --- |
| Whole active catalog | 29,902 |
| Markets under constraint | 25,548 |
| **Outcome-0 tokens only** | **12,774** |

85% of the active catalog is already in the graph, so the relation filter saves
15%. The halving comes from subscribing to **outcome 0 only**: every relation is
written about P(first outcome), and the second token is its complement, so
subscribing to it doubles the bandwidth to learn a number available by
subtraction. Stage 2 still fetches both legs over REST — a correcting basket may
need either side, and it needs real depth rather than a midpoint.

One socket accepted all 25,548 tokens, so the shard size is not a venue limit.
It is a blast radius: the asset set is fixed for the life of a connection
(hazard 4), so a shard is the unit that must be rebuilt when the constraint
graph changes, and the unit one dropped socket takes offline.

### Reconnect and heartbeat

Full-jitter backoff, the same policy the HTTP clients use — every shard drops
together when the venue restarts, and correlated reconnects are how a blip
becomes an outage.

`PING` every 10s, and a connection silent for 30s is recycled even if the socket
still claims to be open. On a shard of quiet markets, silence and death are
otherwise indistinguishable; `PONG` is the only thing that separates them.

**A reconnect re-seeds from REST.** Nothing is replayed for the window we were
away, so those books are of unknown age — and letting the reconciler discover
that a few hundred tokens a minute would leave them wrong for minutes, quietly.

### Reconciliation, and why the naive version is useless

Comparing an in-memory book to a REST snapshot does not work directly. The two
are taken at different instants, so they differ constantly for reasons that are
not bugs: of 8 tokens compared after 45 seconds of updates, **2 differed by
exactly one level** — in each case a level that landed between the last WS event
and the REST read. A counter fed by that comparison never reaches zero and
therefore says nothing.

The `hash` (hazard 7) is what makes it meaningful. Each token sorts into one of
four cases:

| Case | Meaning | Counted as |
| --- | --- | --- |
| Hash equal, levels equal | Agreed | — |
| **Hash equal, levels differ** | **The incremental apply is wrong** | `content` |
| Hash in our recent history | REST is behind us. Expected | — |
| Hash unrecognised | In flight, or missed — indistinguishable now | parked, re-examined next cycle; `stale` if still unknown |

Deferring judgment on the last case is what makes zero reachable: an update in
flight and one never delivered look identical in the moment, and calling the
first a divergence would keep the counter permanently non-zero.

#### The top-of-book check is a hint, not a verdict

Every `price_change` carries a `best_bid`/`best_ask`, and comparing them against
the applied book looked like a free continuous assertion. It is not one. Those
fields are the venue's *current* top, and they run ahead of the incremental
stream — of 3,914 changes, 24 disagreed, and in every sampled case the reported
top required changes that had not been delivered yet:

```
reported 0.11/0.44   before 0.14/0.44   after 0.13/0.44   change = BUY 0.14 → 0
```

We removed the 0.14 bid as instructed, leaving 0.13. The venue already had 0.13
*and* 0.12 gone. Nothing is wrong; we are simply a few milliseconds behind.

Counting these as divergences measured a 0.6% false-positive rate. So the check
is kept for what it is genuinely good for — a token whose top trails is a token
worth reconciling next — and it feeds the resync queue rather than the counter.

### What the divergence counter actually measures

Both remaining kinds mean an update never reached us:

- **`content`** — we hold the hash of the venue's current state but not every level behind it, so an intermediate update was lost.
- **`stale`** — the venue is in a state we never saw at all, and still had not seen a full cycle later.

**Neither is zero at production scale, and that is not a bug in this code.**
Drift scales with how much is subscribed:

| Tokens subscribed | Changes applied | Divergence rate |
| --- | --- | --- |
| 5 | 565 | **0%** |
| 30 | 1,968 | 1.8% |
| 200 | 10,608 | 2.7% |

At five tokens the apply path reconstructs the venue's book exactly, 565 changes
running with zero disagreement. The rate rises with subscription size, which is
delivery loss under volume — the same property that makes the venue skip initial
snapshots at scale (hazard 3).

That reframes reconciliation. It is not a tripwire for a bug that should never
fire; it is a **continuous repair loop**, and its sweep period is a correctness
parameter, because it bounds how long a drifted book can price stage 1. Hence
2,500 books every 30s — a ~2.5 minute sweep of a 12,500-token feed, for 25
requests per 30s against a 50/s ceiling.

Operationally, what matters is that the rate stays *flat*. A step change means
something broke.

Plus `ws_connected` (connected shards, not a boolean — five of six connected is
a real state), `ws_reconnects_total`, `ws_messages_total{type}`, and
`coherence_detection_latency_seconds`.

### Verifying it

```bash
pnpm feed:soak -- --minutes=20
```

Drives the real feed against live books and reports median detection latency and
each divergence kind separately. A 12-minute run over 12,493 subscribed tokens,
885,299 level changes applied:

```
subscribed 12493 tokens across 5 shard(s); seeded 4854
watching 1409 constraints

t+ 203s  msgs 237716  conn 5/5  reconn 1  detections 174  median 0.18s
t+ 563s  msgs 686711  conn 5/5  reconn 1  detections 410  median 0.07s

detections     507        reconciliation  checked 6000, agreed 5361, ahead 440
latency p50    0.06s      divergence content   51
latency p90    1.45s      divergence stale      0
latency p99   10.87s      top hints           380  (not a defect)
latency max   15.95s      drift rate         0.85% of 6000 comparisons
```

**Median detection latency 0.06s**, against a 5-second target — and against the
~30s a 60-second poll can achieve at best, however fresh its prices are.

Two honest results from that run:

- **4,854 of 12,493 tokens seeded.** The rest are markets our catalog considers
  active that the CLOB has no book for, so stage 1 prices them from the cached
  Gamma quote via the documented fallback. That is a catalog-freshness question
  worth chasing, not a feed defect — but it does mean the feed currently covers
  39% of the constrained set and the poll still carries the rest.
- **Divergence did not stay at zero, and will not.** It is a property of the
  venue's delivery at scale, measurably absent at 5 tokens and present at 200.
  The soak reports the drift *rate* and fails on a 5% ceiling rather than on
  zero, because a threshold tuned until it reads green is worth less than the
  honest number. It also prints the literal zero criterion, failing, so the gap
  is visible rather than argued away.

An earlier run showed a 331-second worst-case latency. That was an artefact, not
a slow detection: books drained after seeding kept the *snapshot's* venue
timestamp rather than the timestamp of the newest change replayed onto them, so
every violation such an emission opened looked as old as the venue's last write
to that market. Fixed; the tail fell to 15.95s.

## Alerting

[`src/alerts/`](src/alerts/) fires a Discord webhook when a violation is
confirmed above a configurable net edge. The message carries both market
questions, the current prices, the constraint violated, the net edge, the max
executable size, and direct Polymarket links.

Sending is the easy half. **Deduplication is the feature**, and it is what
separates an operational alerter from a script that shouts every minute.

### What decides whether to send

[`dedupe.ts`](src/alerts/dedupe.ts) is one pure function over (stored state,
current value, clock) returning `send | escalate | resolve | suppress`. No
network, no database, no `Date.now()` — every rule below is a table-driven test.

| Situation | Decision | Why |
| --- | --- | --- |
| Never alerted | `send` | The first observation |
| Alerted, inside cooldown | `suppress` | One alert per violation, not per check cycle |
| Alerted, past cooldown, edge unchanged | `suppress` | A persisting violation is one fact, not a new one every 30 minutes |
| Past cooldown, edge ≥ 2× last alerted | `escalate` | Materially different opportunity — staying silent would be the bug |
| Resolved, never followed up | `resolve` | Edits the original message with the lifetime |
| Resolved, already followed up | `suppress` | Terminal |

The cooldown gates escalation too. Without that, an edge oscillating around the
2× line escalates on every check — the noisiest possible failure mode, hit
precisely when the market is most interesting.

At a 60-second cadence a violation lasting an hour would otherwise produce 60
messages. It produces one, plus an escalation if it doubles, plus a resolution.

### Dedup that survives restarts and replicas

State lives in `alert_deliveries`, keyed `violation:<id>` / `digest:<hour>` /
`system:<signal>`, unique on `alert_key`.

**The claim happens before the send, not after.** Two replicas ticking the same
second both reach the same decision; the unique index decides which one sends.
The loser gets a conflict and returns without a message. Doing it the other way
round — send, then record — makes the duplicate the *normal* outcome of a crash
between the two steps.

A send that fails keeps its claim. Retrying every minute against a webhook that
is down converts one outage into a queue of stale alerts that arrive together
when it recovers.

### Escalation compares against what was announced

`last_alert_value` is the edge *of the last message sent*, not the last edge
observed. Comparing against the observed value would let an edge creeping up 10%
per check escalate forever without ever doubling relative to anything a human
saw.

### The hourly digest

Most screened gaps do not survive the spread, and alerting on each would bury
the confirmed ones. [`digest.ts`](src/alerts/digest.ts) batches the
apparent-but-unexecutable ones into one message per hour, grouped by *reason*
rather than listed:

> `37× the spread and fees exceed the mispricing`
> `4× a leg has nothing offered`

Thirty-seven lines are thirty-seven lines; "37×" is a fact about the venue.

It covers the last **complete** hour, keyed by the hour bucket. A digest of a
partial hour would be followed by another for the same hour — the exact
duplication the module exists to prevent. So the job can fire every ten minutes
and five of six calls correctly do nothing.

### System health

[`system.ts`](src/alerts/system.ts) alerts on the pipeline itself, not the
markets:

| Signal | Fires when |
| --- | --- |
| `ingest-stale` | No successful ingest in 30 minutes |
| `rate-limit-spike` | 429s exceed the threshold in the window |
| `queue-depth-growing` | Coherence queue deeper than the floor **and** deeper than last check |
| `gamma-parse-failures` | Share of records failing zod validation exceeds 5% |

Queue depth requires *growth*, not just depth: one check waiting is normal
scheduling, and alerting on depth alone means an alert on every slow run.

The parse-failure signal is the interesting one. It is not about a bad record —
those degrade field-locally by design. A *rate* of parse failures is the early
warning that Polymarket changed their schema, which is the failure mode where
everything downstream keeps running and silently means something else.

### Sending

[`discord.ts`](src/alerts/discord.ts) posts with `?wait=true` — without it
Discord answers `204` with no body and nothing can ever be edited afterwards,
which would make the resolution follow-up impossible. It prefers the float
`retry_after` in a 429 body over the second-granularity header (rounding down
earns a second 429), fails fast on 401/403 rather than burning retries on a
revoked webhook, and treats a 404 on edit as "someone tidied the channel"
rather than an error.

`allowed_mentions: { parse: [] }` on every message. Market questions are
attacker-controlled text — anyone can create a market — so an `@everyone` in one
must not notify the server.

Embed limits are enforced in [`format.ts`](src/alerts/format.ts) and asserted in
tests. Discord rejects an over-long message with a 400, which would mean the
alerts that fail to send are exactly the ones about the wordiest markets.

### Verifying it

```bash
pnpm alerts:drill                      # local mock Discord over real HTTP
pnpm alerts:drill --webhook=<url>      # against a real channel
```

The drill exercises the real `DiscordClient` against a local mock that throttles
once with a 429, then asserts each path fires **exactly** the expected number of
times under repeated triggering:

```
✓ confirmed violation × 20 checks                expected 1, sent 1
✓ below threshold × 10 checks                    expected 0, sent 0
✓ escalation (2× edge) × 19 checks               expected 1, sent 1
✓ 1.5× growth after escalation × 9               expected 0, sent 0
✓ resolution follow-up × 10 checks               expected 1, sent 1
✓ 4 system signals × 8 checks                    expected 4, sent 4
✓ hourly digest × 30 calls in one hour           expected 1, sent 1

ALL PATHS FIRED EXACTLY AS EXPECTED — no duplicates
HTTP requests actually delivered: 8 (counted 8)
```

The last line matters: it counts requests the mock server actually received, so
"sent 1" cannot be satisfied by a transport that quietly dropped the message.

## Dashboard

A public, read-only single-page app at **<https://dutchbook.fly.dev/>**, served
from [`src/dashboard/`](src/dashboard/) as its own Fastify route tree.

Plain HTML, vanilla JS, one charting library. No framework, no build step — and
"no build step" is literal: `tsc` only emits `src/**/*.ts`, so a `public/`
directory would have needed a copy step in the build. The markup, stylesheet and
client are string exports from TypeScript modules instead, served with
content-hash ETags.

| Page | Shows |
| --- | --- |
| Status | Markets tracked, relation edges by source, open violations with net edge and age, last ingest |
| Violations | The last 500 episodes, sortable, with lifetime, peak edge, status and the constraint broken |
| Lifetimes | The lifetime distribution, split apparent/confirmed |
| Families | A ladder or partition with its coherence constraint drawn on it |

### The constraint is drawn, not stated

The family view exists so a violation is *the picture being wrong* rather than a
number you have to check.

A **partition** is a stacked bar against a hard dashed line at 1.00. The bar is
scaled by `max(1, sum) × 1.08`, so when the members sum to more than one the
stack visibly runs past the line — clipping it at 100% width would hide exactly
the case worth seeing.

A **ladder** is one rung per market in entailment order, each with an amber
ceiling mark at the lowest price among the markets it entails — the highest that
market is allowed to be. A rung whose fill crosses its own ceiling is the
violation. Rungs are ordered by Kahn's algorithm, which falls back to price order
on a cycle: the graph rejects cycles on write, but this view renders whatever is
in the database and a layout that hangs on bad data is worse than one that
degrades.

### Public JSON

```
/api/violations?limit=500&status=open|closed|confirmed|apparent
/api/relations?limit=200&source=ladder&type=implies
/api/status   /api/lifetimes   /api/families   /api/families/:key
```

`access-control-allow-origin: *`, because the point of publishing it is that
someone else can build on it and a browser cannot fetch cross-origin without it.
Safe here precisely because there is nothing to authorise: no cookies, no auth,
every route a read.

Limits are **clamped, not rejected** — asking for 10,000 violations returns 500
and a `limit` field saying so, which is more useful than a 400 on a read-only
feed. Every query is bounded, because without authentication one request must
not be able to ask Postgres for the whole catalog.

### Surviving being public

**Stale-while-revalidate, not a TTL cache.** The first version used a plain
10-second TTL and production showed why that fails: the status aggregate scans
~300k markets with no index on `closed`, and on Fly's shared CPU it took between
6 and 25 seconds. When the query is slower than the TTL, *every* request is a
miss — the cache is pure overhead and every visitor waits on Postgres. Now a
stale value is served immediately and the refresh happens behind it; only a cold
cache waits, and the caches are primed at boot so the first visitor is not the
one who pays. Measured on production: 6.7s cold, **90ms after**.

The trade is that the page can show data older than the TTL when the database is
struggling, so the payload carries `generatedAt` and the page renders it —
"Snapshot taken 34s ago". Stale is fine; silently stale is not.

**Nothing is ever assigned to `innerHTML`.** Market questions are
attacker-controlled — anyone can create a market — and this page renders them.
Every value goes in via `textContent`; a test asserts the served client contains
no `innerHTML` assignment, `insertAdjacentHTML`, or `document.write`.

**Gzip via `node:zlib`**, hand-rolled rather than a plugin: 500 episodes is
276KB of JSON, and over mobile data that is worth about twenty times its
compressed size. Measured 276KB → 13.6KB.

The chart library is the one external dependency on the page — Chart.js pinned
to an exact version with a subresource-integrity hash, so the CDN can serve a
different file and the browser will not run it. If it fails to load, the
distribution renders as a list instead of a blank box.

### Legible on a phone

Mobile-first, so the wide layouts are the media query. Below 40rem tables become
cards, each cell keeping its column name via `data-label` — a seven-column table
on a 375px screen is either unreadable or a horizontal scroll nobody discovers.

Verified by rendering, not by inspection. The first attempt at this used
`--window-size=390` on headless Chrome and appeared to show the page overflowing
badly; measuring through the DevTools protocol showed `innerWidth: 500` and
`scrollWidth: 485` — no overflow at all. `--window-size` had produced a 390px
*image* of a 500px viewport, cropping the right edge out of the picture. Under
real device emulation all four pages report `scrollWidth === 390` at 390×844.

That pass did surface one genuine bug: the violations table said "tap a column to
sort", and on a phone `thead` is `display: none`. There were no headers to tap.
There is now a sort control.

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

> **Operational note — the database is undersized.**
> The catalog reached ~300k markets and 1.85 GB, of which 1.29 GB is
> `raw_payloads` (3,177 rows averaging ~400 KB — each archived page carries 100
> events and all their nested markets). The Basic plan (shared 2× CPU, 1 GB RAM)
> crashes under the ingest's sustained upsert load and under any full-table scan
> of `markets`.
>
> `CATALOG_INGEST_ENABLED` is currently **false** in production to keep the
> database up. Before re-enabling it: resize the plan, and add retention to
> `raw_payloads` — at ~400 KB per page and ~1,280 pages per crawl, dedupe only
> helps while the catalog is unchanged, so it will fill the 10 GB volume within
> days of continuous crawling.

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
