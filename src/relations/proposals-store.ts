import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { db } from '../db/client.js';
import type * as schema from '../db/schema.js';
import { relationProposals, relations } from '../db/schema.js';
import { createLogger } from '../logger.js';
import type { ProposedType, RelationProposal } from './proposer.js';
import { canonicalPair, type RelationEdge } from './types.js';

/**
 * Persistence and review for LLM proposals.
 *
 * The one invariant this module exists to hold: a proposal never becomes an
 * edge without a recorded verdict. `acceptProposal` is the only path from
 * `relation_proposals` into `relations`, it writes the verdict and the edge in
 * one transaction, and it refuses to run on a proposal that is not pending.
 */

const log = createLogger('proposals');

type Database = PostgresJsDatabase<typeof schema>;

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'skipped';

export interface SaveProposalsResult {
  readonly submitted: number;
  readonly inserted: number;
  /** Already present, so not re-sent to the model and not overwritten. */
  readonly duplicate: number;
}

/**
 * Stores proposals, one per pair, ever.
 *
 * `onConflictDoNothing` rather than an upsert: a pair that has already been
 * proposed keeps its original proposal and — crucially — its verdict. Letting a
 * later run overwrite an accepted or rejected row would silently reopen a
 * decision a reviewer already made.
 */
export async function saveProposals(
  proposals: readonly RelationProposal[],
  database: Database = db,
): Promise<SaveProposalsResult> {
  if (proposals.length === 0) return { submitted: 0, inserted: 0, duplicate: 0 };

  const rows = new Map<string, typeof relationProposals.$inferInsert>();
  for (const proposal of proposals) {
    const [low, high] = canonicalPair(proposal.aConditionId, proposal.bConditionId);
    if (low === high) continue;

    // Direction is stated relative to A and B; storage is ordered by id, so a
    // pair that got swapped has to have its direction swapped with it.
    const swapped = low !== proposal.aConditionId;
    const relation: ProposedType =
      swapped && proposal.relation === 'implies'
        ? 'implied_by'
        : swapped && proposal.relation === 'implied_by'
          ? 'implies'
          : proposal.relation;

    rows.set(`${low} ${high}`, {
      lowConditionId: low,
      highConditionId: high,
      proposedType: relation,
      rationale: proposal.rationale,
      modelConfidence: String(proposal.confidence),
      model: proposal.model,
      similarity: proposal.similarity === null ? null : String(proposal.similarity),
      status: 'pending',
    });
  }

  const values = [...rows.values()];
  if (values.length === 0) return { submitted: proposals.length, inserted: 0, duplicate: 0 };

  const inserted = await database
    .insert(relationProposals)
    .values(values)
    .onConflictDoNothing({
      target: [relationProposals.lowConditionId, relationProposals.highConditionId],
    })
    .returning({ id: relationProposals.id });

  const result = {
    submitted: proposals.length,
    inserted: inserted.length,
    duplicate: values.length - inserted.length,
  };
  log.info({ ...result }, 'proposals persisted');
  return result;
}

export interface PendingProposal {
  readonly id: number;
  readonly lowConditionId: string;
  readonly highConditionId: string;
  readonly lowQuestion: string;
  readonly highQuestion: string;
  readonly lowDescription: string | null;
  readonly highDescription: string | null;
  readonly proposedType: ProposedType;
  readonly rationale: string;
  readonly modelConfidence: number;
  readonly model: string;
  readonly similarity: number | null;
}

/**
 * Pending proposals with both questions attached, for the reviewer.
 *
 * `unrelated` proposals are excluded by default: reviewing thousands of "these
 * are unrelated" verdicts is not a use of anyone's attention, and the row has
 * already done its real job by making the pair ineligible for re-proposal.
 */
export async function loadPendingProposals(
  database: Database = db,
  options: { limit?: number; includeUnrelated?: boolean } = {},
): Promise<PendingProposal[]> {
  const limit = options.limit ?? 200;
  const includeUnrelated = options.includeUnrelated ?? false;

  const rows = await database.execute<{
    id: number;
    low_condition_id: string;
    high_condition_id: string;
    low_question: string;
    high_question: string;
    low_description: string | null;
    high_description: string | null;
    proposed_type: string;
    rationale: string;
    model_confidence: string;
    model: string;
    similarity: string | null;
  }>(sql`
    select p.id, p.low_condition_id, p.high_condition_id,
           lm.question as low_question, hm.question as high_question,
           lm.description as low_description, hm.description as high_description,
           p.proposed_type, p.rationale, p.model_confidence, p.model, p.similarity
    from relation_proposals p
    join markets lm on lm.condition_id = p.low_condition_id
    join markets hm on hm.condition_id = p.high_condition_id
    where p.status = 'pending'
      and (${includeUnrelated} = true or p.proposed_type <> 'unrelated')
    order by p.model_confidence desc, p.id
    limit ${limit}
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    lowConditionId: row.low_condition_id,
    highConditionId: row.high_condition_id,
    lowQuestion: row.low_question,
    highQuestion: row.high_question,
    lowDescription: row.low_description,
    highDescription: row.high_description,
    proposedType: row.proposed_type as ProposedType,
    rationale: row.rationale,
    modelConfidence: Number(row.model_confidence),
    model: row.model,
    similarity: row.similarity === null ? null : Number(row.similarity),
  }));
}

/**
 * How a proposed type becomes an edge.
 *
 * `mutually_exclusive` deliberately has no mapping. Exclusivity is a set
 * property, and the `relations` table stores implications and complements; a
 * two-market exclusivity claim is weaker than a partition and stronger than
 * nothing, and inventing a pairwise encoding for it here would put a constraint
 * in the graph that the solver would read as something it is not. Those are
 * accepted and recorded, but produce no edge until partitions grow a pairwise
 * form.
 */
export function proposalToEdge(
  proposal: Pick<PendingProposal, 'lowConditionId' | 'highConditionId' | 'proposedType' | 'rationale' | 'model'>,
): RelationEdge | null {
  const base = {
    type: 'implies' as const,
    source: 'llm_reviewed' as const,
    confidence: 1,
    rationale: `Reviewed and accepted (${proposal.model}): ${proposal.rationale}`,
  };

  switch (proposal.proposedType) {
    case 'implies':
      return { ...base, fromConditionId: proposal.lowConditionId, toConditionId: proposal.highConditionId };
    case 'implied_by':
      return { ...base, fromConditionId: proposal.highConditionId, toConditionId: proposal.lowConditionId };
    case 'complement':
      return {
        ...base,
        type: 'complement',
        fromConditionId: proposal.lowConditionId,
        toConditionId: proposal.highConditionId,
      };
    default:
      return null;
  }
}

export interface ReviewVerdict {
  readonly proposalId: number;
  readonly status: Exclude<ProposalStatus, 'pending'>;
  readonly reviewedBy: string;
  readonly note?: string;
}

/**
 * Records a verdict, and on acceptance writes the edge — atomically.
 *
 * Both happen in one transaction so the graph can never contain an edge whose
 * verdict was not recorded, nor a verdict whose edge failed to land.
 *
 * A proposal that is not pending is left alone and reported as unchanged: a
 * rejection is permanent, and a second pass must not quietly overturn it.
 */
export async function recordVerdict(
  verdict: ReviewVerdict,
  database: Database = db,
): Promise<{ applied: boolean; edgeWritten: boolean }> {
  return database.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(relationProposals)
      .where(and(eq(relationProposals.id, verdict.proposalId), eq(relationProposals.status, 'pending')))
      .for('update');

    if (proposal === undefined) return { applied: false, edgeWritten: false };

    await tx
      .update(relationProposals)
      .set({
        status: verdict.status,
        reviewedBy: verdict.reviewedBy,
        reviewedAt: new Date(),
        reviewNote: verdict.note ?? null,
      })
      .where(eq(relationProposals.id, verdict.proposalId));

    if (verdict.status !== 'accepted') return { applied: true, edgeWritten: false };

    const edge = proposalToEdge({
      lowConditionId: proposal.lowConditionId,
      highConditionId: proposal.highConditionId,
      proposedType: proposal.proposedType as ProposedType,
      rationale: proposal.rationale,
      model: proposal.model,
    });
    if (edge === null) return { applied: true, edgeWritten: false };

    await tx
      .insert(relations)
      .values({
        fromConditionId: edge.fromConditionId,
        toConditionId: edge.toConditionId,
        type: edge.type,
        source: edge.source,
        confidence: String(edge.confidence),
        rationale: edge.rationale,
      })
      .onConflictDoUpdate({
        target: [relations.fromConditionId, relations.toConditionId, relations.type],
        set: { source: sql`excluded.source`, rationale: sql`excluded.rationale`, lastSeenAt: sql`now()` },
      });

    return { applied: true, edgeWritten: true };
  });
}

export interface ProposalPrecision {
  readonly reviewed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly pending: number;
  /** accepted / (accepted + rejected). Null before anything is decided. */
  readonly precision: number | null;
  readonly byType: ReadonlyArray<{
    readonly proposedType: string;
    readonly accepted: number;
    readonly rejected: number;
    readonly precision: number | null;
  }>;
}

/** The headline number: of proposals decided, what fraction were accepted. */
export async function proposalPrecision(database: Database = db): Promise<ProposalPrecision> {
  const totals = await database.execute<{ status: string; n: number }>(
    sql`select status, count(*)::int as n from relation_proposals group by status`,
  );
  const count = (status: string): number =>
    Number(totals.find((row) => row.status === status)?.n ?? 0);

  const accepted = count('accepted');
  const rejected = count('rejected');
  const decided = accepted + rejected;

  const perType = await database.execute<{ proposed_type: string; accepted: number; rejected: number }>(sql`
    select proposed_type,
           count(*) filter (where status = 'accepted')::int as accepted,
           count(*) filter (where status = 'rejected')::int as rejected
    from relation_proposals
    where status in ('accepted', 'rejected')
    group by proposed_type
    order by proposed_type
  `);

  return {
    reviewed: decided + count('skipped'),
    accepted,
    rejected,
    skipped: count('skipped'),
    pending: count('pending'),
    precision: decided === 0 ? null : accepted / decided,
    byType: perType.map((row) => {
      const total = Number(row.accepted) + Number(row.rejected);
      return {
        proposedType: row.proposed_type,
        accepted: Number(row.accepted),
        rejected: Number(row.rejected),
        precision: total === 0 ? null : Number(row.accepted) / total,
      };
    }),
  };
}

/** Recently decided proposals, newest first. */
export async function recentVerdicts(
  database: Database = db,
  limit = 20,
): Promise<schema.RelationProposalRow[]> {
  return database
    .select()
    .from(relationProposals)
    .where(sql`${relationProposals.status} <> 'pending'`)
    .orderBy(desc(relationProposals.reviewedAt))
    .limit(limit);
}
