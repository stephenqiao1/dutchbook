/**
 * Shared vocabulary for every relation extractor.
 *
 * Two shapes, because the constraints have two different arities:
 *
 * - {@link RelationEdge} is pairwise. `implies` is directed (P(from) <= P(to));
 *   `complement` is symmetric (P(from) + P(to) = 1) and stored once, in a
 *   canonical order, so the pair has one row rather than two.
 * - {@link RelationGroup} is a hyperedge over a whole set. A partition cannot
 *   be decomposed into pairs without losing its content: pairwise exclusivity
 *   says the members sum to *at most* one, and the exhaustiveness that makes it
 *   exactly one is a property of the set.
 */

export type RelationType = 'implies' | 'complement';

export type RelationSource =
  /** Threshold ladders: `above $2.76` entails `above $2.73`. */
  | 'ladder'
  /** Deadline nesting: `by June 30` entails `by December 31`. */
  | 'temporal'
  /** Mechanical negation: an explicit "not" over an otherwise identical question. */
  | 'complement';

export interface RelationEdge {
  readonly fromConditionId: string;
  readonly toConditionId: string;
  readonly type: RelationType;
  readonly source: RelationSource;
  readonly confidence: number;
  readonly rationale: string;
}

export type RelationGroupType = 'partition';

export type RelationGroupSource = 'neg-risk-event';

export interface RelationGroup {
  /** Stable, derived from the source, so re-extraction upserts rather than duplicates. */
  readonly key: string;
  readonly type: RelationGroupType;
  readonly source: RelationGroupSource;
  readonly confidence: number;
  /** Condition ids, sorted, so the group has one canonical form. */
  readonly members: readonly string[];
  readonly rationale: string;
}

/** Orders a symmetric pair so it is stored once rather than in both directions. */
export function canonicalPair(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}
