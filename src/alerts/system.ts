import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { decide, type DedupeOptions } from './dedupe.js';
import type { AlertTransport } from './discord.js';
import { formatSystemAlert, humanDuration, type SystemSeverity } from './format.js';
import { claim, loadDelivery, recordResend } from './store.js';

/**
 * Health alerting for the service itself.
 *
 * Market alerts tell you the system is working. These tell you it is not — and
 * the failure mode they exist for is the quiet one, where the checker keeps
 * reporting "0 confirmed" every minute because the ingest died four hours ago
 * and every price it screens is stale. A scanner that has stopped scanning
 * looks exactly like a market with no opportunities.
 *
 * Every signal is a pure function of a snapshot, so the thresholds can be
 * tested at their boundaries without waiting for a clock or breaking anything.
 */

const log = createLogger('alerts:system');

type Database = PostgresJsDatabase<typeof schema>;

export type SystemSignalName =
  | 'ingest-stale'
  | 'rate-limit-spike'
  | 'queue-depth-growing'
  | 'gamma-parse-failures';

export interface SystemThresholds {
  /** Ingest silence that counts as broken. Default 30 minutes. */
  readonly ingestStaleMs: number;
  /** Rate-limit responses within the window that count as a spike. */
  readonly rateLimitHits: number;
  readonly rateLimitWindowMs: number;
  /** Queue depth beyond which growth is a problem rather than a burst. */
  readonly queueDepth: number;
  /** Fraction of Gamma records with a parse issue that counts as a spike. */
  readonly parseFailureRate: number;
  /** Records below which a rate is too small a sample to alert on. */
  readonly parseFailureMinSample: number;
}

export const DEFAULT_SYSTEM_THRESHOLDS: SystemThresholds = {
  ingestStaleMs: 30 * 60 * 1000,
  rateLimitHits: 50,
  rateLimitWindowMs: 10 * 60 * 1000,
  queueDepth: 5,
  parseFailureRate: 0.05,
  parseFailureMinSample: 200,
};

/**
 * Everything the health signals read, gathered once.
 *
 * A snapshot rather than four separate probes because the signals are compared
 * against *each other* by whoever reads the alert — "the queue is backing up
 * and the ingest is stale" is one incident, and two readings taken a minute
 * apart would invite the wrong conclusion.
 */
export interface SystemSnapshot {
  readonly at: Date;
  /** Last successful catalog ingest, or null if there has never been one. */
  readonly lastIngestSuccessAt: Date | null;
  /** Cumulative rate-limit responses; deltas are taken against the last sample. */
  readonly rateLimitHitsTotal: number;
  /** Waiting + delayed jobs on the coherence queue. */
  readonly coherenceQueueDepth: number;
  /** Cumulative Gamma records seen and records with at least one parse issue. */
  readonly gammaRecordsTotal: number;
  readonly gammaParseIssuesTotal: number;
}

/** The previous snapshot, for the signals that are about *change*. */
export interface SystemSample {
  readonly at: Date;
  readonly rateLimitHitsTotal: number;
  readonly coherenceQueueDepth: number;
  readonly gammaRecordsTotal: number;
  readonly gammaParseIssuesTotal: number;
}

export interface SystemFinding {
  readonly name: SystemSignalName;
  readonly severity: SystemSeverity;
  readonly title: string;
  readonly detail: string;
  readonly facts: ReadonlyArray<{ name: string; value: string }>;
  /** Scalar the escalation rule compares, when the signal has a magnitude. */
  readonly value: number | null;
}

/**
 * Evaluates every health signal. Pure.
 *
 * Counters are cumulative, so three of the four signals are meaningless without
 * a previous sample — a process that has just started has seen zero rate-limit
 * hits *because it just started*, not because everything is fine. Those return
 * nothing until there is something to compare against, which is why the first
 * run after a deploy is quiet rather than wrong.
 */
export function evaluateSystem(
  snapshot: SystemSnapshot,
  previous: SystemSample | null,
  thresholds: SystemThresholds = DEFAULT_SYSTEM_THRESHOLDS,
): SystemFinding[] {
  const findings: SystemFinding[] = [];

  // --- ingest staleness: absolute, so no previous sample is needed ----------
  if (snapshot.lastIngestSuccessAt === null) {
    // Silent on purpose. A service that has never ingested is either brand new
    // or has the crawl switched off, and neither is an incident.
  } else {
    const silentMs = snapshot.at.getTime() - snapshot.lastIngestSuccessAt.getTime();
    if (silentMs > thresholds.ingestStaleMs) {
      findings.push({
        name: 'ingest-stale',
        severity: 'critical',
        title: `Catalog ingest silent for ${humanDuration(silentMs)}`,
        detail:
          'No ingest has succeeded within the alerting window. Every price the coherence ' +
          'screen reads is going stale, so "no violations found" stops meaning anything.',
        facts: [
          { name: 'Last success', value: snapshot.lastIngestSuccessAt.toISOString() },
          { name: 'Silent for', value: humanDuration(silentMs) },
          { name: 'Threshold', value: humanDuration(thresholds.ingestStaleMs) },
        ],
        value: silentMs,
      });
    }
  }

  if (previous === null) return findings;

  const elapsedMs = snapshot.at.getTime() - previous.at.getTime();
  if (elapsedMs <= 0) return findings;

  // --- rate limiting: a delta over a window --------------------------------
  const hitDelta = Math.max(0, snapshot.rateLimitHitsTotal - previous.rateLimitHitsTotal);
  // Normalised to the configured window so the threshold means the same thing
  // regardless of how often this happens to run.
  const hitsPerWindow = (hitDelta / elapsedMs) * thresholds.rateLimitWindowMs;

  if (hitsPerWindow > thresholds.rateLimitHits) {
    findings.push({
      name: 'rate-limit-spike',
      severity: 'warning',
      title: `Rate limited ${hitsPerWindow.toFixed(0)}× per ${humanDuration(thresholds.rateLimitWindowMs)}`,
      detail:
        'Polymarket is throttling us harder than usual. The budget is shared per-IP across ' +
        'every caller, so this can be someone else consuming it rather than a change here.',
      facts: [
        { name: 'Hits in sample', value: String(hitDelta) },
        { name: 'Sample length', value: humanDuration(elapsedMs) },
        { name: 'Threshold', value: `${thresholds.rateLimitHits} per window` },
      ],
      value: hitsPerWindow,
    });
  }

  // --- queue depth: growing, not merely deep -------------------------------
  //
  // Both conditions are required. A deep queue that is draining is a burst
  // being absorbed, which is the system working; a shallow queue that grew by
  // one is noise. Only deep *and* growing means work is arriving faster than it
  // can be done, which at a 60-second cadence means checks are being skipped.
  if (
    snapshot.coherenceQueueDepth > thresholds.queueDepth &&
    snapshot.coherenceQueueDepth > previous.coherenceQueueDepth
  ) {
    findings.push({
      name: 'queue-depth-growing',
      severity: 'warning',
      title: `Coherence queue growing: ${previous.coherenceQueueDepth} → ${snapshot.coherenceQueueDepth}`,
      detail:
        'Checks are being enqueued faster than they complete. At a 60-second schedule this ' +
        'means runs are overrunning their interval, and violations are going unexamined.',
      facts: [
        { name: 'Depth now', value: String(snapshot.coherenceQueueDepth) },
        { name: 'Depth before', value: String(previous.coherenceQueueDepth) },
        { name: 'Threshold', value: String(thresholds.queueDepth) },
      ],
      value: snapshot.coherenceQueueDepth,
    });
  }

  // --- Gamma parse failures: the vendor-changed-their-schema alarm ----------
  //
  // The most valuable signal here. Field-local degradation means a schema change
  // does not crash anything — records keep flowing with fields quietly nulled —
  // so the *only* symptom of the vendor renaming a field is this rate moving.
  const recordDelta = snapshot.gammaRecordsTotal - previous.gammaRecordsTotal;
  const issueDelta = Math.max(0, snapshot.gammaParseIssuesTotal - previous.gammaParseIssuesTotal);

  if (recordDelta >= thresholds.parseFailureMinSample) {
    const rate = issueDelta / recordDelta;
    if (rate > thresholds.parseFailureRate) {
      findings.push({
        name: 'gamma-parse-failures',
        severity: 'critical',
        title: `Gamma parse failures at ${(rate * 100).toFixed(1)}%`,
        detail:
          'Records are arriving in a shape the schemas do not fully understand. Because ' +
          'degradation is field-local, nothing has crashed and nothing will — the fields are ' +
          'simply being nulled. This is the early warning that the vendor changed something.',
        facts: [
          { name: 'Issues', value: String(issueDelta) },
          { name: 'Records', value: String(recordDelta) },
          { name: 'Rate', value: `${(rate * 100).toFixed(2)}%` },
          { name: 'Threshold', value: `${(thresholds.parseFailureRate * 100).toFixed(1)}%` },
        ],
        value: rate,
      });
    }
  }

  return findings;
}

/** `system:{name}` — one long-lived key per signal. */
export function systemKey(name: SystemSignalName): string {
  return `system:${name}`;
}

export interface SystemAlertOutcome {
  readonly sent: number;
  readonly escalated: number;
  readonly suppressed: number;
  readonly failed: number;
}

/**
 * Sends whatever the evaluation found, subject to the same dedup as everything else.
 *
 * A condition that stays true — an ingest that has been dead for hours — sends
 * once, then again only when the cooldown has elapsed, because unlike a market
 * violation it will not resolve itself and a periodic reminder is wanted. That
 * difference is expressed by passing `value: null` for signals with no
 * magnitude, which `decide` treats as "re-send on cooldown".
 */
export async function alertSystem(
  findings: readonly SystemFinding[],
  transport: AlertTransport,
  options: DedupeOptions,
  database: Database = db,
  now: Date = new Date(),
): Promise<SystemAlertOutcome> {
  let sent = 0;
  let suppressed = 0;
  let failed = 0;

  for (const finding of findings) {
    const key = systemKey(finding.name);
    const state = await loadDelivery(key, database);
    // Health signals are re-sent on cooldown rather than only on growth, so
    // they carry no comparison value.
    const decision = decide({ state, value: null, resolved: false, now }, options);

    if (decision === 'suppress') {
      suppressed += 1;
      continue;
    }

    const message = formatSystemAlert({
      name: finding.name,
      title: finding.title,
      detail: finding.detail,
      severity: finding.severity,
      facts: finding.facts,
      at: now,
    });

    try {
      if (state === null) {
        const won = await claim(key, 'system', now, null, database);
        if (!won) {
          suppressed += 1;
          continue;
        }
        await transport.send(message);
        sent += 1;
      } else {
        await transport.send(message);
        await recordResend(key, now, null, message, false, database);
        sent += 1;
      }
      log.warn({ signal: finding.name, severity: finding.severity }, 'system alert sent');
    } catch (error) {
      failed += 1;
      log.error({ signal: finding.name, error: describeError(error) }, 'system alert failed');
    }
  }

  return { sent, escalated: 0, suppressed, failed };
}
