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
