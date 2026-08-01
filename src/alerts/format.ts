import type { CorrectingTrade } from '../coherence/trade.js';
import { DISCORD_LIMITS, type DiscordEmbed, type DiscordMessage } from './discord.js';

/**
 * Turning a violation into something a person can act on in ten seconds.
 *
 * Pure. Every function here takes data and returns a message; nothing reads a
 * clock or a database, so the exact bytes that would be posted can be asserted
 * in a test.
 *
 * The formatting rule throughout: **lead with the decision, not the evidence.**
 * The first line of an alert answers "is this worth my attention" — net edge and
 * dollars — and everything below it is there for the person who already decided
 * the answer was yes.
 */

const COLOR = {
  confirmed: 0x2e_cc_71, // green — money on the table
  escalation: 0xe6_7e_22, // orange — it got materially better
  resolved: 0x95_a5_a6, // grey — over, archival
  digest: 0x34_98_db, // blue — informational
  warning: 0xf1_c4_0f, // yellow — system degraded
  critical: 0xe7_4c_3c, // red — system broken
} as const;

/** A market as the alert needs to describe it. */
export interface AlertMarket {
  readonly conditionId: string;
  readonly question: string | null;
  readonly slug: string | null;
  readonly eventSlug: string | null;
  /** Current screened probability of the first outcome. */
  readonly price: number | null;
}

export interface ViolationAlertInput {
  readonly violationId: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly markets: readonly AlertMarket[];
  readonly trade: CorrectingTrade | null;
  readonly screenMagnitude: number | null;
  readonly detectedAt: Date;
  /** Set on an escalation: what the previous message quoted. */
  readonly previousNetEdge?: number | null;
}

/**
 * Deep link to a market.
 *
 * The market slug is preferred; the event slug is the fallback because
 * Polymarket serves a grouped market only under its event, and a dead link in
 * an alert is worse than a slightly broader one. Both forms were checked
 * against the live site.
 */
export function polymarketUrl(market: Pick<AlertMarket, 'slug' | 'eventSlug'>): string | null {
  if (market.slug !== null && market.slug !== '') {
    return `https://polymarket.com/market/${market.slug}`;
  }
  if (market.eventSlug !== null && market.eventSlug !== '') {
    return `https://polymarket.com/event/${market.eventSlug}`;
  }
  return null;
}

const cents = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(2)}¢`;

const usd = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${n.toFixed(2)}`;

/** Clamps to a Discord limit, leaving evidence that text was cut. */
export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Human duration. Alerts are read at a glance; `4523s` is not readable. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** `Will X happen? — 34.00¢ ([open](url))` for one market. */
function marketLine(market: AlertMarket, index: number): string {
  const url = polymarketUrl(market);
  const question = clamp(market.question ?? market.conditionId, 180);
  const link = url === null ? '' : ` · [open](${url})`;
  return `**${String.fromCodePoint(65 + index)}.** ${question}\n ${cents(market.price)}${link}`;
}

/** One line per leg: what to buy, how much, at what price. */
function legLines(trade: CorrectingTrade): string {
  return trade.legs
    .map(
      (leg) =>
        ` buy **${leg.size.toFixed(0)}** × ${leg.outcome ?? '?'} @ ${cents(leg.avgPrice)}` +
        ` (touch ${cents(leg.touchPrice)})`,
    )
    .join('\n');
}

const CONSTRAINT_TEXT: Readonly<Record<string, string>> = {
  implies: 'P(A) ≤ P(B) — A entails B',
  complement: 'P(A) + P(B) = 1 — exactly one resolves Yes',
  partition: 'Σ P = 1 — exactly one member resolves Yes',
};

/**
 * The message for a confirmed violation, or its escalation.
 *
 * Both use the same body; only the header, colour, and the added "grew from"
 * line differ. Keeping them one function means an escalation can never drift
 * into showing different numbers than the alert it escalates.
 */
export function formatViolationAlert(
  input: ViolationAlertInput,
  variant: 'confirmed' | 'escalation',
): DiscordMessage {
  const trade = input.trade;
  const escalated = variant === 'escalation';

  const title = escalated
    ? `Escalation · ${usd(trade?.netProfit)} on ${input.kind}`
    : `Confirmed violation · ${usd(trade?.netProfit)} on ${input.kind}`;

  const fields = [
    {
      name: 'Constraint violated',
      value: clamp(CONSTRAINT_TEXT[input.kind] ?? input.kind, DISCORD_LIMITS.embedFieldValue),
    },
    {
      name: 'Net edge',
      value: `${cents(trade?.netEdge)} / unit${
        escalated && input.previousNetEdge != null
          ? `\n(was ${cents(input.previousNetEdge)} — ${(
              (trade?.netEdge ?? 0) / input.previousNetEdge
            ).toFixed(1)}×)`
          : ''
      }`,
      inline: true,
    },
    {
      name: 'Max executable',
      value:
        trade === null
          ? '—'
          : `${trade.maxExecutableSize.toFixed(0)} units\n(trading ${trade.size.toFixed(0)})`,
      inline: true,
    },
    { name: 'Net profit', value: usd(trade?.netProfit), inline: true },
  ];

  if (trade !== null) {
    fields.push({
      name: 'Trade',
      value: clamp(
        `${legLines(trade)}\n cost ${usd(trade.totalCost)} → pays ≥ ${usd(trade.totalPayout)}`,
        DISCORD_LIMITS.embedFieldValue,
      ),
    });
  }

  const embed: DiscordEmbed = {
    title: clamp(title, DISCORD_LIMITS.embedTitle),
    description: clamp(
      input.markets.map((m, i) => marketLine(m, i)).join('\n'),
      DISCORD_LIMITS.embedDescription,
    ),
    color: escalated ? COLOR.escalation : COLOR.confirmed,
    fields: fields.slice(0, DISCORD_LIMITS.embedFields),
    footer: {
      text: clamp(
        `${input.constraintKey} · violation #${input.violationId} · screen ${cents(input.screenMagnitude)}`,
        DISCORD_LIMITS.embedFooter,
      ),
    },
    timestamp: input.detectedAt.toISOString(),
  };

  return { embeds: [fitEmbeds([embed])[0]!] };
}

/** The follow-up when a violation ends — the lifetime is the whole point. */
export function formatResolution(input: {
  readonly violationId: number;
  readonly constraintKey: string;
  readonly kind: string;
  readonly detectedAt: Date;
  readonly resolvedAt: Date;
  readonly peakNetEdge: number | null;
  readonly peakNetProfit: number | null;
  readonly everConfirmed: boolean;
}): DiscordMessage {
  const lifetimeMs = input.resolvedAt.getTime() - input.detectedAt.getTime();

  return {
    embeds: [
      {
        title: clamp(`Resolved after ${humanDuration(lifetimeMs)}`, DISCORD_LIMITS.embedTitle),
        description: `The ${input.kind} constraint is satisfied again.`,
        color: COLOR.resolved,
        fields: [
          { name: 'Lifetime', value: humanDuration(lifetimeMs), inline: true },
          { name: 'Peak edge', value: cents(input.peakNetEdge), inline: true },
          { name: 'Peak profit', value: usd(input.peakNetProfit), inline: true },
        ],
        footer: {
          text: clamp(
            `${input.constraintKey} · violation #${input.violationId}`,
            DISCORD_LIMITS.embedFooter,
          ),
        },
        timestamp: input.resolvedAt.toISOString(),
      },
    ],
  };
}

export interface DigestEntry {
  readonly kind: string;
  readonly constraintKey: string;
  readonly question: string | null;
  readonly screenMagnitude: number | null;
  readonly reason: string | null;
}

/**
 * The hourly digest of apparent-but-unexecutable violations.
 *
 * Batched into one message because these are the *common* case — most screened
 * gaps do not survive the spread — and one message an hour is the difference
 * between a signal and a mute. The reasons are grouped and counted rather than
 * listed, since "37 × the spread and fees exceed the mispricing" says more than
 * thirty-seven near-identical lines.
 */
export function formatDigest(input: {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly entries: readonly DigestEntry[];
  readonly confirmedInWindow: number;
}): DiscordMessage {
  const byReason = new Map<string, number>();
  for (const entry of input.entries) {
    const reason = summariseReason(entry.reason);
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  const worst = [...input.entries]
    .filter((e) => e.screenMagnitude !== null)
    .toSorted((a, b) => (b.screenMagnitude ?? 0) - (a.screenMagnitude ?? 0))
    .slice(0, 5);

  const reasonLines = [...byReason.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([reason, count]) => ` **${count}×** ${reason}`)
    .join('\n');

  const fields = [
    {
      name: 'Why they were not executable',
      value: clamp(reasonLines || '—', DISCORD_LIMITS.embedFieldValue),
    },
  ];

  if (worst.length > 0) {
    fields.push({
      name: 'Largest apparent gaps',
      value: clamp(
        worst
          .map(
            (e) =>
              ` ${cents(e.screenMagnitude)} · ${clamp(e.question ?? e.constraintKey, 70)}`,
          )
          .join('\n'),
        DISCORD_LIMITS.embedFieldValue,
      ),
    });
  }

  return {
    embeds: [
      {
        title: `Hourly digest · ${input.entries.length} apparent, ${input.confirmedInWindow} confirmed`,
        description:
          input.entries.length === 0
            ? 'No apparent violations this hour.'
            : 'Screened as violated, but no profitable correcting trade existed.',
        color: COLOR.digest,
        fields,
        footer: {
          text: `${input.windowStart.toISOString()} → ${input.windowEnd.toISOString()}`,
        },
        timestamp: input.windowEnd.toISOString(),
      },
    ],
  };
}

/** Collapses a per-violation reason into a groupable class. */
export function summariseReason(reason: string | null): string {
  if (reason === null || reason.trim() === '') return 'unknown';
  if (reason.includes('spread and fees')) return 'spread and fees exceed the mispricing';
  if (reason.includes('too thin to be worth taking')) return 'edge real but immaterial';
  if (reason.includes('cannot be bought')) return 'a leg has nothing offered';
  if (reason.includes('minimum order size')) return 'below the venue minimum order size';
  if (reason.includes('no order book')) return 'no order book for a leg';
  if (reason.includes('already closed')) return 'stale screen quote; gap had closed';
  return clamp(reason, 90);
}

export type SystemSeverity = 'warning' | 'critical';

export function formatSystemAlert(input: {
  readonly name: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: SystemSeverity;
  readonly facts: ReadonlyArray<{ name: string; value: string }>;
  readonly at: Date;
}): DiscordMessage {
  return {
    embeds: [
      {
        title: clamp(input.title, DISCORD_LIMITS.embedTitle),
        description: clamp(input.detail, DISCORD_LIMITS.embedDescription),
        color: input.severity === 'critical' ? COLOR.critical : COLOR.warning,
        fields: input.facts
          .slice(0, DISCORD_LIMITS.embedFields)
          .map((f) => ({
            name: clamp(f.name, DISCORD_LIMITS.embedFieldName),
            value: clamp(f.value, DISCORD_LIMITS.embedFieldValue),
            inline: true,
          })),
        footer: { text: `system · ${input.name}` },
        timestamp: input.at.toISOString(),
      },
    ],
  };
}

/**
 * Enforces the 6000-character budget across a message's embeds.
 *
 * Discord rejects the whole request with a 400 when the sum of every text
 * property exceeds it, so an alert about an unusually wordy market would fail
 * to send — exactly when it is most interesting. Trimming descriptions is
 * lossy; not sending is worse.
 */
function embedTextSize(list: readonly DiscordEmbed[]): number {
  return list.reduce(
    (total, embed) =>
      total +
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text.length ?? 0) +
      (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0),
    0,
  );
}

export function fitEmbeds(embeds: readonly DiscordEmbed[]): DiscordEmbed[] {
  const kept: DiscordEmbed[] = [];
  for (const embed of embeds.slice(0, DISCORD_LIMITS.embedsPerMessage)) {
    kept.push(Object.assign({}, embed));
  }

  const size = embedTextSize;

  // Trim the longest description first; it is the most compressible part and
  // the fields carry the numbers someone is acting on.
  while (size(kept) > DISCORD_LIMITS.embedTotal) {
    const target = kept
      .map((embed, index) => ({ embed, index, length: embed.description?.length ?? 0 }))
      .toSorted((a, b) => b.length - a.length)[0];

    if (target === undefined || target.length <= 40) break;

    const excess = size(kept) - DISCORD_LIMITS.embedTotal;
    const next = kept[target.index]!;
    next.description = clamp(next.description!, Math.max(40, target.length - excess - 1));
  }

  return kept;
}
