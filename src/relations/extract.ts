import { createLogger } from '../logger.js';
import { extractComplements } from './complements.js';
import { RelationGraph, type BuildGraphOptions } from './graph.js';
import { extractLadderRelations } from './ladders.js';
import { extractPartitions, findPartitionConflicts, type PartitionConflict } from './partitions.js';
import { extractTemporalRelations } from './temporal.js';
import type { RelationEdge, RelationGroup } from './types.js';

/**
 * Runs every extractor over one catalog and validates the result.
 *
 * The order matters only for reporting: partitions come from the venue and are
 * treated as ground truth, so they are extracted first and everything else is
 * checked against them. An implication between two members of a mutually
 * exclusive set cannot be true, so finding one means a text extractor is wrong.
 *
 * Pure — no I/O. Persisting is `store.ts`, and building the graph is optional.
 */

const log = createLogger('relations');

export interface CatalogMarket {
  readonly conditionId: string;
  readonly question: string;
  readonly eventId?: string | null;
  readonly endDate?: Date | string | null;
  readonly outcomes?: readonly string[] | null;
}

export interface CatalogEvent {
  readonly eventId: string;
  readonly negRisk?: boolean | null;
  readonly title?: string | null;
}

export interface ExtractionResult {
  readonly edges: readonly RelationEdge[];
  readonly groups: readonly RelationGroup[];
  /** Implications that contradict a venue-asserted partition. */
  readonly conflicts: readonly PartitionConflict[];
  readonly stats: {
    readonly markets: number;
    readonly ladderEdges: number;
    readonly temporalEdges: number;
    readonly complementEdges: number;
    readonly partitions: number;
    readonly partitionMembers: number;
    readonly conflicts: number;
  };
}

export function extractAllRelations(
  markets: readonly CatalogMarket[],
  events: readonly CatalogEvent[] = [],
): ExtractionResult {
  const ladder = extractLadderRelations(markets);
  const temporal = extractTemporalRelations(markets);
  const complements = extractComplements(markets);
  const groups = extractPartitions(markets, events);

  const edges = [...ladder.edges, ...temporal.edges, ...complements];
  const conflicts = findPartitionConflicts(groups, edges);

  if (conflicts.length > 0) {
    for (const conflict of conflicts.slice(0, 20)) {
      log.error(
        { ...conflict },
        'PARTITION CONFLICT — an inferred relation contradicts the venue; the inference is wrong',
      );
    }
    if (conflicts.length > 20) {
      log.error({ suppressed: conflicts.length - 20 }, 'further partition conflicts suppressed');
    }
  }

  return {
    edges,
    groups,
    conflicts,
    stats: {
      markets: markets.length,
      ladderEdges: ladder.edges.length,
      temporalEdges: temporal.edges.length,
      complementEdges: complements.length,
      partitions: groups.length,
      partitionMembers: groups.reduce((sum, g) => sum + g.members.length, 0),
      conflicts: conflicts.length,
    },
  };
}

/**
 * Extracts, drops anything contradicting a partition, and builds the graph.
 *
 * Conflicting edges are removed rather than kept-and-flagged: a partition is
 * the venue's own claim, so an inference that disagrees with it is the thing
 * that is wrong, and feeding it into the graph would propagate the error
 * through every reachability query.
 */
export function buildRelationGraph(
  markets: readonly CatalogMarket[],
  events: readonly CatalogEvent[] = [],
  options: BuildGraphOptions = {},
): { graph: RelationGraph; extraction: ExtractionResult } {
  const extraction = extractAllRelations(markets, events);

  const conflicting = new Set(
    extraction.conflicts.map((c) => `${c.fromConditionId} ${c.toConditionId}`),
  );
  const edges = extraction.edges.filter(
    (edge) => !conflicting.has(`${edge.fromConditionId} ${edge.toConditionId}`),
  );

  const questions =
    options.questions ?? new Map(markets.map((m) => [m.conditionId, m.question] as const));

  const graph = RelationGraph.build(edges, extraction.groups, { ...options, questions });
  return { graph, extraction };
}
