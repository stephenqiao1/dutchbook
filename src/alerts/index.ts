import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { CheckResult } from '../coherence/check.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { alertsFailed, alertsSent, alertsSuppressed } from '../metrics.js';
import type { DedupeOptions } from './dedupe.js';
import { sendHourlyDigest } from './digest.js';
import { DiscordClient, LoggingTransport, type AlertTransport } from './discord.js';
import {
  alertConfirmedViolations,
  alertResolvedViolations,
  type AlertableViolation,
  type ResolvedViolation,
  type ViolationAlertOptions,
} from './violations.js';

/**
 * Assembly: config in, one alerter out.
 *
 * Everything below this line is wiring. The decisions all live in `dedupe.ts`,
 * the formatting in `format.ts`, the durability in `store.ts` — this module
 * exists so the coherence job has a single thing to call and does not need to
 * know any of that.
 */

const log = createLogger('alerts');

type Database = PostgresJsDatabase<typeof schema>;

export interface AlerterOptions {
  readonly transport?: AlertTransport;
  readonly database?: Database;
  readonly dedupe?: DedupeOptions;
  readonly minNetEdge?: number;
  readonly minNetProfit?: number;
}

/**
 * Builds the transport.
 *
 * A missing webhook is not an error and not silence: it falls back to logging,
 * so the dedup, thresholds, and escalation all still run and can be observed.
 * Making "unconfigured" mean "no-op" would leave the most intricate part of
 * this feature untested in exactly the environment where it is written.
 */
export function createTransport(webhookUrl: string | undefined = config.DISCORD_WEBHOOK_URL): AlertTransport {
  if (webhookUrl === undefined || webhookUrl === '') {
    log.info('no DISCORD_WEBHOOK_URL configured; alerts will be logged, not sent');
    return new LoggingTransport();
  }
  return new DiscordClient({ webhookUrl });
}

export interface AlertRunSummary {
  readonly confirmed: number;
  readonly escalated: number;
  readonly resolved: number;
  readonly suppressed: number;
  readonly belowThreshold: number;
  readonly failed: number;
}

export class Alerter {
  readonly #transport: AlertTransport;
  readonly #database: Database;
  readonly #dedupe: DedupeOptions;
  readonly #violationOptions: ViolationAlertOptions;

  constructor(options: AlerterOptions = {}) {
    this.#transport = options.transport ?? createTransport();
    this.#database = options.database ?? db;
    this.#dedupe = options.dedupe ?? {
      cooldownMs: config.ALERT_COOLDOWN_MS,
      escalationFactor: config.ALERT_ESCALATION_FACTOR,
    };
    this.#violationOptions = {
      ...this.#dedupe,
      minNetEdge: options.minNetEdge ?? config.ALERT_MIN_NET_EDGE,
      minNetProfit: options.minNetProfit ?? config.ALERT_MIN_NET_PROFIT,
    };
  }

  /**
   * Everything a completed coherence check should announce.
   *
   * Reads the persisted episodes rather than the in-memory `CheckResult`,
   * because the alert needs the *episode id* — assigned by the database — and
   * the peak values accumulated across earlier checks. The check result only
   * knows about this instant.
   */
  async afterCheck(result: CheckResult, now: Date = new Date()): Promise<AlertRunSummary> {
    const confirmedKeys = result.confirmations
      .filter((c) => c.status === 'confirmed')
      .map((c) => c.constraint.key);

    const confirmed = await this.#loadConfirmed(confirmedKeys, now);
    const resolved = await this.#loadRecentlyResolved(now);

    const violations = await alertConfirmedViolations(
      confirmed,
      this.#transport,
      this.#violationOptions,
      this.#database,
      now,
    );
    const closures = await alertResolvedViolations(
      resolved,
      this.#transport,
      this.#dedupe,
      this.#database,
      now,
    );

    alertsSent.inc({ kind: 'violation' }, violations.sent);
    alertsSent.inc({ kind: 'escalation' }, violations.escalated);
    alertsSent.inc({ kind: 'resolution' }, closures.resolved);
    alertsSuppressed.inc({ reason: 'dedupe' }, violations.suppressed + closures.suppressed);
    alertsSuppressed.inc({ reason: 'threshold' }, violations.belowThreshold);
    alertsFailed.inc({}, violations.failed + closures.failed);

    const summary: AlertRunSummary = {
      confirmed: violations.sent,
      escalated: violations.escalated,
      resolved: closures.resolved,
      suppressed: violations.suppressed + closures.suppressed,
      belowThreshold: violations.belowThreshold,
      failed: violations.failed + closures.failed,
    };

    if (summary.confirmed + summary.escalated + summary.resolved > 0) {
      log.info({ ...summary }, 'alerts dispatched');
    }
    return summary;
  }

  /** The hourly digest. Safe to call on every check; only one lands per hour. */
  async digest(now: Date = new Date()): Promise<void> {
    try {
      const result = await sendHourlyDigest(this.#transport, this.#database, now);
      if (result.sent) alertsSent.inc({ kind: 'digest' });
    } catch (error) {
      alertsFailed.inc({});
      log.error({ error: describeError(error) }, 'digest failed');
    }
  }

  /** Open, confirmed episodes for the constraints this check confirmed. */
  async #loadConfirmed(constraintKeys: readonly string[], now: Date): Promise<AlertableViolation[]> {
    if (constraintKeys.length === 0) return [];

    const rows = await this.#database.execute<{
      id: number;
      constraint_key: string;
      kind: string;
      condition_ids: string[];
      trade: unknown;
      screen_magnitude: string | null;
      detected_at: Date;
    }>(sql`
      select id, constraint_key, kind, condition_ids, trade, screen_magnitude, detected_at
      from violations
      where resolved_at is null and ever_confirmed
        and constraint_key = any(${sql.param([...constraintKeys])}::text[])
    `);

    void now;
    return rows.map((row) => ({
      violationId: Number(row.id),
      constraintKey: row.constraint_key,
      kind: row.kind,
      conditionIds: row.condition_ids,
      trade: row.trade as AlertableViolation['trade'],
      screenMagnitude: row.screen_magnitude === null ? null : Number(row.screen_magnitude),
      detectedAt: row.detected_at,
    }));
  }

  /**
   * Episodes that closed recently and were confirmed at some point.
   *
   * Bounded by a lookback window rather than "everything unnotified": without
   * it, enabling alerting on a database with months of history would open with
   * a flood of resolutions for violations nobody ever saw announced.
   */
  async #loadRecentlyResolved(now: Date): Promise<ResolvedViolation[]> {
    const since = new Date(now.getTime() - config.ALERT_RESOLUTION_LOOKBACK_MS);

    const rows = await this.#database.execute<{
      id: number;
      constraint_key: string;
      kind: string;
      detected_at: Date;
      resolved_at: Date;
      peak_net_edge: string | null;
      peak_net_profit: string | null;
      ever_confirmed: boolean;
    }>(sql`
      select v.id, v.constraint_key, v.kind, v.detected_at, v.resolved_at,
             v.peak_net_edge, v.peak_net_profit, v.ever_confirmed
      from violations v
      join alert_deliveries d on d.alert_key = 'violation:' || v.id::text
      where v.resolved_at is not null and v.resolved_at >= ${since.toISOString()}::timestamptz
        and v.ever_confirmed and d.resolved_notified_at is null
      limit 100
    `);

    return rows.map((row) => ({
      violationId: Number(row.id),
      constraintKey: row.constraint_key,
      kind: row.kind,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at,
      peakNetEdge: row.peak_net_edge === null ? null : Number(row.peak_net_edge),
      peakNetProfit: row.peak_net_profit === null ? null : Number(row.peak_net_profit),
      everConfirmed: row.ever_confirmed,
    }));
  }
}

export { DiscordClient, LoggingTransport, type AlertTransport } from './discord.js';
export { decide, meetsThreshold, type AlertDecision } from './dedupe.js';
export { evaluateSystem, alertSystem, DEFAULT_SYSTEM_THRESHOLDS } from './system.js';
export { sendHourlyDigest, hourBucket, digestKey } from './digest.js';
