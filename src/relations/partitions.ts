import type { RelationGroup } from './types.js';

/**
 * Mutual exclusivity from event structure.
 *
 * Polymarket flags an event `negRisk` when its markets are mutually exclusive
 * and jointly exhaustive — a three-way soccer result, a "top performer of the
 * week" set, a league winner list with an "another team" catch-all. For such a
 * group exactly one market resolves Yes, so the Yes probabilities sum to 1.
 *
 * This is the strongest relation in the system, because it is asserted by the
 * venue rather than inferred from text. That makes it the natural yardstick:
 * anything else the extractors claim about these markets has to be consistent
 * with it, and {@link findPartitionConflicts} is where that is checked.
 *
 * Pure and total, like every extractor here.
 */

export interface PartitionMarket {
  readonly conditionId: string;
  readonly eventId?: string | null;
  /** Only `["Yes","No"]` markets can contribute a Yes probability to the sum. */
  readonly outcomes?: readonly string[] | null;
  readonly question?: string | null;
}

export interface PartitionEvent {
  readonly eventId: string;
  /** `true` only. `null` means the crawl never learned, which is not a claim. */
  readonly negRisk?: boolean | null;
  readonly title?: string | null;
}

export interface ExtractPartitionsOptions {
  /**
   * Smallest group worth recording. Two is a genuine partition — and also a
   * complement — but a one-market "partition" says only P = 1, which is a
   * resolution, not a relation.
   */
  readonly minMembers?: number;
}

/** A market's outcomes must be exactly Yes/No for its Yes leg to enter the sum. */
function isBinaryYesNo(outcomes: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;
  const [a, b] = outcomes;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === 'yes' && b.trim().toLowerCase() === 'no';
}

/**
 * One partition per `negRisk` event.
 *
 * Events whose flag is `false` or unknown produce nothing: `negRisk = null`
 * means the ingest never saw the field, and treating absence as exclusivity
 * would invent the strongest constraint in the system out of missing data.
 */
export function extractPartitions(
  markets: Iterable<PartitionMarket>,
  events: Iterable<PartitionEvent>,
  options: ExtractPartitionsOptions = {},
): RelationGroup[] {
  const minMembers = options.minMembers ?? 2;

  const negRisk = new Map<string, PartitionEvent>();
  for (const event of events) {
    if (typeof event?.eventId !== 'string' || event.eventId === '') continue;
    if (event.negRisk !== true) continue;
    negRisk.set(event.eventId, event);
  }

  const members = new Map<string, string[]>();
  for (const market of markets) {
    if (typeof market?.conditionId !== 'string' || market.conditionId === '') continue;
    if (typeof market.eventId !== 'string' || !negRisk.has(market.eventId)) continue;
    // A non-binary market has no single Yes leg, so it cannot join the sum.
    if (!isBinaryYesNo(market.outcomes)) continue;

    const bucket = members.get(market.eventId);
    if (bucket === undefined) members.set(market.eventId, [market.conditionId]);
    else bucket.push(market.conditionId);
  }

  const groups: RelationGroup[] = [];

  for (const [eventId, ids] of members) {
    // Deduplicate: the same market must not appear twice in a sum-to-one set.
    const unique = [...new Set(ids)].toSorted();
    if (unique.length < minMembers) continue;

    const event = negRisk.get(eventId);
    const title = typeof event?.title === 'string' && event.title !== '' ? event.title : eventId;

    groups.push({
      key: `partition:neg-risk-event:${eventId}`,
      type: 'partition',
      source: 'neg-risk-event',
      confidence: 1,
      members: unique,
      rationale:
        `Event ${eventId} ("${title}") is flagged negRisk by the venue: its ${unique.length} ` +
        `markets are mutually exclusive and exhaustive, so exactly one resolves Yes and ` +
        `the Yes probabilities sum to 1.`,
    });
  }

  return groups.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PartitionConflict {
  readonly partitionKey: string;
  readonly fromConditionId: string;
  readonly toConditionId: string;
  readonly source: string;
  readonly detail: string;
}

/**
 * Cross-checks the inferred relations against the venue's own claim.
 *
 * Two markets in one partition are mutually exclusive: at most one is Yes. An
 * `implies` edge between them says the opposite — that one being Yes forces the
 * other to be Yes — and the two cannot both hold unless both probabilities are
 * zero. So any implication *inside* a partition means an extractor is wrong,
 * and since the partition is ground truth, the extractor is what to fix.
 *
 * A complement inside a partition is only consistent when the partition has
 * exactly two members, where "exactly one Yes" and "P(A) + P(B) = 1" agree.
 */
export function findPartitionConflicts(
  partitions: readonly RelationGroup[],
  edges: Iterable<{
    readonly fromConditionId: string;
    readonly toConditionId: string;
    readonly type: string;
    readonly source: string;
  }>,
): PartitionConflict[] {
  const membership = new Map<string, RelationGroup[]>();
  for (const partition of partitions) {
    for (const member of partition.members) {
      const bucket = membership.get(member);
      if (bucket === undefined) membership.set(member, [partition]);
      else bucket.push(partition);
    }
  }

  const conflicts: PartitionConflict[] = [];

  for (const edge of edges) {
    const from = membership.get(edge.fromConditionId);
    if (from === undefined) continue;

    for (const partition of from) {
      if (!partition.members.includes(edge.toConditionId)) continue;

      if (edge.type === 'implies') {
        conflicts.push({
          partitionKey: partition.key,
          fromConditionId: edge.fromConditionId,
          toConditionId: edge.toConditionId,
          source: edge.source,
          detail:
            'implication between two members of a mutually exclusive partition: ' +
            'at most one can resolve Yes, so neither can entail the other',
        });
      } else if (edge.type === 'complement' && partition.members.length !== 2) {
        conflicts.push({
          partitionKey: partition.key,
          fromConditionId: edge.fromConditionId,
          toConditionId: edge.toConditionId,
          source: edge.source,
          detail:
            `complement inside a ${partition.members.length}-member partition: ` +
            'P(A) + P(B) = 1 would leave nothing for the other members',
        });
      }
    }
  }

  return conflicts;
}
