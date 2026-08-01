import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Counter,
  Gauge,
  Histogram,
  METRICS_CONTENT_TYPE,
  apiRequests,
  ingestDuration,
  ingestErrors,
  ingestRuns,
  marketsTracked,
  rateLimitHits,
  renderMetrics,
  resetMetrics,
  revisionsWritten,
} from '../src/metrics.js';
import { buildServer } from '../src/server.js';

/**
 * The exposition format is a contract with a scraper that will not tell us when
 * we break it — a malformed line is silently dropped, and the dashboard just
 * goes flat. So the assertions here are on exact bytes, not on shape.
 */

const up = async (): Promise<void> => {};

let app: FastifyInstance | undefined;

beforeEach(() => {
  resetMetrics();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  resetMetrics();
});

describe('exposition format', () => {
  it('writes a counter with its HELP and TYPE header', () => {
    const counter = new Counter('widgets_total', 'Widgets produced.');
    counter.inc();
    counter.inc({}, 4);

    expect(counter.render()).toBe(
      ['# HELP widgets_total Widgets produced.', '# TYPE widgets_total counter', 'widgets_total 5'].join(
        '\n',
      ),
    );
  });

  it('sorts label keys so a series has one identity', () => {
    const counter = new Counter('reqs_total', 'Requests.');
    counter.inc({ status: 200, method: 'GET' });
    // Same labels, different order — must land on the same series.
    counter.inc({ method: 'GET', status: 200 });

    expect(counter.samples()).toEqual(['reqs_total{method="GET",status="200"} 2']);
  });

  it('escapes label values and help text', () => {
    const counter = new Counter('escaped_total', 'A "quoted" help\nwith a newline and a \\ slash.');
    counter.inc({ path: 'a "b"\\c\nd' });

    const rendered = counter.render();
    expect(rendered).toContain(
      '# HELP escaped_total A "quoted" help\\nwith a newline and a \\\\ slash.',
    );
    expect(rendered).toContain('escaped_total{path="a \\"b\\"\\\\c\\nd"} 1');
    // The sample line must not contain a raw newline inside the label value.
    expect(rendered.split('\n')).toHaveLength(3);
  });

  it('seeds declared label sets at zero so rate() works from the first scrape', () => {
    const counter = new Counter('seeded_total', 'Seeded.', [{ result: 'ok' }, { result: 'bad' }]);

    expect(counter.samples()).toEqual([
      'seeded_total{result="ok"} 0',
      'seeded_total{result="bad"} 0',
    ]);
  });

  it('writes cumulative histogram buckets, with +Inf, sum and count', () => {
    const histogram = new Histogram('job_seconds', 'Job duration.', [1, 5, 10]);
    histogram.observe(0.5);
    histogram.observe(3);
    histogram.observe(30);

    expect(histogram.samples()).toEqual([
      'job_seconds_bucket{le="1"} 1',
      'job_seconds_bucket{le="5"} 2',
      'job_seconds_bucket{le="10"} 2',
      'job_seconds_bucket{le="+Inf"} 3',
      'job_seconds_sum 33.5',
      'job_seconds_count 3',
    ]);
  });

  it('keeps histogram buckets monotonically non-decreasing', () => {
    const histogram = new Histogram('h_seconds', 'H.', [10, 1, 5]); // deliberately unsorted
    for (const value of [0.1, 2, 7, 100]) histogram.observe(value);

    const counts = histogram
      .samples()
      .filter((line) => line.includes('_bucket'))
      .map((line) => Number(line.split(' ')[1]));

    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
    expect(counts.at(-1)).toBe(4);
  });

  it('renders gauges, and drops a series it cannot read rather than inventing a zero', () => {
    const gauge = new Gauge('tracked', 'Tracked things.');
    gauge.set(42);
    expect(gauge.samples()).toEqual(['tracked 42']);

    gauge.clear();
    expect(gauge.samples()).toEqual([]);
  });

  it('renders the non-finite values Prometheus defines', () => {
    const gauge = new Gauge('odd', 'Odd.');
    gauge.set(Number.POSITIVE_INFINITY, { k: 'inf' });
    gauge.set(Number.NaN, { k: 'nan' });

    expect(gauge.samples()).toEqual(['odd{k="inf"} +Inf', 'odd{k="nan"} NaN']);
  });
});

describe('renderMetrics', () => {
  it('omits metrics that have no samples, and ends with a newline', async () => {
    marketsTracked.set(120);
    const body = await renderMetrics();

    expect(body.endsWith('\n')).toBe(true);
    expect(body).toContain('# TYPE markets_tracked gauge');
    expect(body).toContain('markets_tracked 120');
    // No series recorded, so no bare header is emitted.
    expect(body).not.toContain('# TYPE api_requests_total');
  });

  it('every non-comment line parses as `name{labels?} value`', async () => {
    ingestRuns.inc({ result: 'success' });
    ingestDuration.observe(12.5);
    apiRequests.inc({ method: 'GET', status: 200 });
    marketsTracked.set(9);

    const body = await renderMetrics();

    for (const line of body.split('\n').filter((l) => l !== '' && !l.startsWith('#'))) {
      expect(line, `unparseable line: ${line}`).toMatch(
        /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?([0-9.eE+-]+|\+Inf|-Inf|NaN)$/,
      );
    }
  });

  it('declares every metric name exactly once', async () => {
    ingestRuns.inc({ result: 'success' });
    apiRequests.inc({ method: 'GET', status: 200 });

    const body = await renderMetrics();
    const declared = body.split('\n').filter((line) => line.startsWith('# TYPE'));

    expect(new Set(declared).size).toBe(declared.length);
  });

  it('runs the collector before rendering', async () => {
    const body = await renderMetrics(async () => {
      marketsTracked.set(777);
    });

    expect(body).toContain('markets_tracked 777');
  });
});

describe('GET /metrics', () => {
  async function scrape(collector = async (): Promise<void> => {}) {
    app = buildServer({
      probes: { postgres: up, redis: up },
      jobStats: async () => ({
        queue: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        deadLettered: 0,
        lastSuccessAt: null,
        lastFailure: null,
      }),
      metricsCollector: collector,
    });
    await app.ready();
    return app.inject({ method: 'GET', url: '/metrics' });
  }

  it('serves the Prometheus content type', async () => {
    const res = await scrape();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(METRICS_CONTENT_TYPE);
  });

  it('exposes every metric the deployment is required to publish', async () => {
    ingestRuns.inc({ result: 'success' });
    ingestErrors.inc({ kind: 'record' }, 2);
    ingestDuration.observe(41.2);
    revisionsWritten.inc({}, 3);
    rateLimitHits.inc({ status: 429 });
    apiRequests.inc({ method: 'GET', status: 200 });

    const res = await scrape(async () => {
      marketsTracked.set(9188);
    });

    for (const name of [
      'ingest_runs_total',
      'ingest_errors_total',
      'ingest_duration_seconds',
      'markets_tracked',
      'revisions_written_total',
      'api_requests_total',
      'rate_limit_hits_total',
    ]) {
      expect(res.body, `${name} missing from /metrics`).toContain(`# TYPE ${name}`);
    }

    expect(res.body).toContain('ingest_runs_total{result="success"} 1');
    expect(res.body).toContain('revisions_written_total 3');
    expect(res.body).toContain('rate_limit_hits_total{status="429"} 1');
    expect(res.body).toContain('markets_tracked 9188');
    expect(res.body).toContain('ingest_duration_seconds_count 1');
  });

  it('counts served requests by method and status code', async () => {
    app = buildServer({
      probes: { postgres: up, redis: up },
      jobStats: async () => ({
        queue: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        deadLettered: 0,
        lastSuccessAt: null,
        lastFailure: null,
      }),
      metricsCollector: async () => {},
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/nope' });

    expect(apiRequests.get({ method: 'GET', status: 200 })).toBe(2);
    expect(apiRequests.get({ method: 'GET', status: 404 })).toBe(1);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('api_requests_total{method="GET",status="200"} 2');
    expect(res.body).toContain('api_requests_total{method="GET",status="404"} 1');
  });

  it('still serves what it can when a collector source is down', async () => {
    apiRequests.inc({ method: 'GET', status: 200 });

    const res = await scrape(async () => {
      // Mirrors the real collector: a failed read clears its own gauges only.
      marketsTracked.clear();
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('api_requests_total');
    expect(res.body).not.toContain('markets_tracked ');
  });
});
