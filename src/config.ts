import 'dotenv/config';

import { z } from 'zod';

/**
 * A boolean env var, spelled the way operators spell them.
 *
 * Not `z.coerce.boolean()`: that is `Boolean(value)`, which reads the string
 * `"false"` as true — the exact mistake that leaves a feature switched on in
 * production after someone tried to switch it off.
 */
const booleanFlag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/**
 * Every environment variable the service reads, in one place.
 *
 * Variables without a `.default()` are required — startup fails if they are
 * absent. Keep this schema and `.env.example` in sync.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\/.+/.test(value),
      'must be a postgres:// or postgresql:// connection string',
    ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^rediss?:\/\/.+/.test(value),
      'must be a redis:// or rediss:// connection string',
    ),

  /** Per-dependency budget for the GET /health probes. */
  HEALTHCHECK_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(2_000),

  /** Grace period for in-flight work when SIGTERM/SIGINT arrives. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

  /**
   * Extra grace, on top of `SHUTDOWN_TIMEOUT_MS`, for a running job to finish.
   * A catalog crawl takes minutes, so it needs a budget of its own; the HTTP
   * server's ten seconds would kill one mid-batch every deploy.
   */
  JOB_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(60_000),

  /** Whether this process runs the catalog worker. False for web-only replicas. */
  CATALOG_INGEST_ENABLED: booleanFlag.default(true),

  /**
   * Polymarket Gamma base URL. Overridden to point at a recorded-payload stub
   * for staging and for the crash-recovery drill; never changed in production.
   */
  GAMMA_BASE_URL: z.url().default('https://gamma-api.polymarket.com'),

  /** How often the repeatable catalog ingest fires. */
  CATALOG_INGEST_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),

  /** Hard deadline for one ingest run, after which it is aborted and retried. */
  CATALOG_INGEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(1_200_000),

  /**
   * Markets per transaction. Smaller means a crash loses less work and the
   * recovery run has less to redo; larger amortises round-trips.
   */
  CATALOG_INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(250),

  /** Total attempts per job, including the first. Exhausting them dead-letters it. */
  CATALOG_INGEST_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /** Base delay for the exponential backoff between attempts. */
  CATALOG_INGEST_BACKOFF_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  /**
   * Lifetime of the cross-instance run lock. Renewed continuously while a job
   * runs, so this only bounds how long a crashed instance blocks the next run.
   */
  CATALOG_INGEST_LOCK_TTL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),

  /**
   * Whether the coherence checker runs. Separate from the ingest switch: the
   * checker is far cheaper than a full crawl, so it is worth being able to keep
   * scanning while the catalog crawl is paused.
   */
  COHERENCE_CHECK_ENABLED: booleanFlag.default(true),

  /**
   * How often the coherence check fires. Sixty seconds — fast enough that a
   * violation lasting a couple of minutes is caught with several observations,
   * which is the resolution the lifetime metric needs.
   */
  COHERENCE_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),

  /** Hard deadline for one check. Under the interval, so runs cannot pile up. */
  COHERENCE_CHECK_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(45_000),

  /** Lifetime of the cross-instance coherence lock. */
  COHERENCE_CHECK_LOCK_TTL_MS: z.coerce.number().int().min(5_000).max(600_000).default(90_000),

  /**
   * Screening threshold in probability. Below this a gap is indistinguishable
   * from the venue's tick size, so it is rounding rather than mispricing.
   */
  COHERENCE_EPSILON: z.coerce.number().min(0).max(1).default(0.005),

  /**
   * Constraints promoted to the expensive stage per run, worst first. Caps the
   * order-book spend when a stale quote cache makes everything look violated.
   */
  COHERENCE_MAX_CONFIRMATIONS: z.coerce.number().int().min(1).max(500).default(25),

  // --- market feed ----------------------------------------------------------

  /**
   * Whether stage 1 is driven by the live order-book feed.
   *
   * Off falls back to screening cached Gamma quotes on the schedule, which
   * works and is slow. Worth keeping switchable: the feed is the component most
   * exposed to a vendor protocol change, and a bad deploy should be one env var
   * from the old behaviour rather than a rollback.
   */
  MARKET_FEED_ENABLED: booleanFlag.default(true),

  /** Assets per websocket. A blast-radius limit, not a venue limit. */
  MARKET_FEED_SHARD_SIZE: z.coerce.number().int().min(1).max(25_000).default(2_500),

  /** Heartbeat cadence. The venue answers `PING` with `PONG`. */
  MARKET_FEED_PING_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),

  /**
   * Silence after which a connection is presumed dead and recycled. Must exceed
   * the ping interval by enough that one lost PONG is not a reconnect.
   */
  MARKET_FEED_STALE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),

  /** How often a slice of books is compared against fresh REST snapshots. */
  MARKET_FEED_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),

  /**
   * Books per reconciliation pass.
   *
   * Sized from measurement, not caution. Book drift is not a rare anomaly: about
   * 1% of hash-gated comparisons find a book that missed an update, and the rate
   * scales with subscription size. So the sweep period is a correctness
   * parameter — it bounds how long a drifted book can price stage 1 — rather
   * than a safety net for a bug that should not happen. This pair sweeps a
   * 12,500-token feed end to end in about 2.5 minutes, for 25 requests every 30
   * seconds against a 50/s ceiling on `POST /books`.
   */
  MARKET_FEED_RECONCILE_BATCH: z.coerce.number().int().min(1).max(20_000).default(2_500),

  /**
   * Debounce between a book update and re-screening the constraints it touches.
   * Long enough that a burst of levels on one market is one evaluation, short
   * enough to stay irrelevant against the five-second detection target.
   */
  MARKET_FEED_SCREEN_DEBOUNCE_MS: z.coerce.number().int().min(10).max(10_000).default(250),

  /**
   * Floor between feed-triggered confirmations. Detections arrive in bursts when
   * a whole event re-prices; without this each one would queue its own check.
   */
  MARKET_FEED_TRIGGER_COOLDOWN_MS: z.coerce.number().int().min(0).max(600_000).default(5_000),

  /**
   * How often the subscription is rebuilt from the constraint graph. New markets
   * arrive with the ten-minute ingest, and the asset set cannot be changed on a
   * live socket, so picking them up means reconnecting.
   */
  MARKET_FEED_REFRESH_INTERVAL_MS: z.coerce.number().int().min(60_000).default(900_000),

  // --- alerting -------------------------------------------------------------

  /**
   * Discord incoming webhook. Absent means alerts are logged rather than sent,
   * so every threshold and dedup rule still runs and is observable.
   */
  DISCORD_WEBHOOK_URL: z.url().optional(),

  /**
   * Minimum gap between two messages about the same thing. Gates escalations
   * too — see `src/alerts/dedupe.ts`.
   */
  ALERT_COOLDOWN_MS: z.coerce.number().int().min(0).max(86_400_000).default(1_800_000),

  /** Growth factor that justifies breaking the cooldown silence. */
  ALERT_ESCALATION_FACTOR: z.coerce.number().min(1).max(100).default(2),

  /** Floors a confirmed violation must clear to be worth a notification. */
  ALERT_MIN_NET_EDGE: z.coerce.number().min(0).max(1).default(0.01),
  ALERT_MIN_NET_PROFIT: z.coerce.number().min(0).default(5),

  /**
   * How far back to look for resolutions still needing a follow-up. Bounded so
   * that switching alerting on does not replay months of history.
   */
  ALERT_RESOLUTION_LOOKBACK_MS: z.coerce.number().int().min(60_000).default(86_400_000),

  /** Ingest silence that counts as broken. */
  ALERT_INGEST_STALE_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  /** Rate-limit responses per window that count as a spike. */
  ALERT_RATE_LIMIT_HITS: z.coerce.number().int().min(1).default(50),
  ALERT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(60_000).default(600_000),
  /** Coherence queue depth beyond which growth is a problem. */
  ALERT_QUEUE_DEPTH: z.coerce.number().int().min(1).default(5),
  /** Share of Gamma records with a parse issue that counts as a schema change. */
  ALERT_PARSE_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.05),
});

type Env = z.infer<typeof envSchema>;

export type Config = Readonly<
  Env & {
    isProduction: boolean;
    isDevelopment: boolean;
    isTest: boolean;
  }
>;

/** Thrown when the environment is unusable. Lists every problem at once. */
export class ConfigError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(message: string, missing: readonly string[], invalid: readonly string[]) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

function describeProblems(
  error: z.ZodError<unknown>,
  env: NodeJS.ProcessEnv,
): { missing: string[]; invalid: string[]; message: string } {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const issue of error.issues) {
    const name = issue.path.map(String).join('.');
    if (name === '') {
      invalid.push(`  (environment): ${issue.message}`);
      continue;
    }

    // Treat unset and empty-string alike: both mean "the operator didn't set it".
    const raw = env[name];
    if (raw === undefined || raw === '') {
      missing.push(name);
    } else {
      invalid.push(`  ${name}=${JSON.stringify(raw)} — ${issue.message}`);
    }
  }

  const sections: string[] = ['Invalid environment configuration.'];
  if (missing.length > 0) {
    sections.push(
      '',
      `Missing required variable${missing.length === 1 ? '' : 's'} (${missing.length}):`,
      ...missing.map((name) => `  ${name}`),
    );
  }
  if (invalid.length > 0) {
    sections.push(
      '',
      `Invalid value${invalid.length === 1 ? '' : 's'} (${invalid.length}):`,
      ...invalid,
    );
  }
  sections.push('', 'See .env.example for the full list of supported variables.');

  return { missing, invalid, message: sections.join('\n') };
}

/**
 * Validate an environment. Reports *all* problems in a single throw so the
 * operator fixes them in one pass instead of one restart per variable.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const { missing, invalid, message } = describeProblems(result.error, env);
    throw new ConfigError(message, missing, invalid);
  }

  const parsed = result.data;
  return Object.freeze({
    ...parsed,
    isProduction: parsed.NODE_ENV === 'production',
    isDevelopment: parsed.NODE_ENV === 'development',
    isTest: parsed.NODE_ENV === 'test',
  });
}

/** Parsed eagerly: importing this module in a bad environment fails fast. */
export const config: Config = parseConfig();
