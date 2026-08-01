/**
 * Prometheus metrics, in the text exposition format.
 *
 * Hand-rolled rather than pulled from a library: the surface is one registry,
 * three metric types, and a formatter, and keeping it here means the exact
 * bytes on the wire are covered by tests rather than by a dependency's.
 *
 * Counters are per-process and reset on restart, which is what Prometheus
 * expects — `rate()` handles the reset. Values that must be true across
 * restarts (markets tracked, last successful ingest) are gauges read from
 * Postgres and Redis at scrape time instead.
 */

export type LabelValues = Readonly<Record<string, string | number>>;

/** Escapes a HELP line: backslash and newline only, per the exposition format. */
function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Escapes a label value: backslash, double quote, and newline. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Renders `{a="1",b="2"}`, or the empty string when unlabelled.
 *
 * Keys are sorted so a series has one stable identity regardless of the order
 * the caller happened to pass them in.
 */
function renderLabels(labels: LabelValues, extra?: readonly [string, string]): string {
  const pairs = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]): [string, string] => [key, escapeLabelValue(String(value))])
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (extra !== undefined) pairs.push([extra[0], escapeLabelValue(extra[1])]);
  if (pairs.length === 0) return '';

  return `{${pairs.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
}

/** A number as Prometheus writes it: `+Inf`, `-Inf`, `NaN`, else plain. */
function renderValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

abstract class Metric {
  readonly name: string;
  readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  abstract readonly type: 'counter' | 'gauge' | 'histogram';
  /** Sample lines, without the HELP/TYPE header. */
  abstract samples(): string[];

  render(): string {
    const lines = this.samples();
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`, ...lines].join(
      '\n',
    );
  }
}

/** A monotonically increasing count. */
export class Counter extends Metric {
  override readonly type = 'counter' as const;
  readonly #values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(name: string, help: string, initialLabels: readonly LabelValues[] = []) {
    super(name, help);
    // Seeding a series at zero makes `rate()` correct from the first scrape,
    // instead of the metric appearing only once something has gone wrong.
    for (const labels of initialLabels) this.inc(labels, 0);
  }

  inc(labels: LabelValues = {}, amount = 1): void {
    const key = renderLabels(labels);
    const existing = this.#values.get(key);
    if (existing === undefined) this.#values.set(key, { labels, value: amount });
    else existing.value += amount;
  }

  get(labels: LabelValues = {}): number {
    return this.#values.get(renderLabels(labels))?.value ?? 0;
  }

  override samples(): string[] {
    return [...this.#values.values()].map(
      ({ labels, value }) => `${this.name}${renderLabels(labels)} ${renderValue(value)}`,
    );
  }

  reset(): void {
    this.#values.clear();
  }
}

/** A value that can go up or down, set at scrape time. */
export class Gauge extends Metric {
  override readonly type = 'gauge' as const;
  readonly #values = new Map<string, { labels: LabelValues; value: number }>();

  set(value: number, labels: LabelValues = {}): void {
    this.#values.set(renderLabels(labels), { labels, value });
  }

  /** Drops the series entirely, so a value we cannot read is absent rather
   * than reported as a stale or invented zero. */
  clear(labels: LabelValues = {}): void {
    this.#values.delete(renderLabels(labels));
  }

  get(labels: LabelValues = {}): number | undefined {
    return this.#values.get(renderLabels(labels))?.value;
  }

  override samples(): string[] {
    return [...this.#values.values()].map(
      ({ labels, value }) => `${this.name}${renderLabels(labels)} ${renderValue(value)}`,
    );
  }

  reset(): void {
    this.#values.clear();
  }
}

interface HistogramSeries {
  labels: LabelValues;
  counts: number[];
  sum: number;
  count: number;
}

/** Cumulative buckets, plus `_sum` and `_count`. */
export class Histogram extends Metric {
  override readonly type = 'histogram' as const;
  readonly #buckets: readonly number[];
  readonly #series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, buckets: readonly number[]) {
    super(name, help);
    this.#buckets = buckets.toSorted((a, b) => a - b);
  }

  observe(value: number, labels: LabelValues = {}): void {
    const key = renderLabels(labels);
    let series = this.#series.get(key);

    if (series === undefined) {
      const counts = Array.from({ length: this.#buckets.length }, () => 0);
      series = { labels, counts, sum: 0, count: 0 };
      this.#series.set(key, series);
    }

    for (const [index, bound] of this.#buckets.entries()) {
      if (value <= bound) series.counts[index] = (series.counts[index] ?? 0) + 1;
    }
    series.sum += value;
    series.count += 1;
  }

  override samples(): string[] {
    const lines: string[] = [];

    for (const series of this.#series.values()) {
      let cumulative = 0;
      for (const [index, bound] of this.#buckets.entries()) {
        // Buckets are cumulative: each is "how many observations were <= bound".
        cumulative = series.counts[index] ?? 0;
        lines.push(
          `${this.name}_bucket${renderLabels(series.labels, ['le', renderValue(bound)])} ${renderValue(cumulative)}`,
        );
      }
      lines.push(
        `${this.name}_bucket${renderLabels(series.labels, ['le', '+Inf'])} ${renderValue(series.count)}`,
        `${this.name}_sum${renderLabels(series.labels)} ${renderValue(series.sum)}`,
        `${this.name}_count${renderLabels(series.labels)} ${renderValue(series.count)}`,
      );
    }

    return lines;
  }

  reset(): void {
    this.#series.clear();
  }
}

// ---------------------------------------------------------------------------
// The metrics themselves
// ---------------------------------------------------------------------------

/** Catalog ingest runs, by outcome. `skipped` means another replica held the lock. */
export const ingestRuns = new Counter(
  'ingest_runs_total',
  'Catalog ingest runs, by outcome.',
  [{ result: 'success' }, { result: 'failure' }, { result: 'skipped' }],
);

/**
 * Errors *within* runs — a payload that could not be archived, a record with no
 * condition id. A run can complete successfully with a non-zero error count, so
 * this is not the same as `ingest_runs_total{result="failure"}`.
 */
export const ingestErrors = new Counter(
  'ingest_errors_total',
  'Non-fatal errors encountered during catalog ingest runs.',
  [{ kind: 'run' }, { kind: 'record' }],
);

/** Buckets spanning a fast incremental crawl to one that is in trouble. */
export const ingestDuration = new Histogram(
  'ingest_duration_seconds',
  'Wall-clock duration of a catalog ingest run.',
  [1, 5, 10, 30, 60, 120, 300, 600, 1_200],
);

export const revisionsWritten = new Counter(
  'revisions_written_total',
  'Market revision rows written — one per field per detected upstream edit.',
  [{}],
);

export const marketsSeen = new Counter(
  'ingest_markets_total',
  'Markets processed by ingest runs, by what happened to each.',
  [
    { outcome: 'created' },
    { outcome: 'updated' },
    { outcome: 'unchanged' },
    { outcome: 'skipped' },
  ],
);

export const apiRequests = new Counter(
  'api_requests_total',
  'HTTP requests served, by method and response status code.',
);

/**
 * Times the Gamma client was throttled — a 429, or a 5xx it had to back off
 * from. Polymarket's budget is global across all callers, so this rising
 * without our own rate changing means someone else is using it up.
 */
export const rateLimitHits = new Counter(
  'rate_limit_hits_total',
  'Responses from Polymarket that forced a backoff, by status.',
);

export const marketsTracked = new Gauge(
  'markets_tracked',
  'Markets currently in the catalog, excluding those flagged missing.',
);

export const marketsMissing = new Gauge(
  'markets_missing',
  'Markets a complete crawl no longer returns, still retained.',
);

export const revisionsTotal = new Gauge(
  'revisions_stored',
  'Market revision rows in the database, across all time.',
);

export const lastIngestSuccess = new Gauge(
  'ingest_last_success_timestamp_seconds',
  'Unix time of the last successful catalog ingest, from shared state.',
);

export const buildInfo = new Gauge(
  'dutchbook_build_info',
  'Build metadata. Always 1; the labels carry the information.',
);

/**
 * Gamma records seen, and records that carried at least one parse issue.
 *
 * The pair exists so a *rate* can be computed. Field-local degradation means a
 * vendor schema change never crashes anything — records keep flowing with the
 * changed field quietly nulled — so the ratio between these two counters is the
 * only symptom there is.
 */
export const gammaRecords = new Counter(
  'gamma_records_total',
  'Gamma records parsed, by kind.',
  [{ kind: 'market' }, { kind: 'event' }],
);

export const gammaParseIssues = new Counter(
  'gamma_parse_issues_total',
  'Gamma records where at least one field failed to parse and was nulled.',
  [{ kind: 'market' }, { kind: 'event' }],
);

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const alertsSent = new Counter(
  'alerts_sent_total',
  'Alert messages delivered, by kind.',
  [{ kind: 'violation' }, { kind: 'escalation' }, { kind: 'resolution' }, { kind: 'system' }, { kind: 'digest' }],
);

/** Alerts the dedup withheld. High is healthy; it means repeats are working. */
export const alertsSuppressed = new Counter(
  'alerts_suppressed_total',
  'Alerts withheld by deduplication, cooldown, or threshold.',
  [{ reason: 'dedupe' }, { reason: 'threshold' }],
);

export const alertsFailed = new Counter(
  'alerts_failed_total',
  'Alerts that could not be delivered.',
  [{}],
);

// ---------------------------------------------------------------------------
// Coherence
// ---------------------------------------------------------------------------

export const coherenceRuns = new Counter(
  'coherence_runs_total',
  'Coherence check runs, by outcome.',
  [{ result: 'success' }, { result: 'failure' }, { result: 'skipped' }],
);

/** Buckets spanning a screen that found nothing to one that confirmed many. */
export const coherenceDuration = new Histogram(
  'coherence_duration_seconds',
  'Wall-clock duration of one coherence check.',
  [0.5, 1, 2, 5, 10, 20, 45, 90],
);

export const constraintsEvaluated = new Gauge(
  'coherence_constraints_evaluated',
  'Constraints evaluated by the cheap screen on the last run.',
);

export const violationsScreened = new Gauge(
  'coherence_violations_screened',
  'Constraints the last screen found violated beyond epsilon, before confirmation.',
);

/**
 * Confirmed violations *opened*, cumulatively. A counter rather than a gauge
 * because the interesting question is how many real opportunities have ever
 * appeared, not how many happen to be open at this instant.
 */
export const violationsConfirmed = new Counter(
  'coherence_violations_confirmed_total',
  'Violations confirmed executable, cumulative.',
  [{}],
);

export const violationsOpen = new Gauge(
  'coherence_violations_open',
  'Confirmed violations currently open.',
);

/** The headline. Null until a confirmed episode has closed, so it starts at -1. */
export const violationLifetimeMedian = new Gauge(
  'coherence_violation_lifetime_median_seconds',
  'Median lifetime of closed confirmed violations. -1 before any have closed.',
);

const ALL_METRICS: readonly Metric[] = [
  ingestRuns,
  ingestErrors,
  ingestDuration,
  revisionsWritten,
  marketsSeen,
  apiRequests,
  rateLimitHits,
  marketsTracked,
  marketsMissing,
  revisionsTotal,
  lastIngestSuccess,
  buildInfo,
  coherenceRuns,
  coherenceDuration,
  constraintsEvaluated,
  violationsScreened,
  violationsConfirmed,
  violationsOpen,
  violationLifetimeMedian,
  gammaRecords,
  gammaParseIssues,
  alertsSent,
  alertsSuppressed,
  alertsFailed,
];

/**
 * Runs before a scrape to refresh gauges that live outside this process.
 * Returning without setting a gauge leaves it absent, which is the honest
 * answer when the source could not be read.
 */
export type MetricsCollector = () => Promise<void>;

/** Renders the whole registry. Ends with a newline, as the format requires. */
export async function renderMetrics(collect?: MetricsCollector): Promise<string> {
  if (collect !== undefined) await collect();

  const blocks = ALL_METRICS.map((metric) => metric.render()).filter(
    // A metric with no series at all is omitted rather than emitted as a bare
    // header, which some parsers reject.
    (block) => block.split('\n').length > 2,
  );

  return `${blocks.join('\n\n')}\n`;
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Test helper: drops every recorded sample. */
export function resetMetrics(): void {
  for (const metric of ALL_METRICS) {
    (metric as { reset?: () => void }).reset?.();
  }
}
