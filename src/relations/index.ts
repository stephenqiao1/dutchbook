/**
 * Relation extraction.
 *
 * Every extractor is pure: it reads market text and event structure and emits
 * typed relations with no I/O of any kind. `store.ts` is the only thing that
 * writes, and `graph.ts` is the only thing that reasons over the result.
 */

export {
  extractLadderRelations,
  groupLadders,
  ladderEdges,
  parseThresholdQuestion,
  type Direction,
  type Ladder,
  type LadderEdgeOptions,
  type LadderExtraction,
  type LadderMarket,
  type LadderRung,
  type GroupLaddersOptions,
  type ThresholdParse,
  type ThresholdUnit,
} from './ladders.js';

export {
  extractTemporalRelations,
  groupTemporalChains,
  parseDeadlineQuestion,
  temporalEdges,
  type TemporalChain,
  type TemporalExtraction,
  type TemporalMarket,
  type TemporalParse,
} from './temporal.js';

export {
  extractComplements,
  normalizeQuestion,
  positiveForms,
  type ComplementMarket,
  type ExtractComplementsOptions,
} from './complements.js';

export {
  extractPartitions,
  findPartitionConflicts,
  type PartitionConflict,
  type PartitionEvent,
  type PartitionMarket,
} from './partitions.js';

export {
  RelationCycleError,
  RelationGraph,
  relatedTo,
  transitiveReduction,
  type BuildGraphOptions,
  type Cycle,
  type GraphStats,
  type RelatedMarket,
} from './graph.js';

export {
  buildRelationGraph,
  extractAllRelations,
  type CatalogEvent,
  type CatalogMarket,
  type ExtractionResult,
} from './extract.js';

export {
  canonicalPair,
  type RelationEdge,
  type RelationGroup,
  type RelationGroupSource,
  type RelationGroupType,
  type RelationSource,
  type RelationType,
} from './types.js';

export {
  findRelationsFrom,
  saveRelationEdges,
  saveRelationGroups,
  type SaveGroupsResult,
  type SaveRelationsResult,
} from './store.js';
