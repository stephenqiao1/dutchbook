/**
 * Relation extraction.
 *
 * `ladders.ts` is pure: it reads market questions and emits typed edges with no
 * I/O of any kind. `store.ts` is the only thing that writes them. Keeping the
 * two apart is what lets the extractor be tested exhaustively against real
 * question strings without a database anywhere near it.
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
  type RelationEdge,
  type ThresholdParse,
  type ThresholdUnit,
} from './ladders.js';

export { findRelationsFrom, saveRelationEdges, type SaveRelationsResult } from './store.js';
