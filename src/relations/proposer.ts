import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';

/**
 * LLM-assisted relation proposal.
 *
 * The model's output is a *proposal*, never an edge. Nothing in this module
 * writes to `relations`; it writes to `relation_proposals` with status
 * `pending`, and only a reviewer's verdict promotes one. The type system helps
 * enforce that — a {@link RelationProposal} is not a `RelationEdge` and cannot
 * be passed where one is expected.
 *
 * Every response is validated against a strict schema. A response that does not
 * parse is logged with the raw text and the pair is skipped. It is never
 * repaired, re-prompted, or guessed at: a malformed answer is evidence the
 * model did not understand the question, and inventing a relation from it is
 * exactly the failure this design exists to prevent.
 */

const log = createLogger('proposer');

/**
 * The five verdicts, and nothing else.
 *
 * Direction is expressed relative to the pair as presented — A and B — so it
 * survives the canonical ordering used for storage.
 */
export const PROPOSED_TYPES = [
  /** A entails B: P(A) <= P(B). */
  'implies',
  /** B entails A: P(B) <= P(A). */
  'implied_by',
  /** Both cannot be Yes. */
  'mutually_exclusive',
  /** Exactly one is Yes: P(A) + P(B) = 1. */
  'complement',
  /** No logical constraint. The expected answer for most pairs. */
  'unrelated',
] as const;

export type ProposedType = (typeof PROPOSED_TYPES)[number];

/**
 * Strict: unknown keys are rejected rather than stripped.
 *
 * A model that invents a field has not followed the contract, and quietly
 * dropping it would hide that. `.strict()` turns a silent deviation into a
 * parse failure, which is logged and skipped.
 */
export const proposalResponseSchema = z
  .object({
    relation: z.enum(PROPOSED_TYPES),
    rationale: z.string().trim().min(1).max(600),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ProposalResponse = z.infer<typeof proposalResponseSchema>;

export interface CandidatePair {
  readonly aConditionId: string;
  readonly aQuestion: string;
  readonly aDescription?: string | null;
  readonly bConditionId: string;
  readonly bQuestion: string;
  readonly bDescription?: string | null;
  readonly similarity?: number;
}

export interface RelationProposal {
  readonly aConditionId: string;
  readonly bConditionId: string;
  readonly relation: ProposedType;
  readonly rationale: string;
  readonly confidence: number;
  readonly model: string;
  readonly similarity: number | null;
}

/** Trims resolution criteria, which run to thousands of words of boilerplate. */
function criteria(text: string | null | undefined, limit = 1200): string {
  if (typeof text !== 'string' || text.trim() === '') return '(none given)';
  const tidy = text.replace(/\s+/g, ' ').trim();
  return tidy.length <= limit ? tidy : `${tidy.slice(0, limit)}…`;
}

export const SYSTEM_PROMPT = [
  'You classify the logical relationship between two prediction-market questions.',
  '',
  'Answer with exactly one relation:',
  '  implies             — if A resolves YES then B must resolve YES',
  '  implied_by          — if B resolves YES then A must resolve YES',
  '  mutually_exclusive  — A and B cannot both resolve YES',
  '  complement          — exactly one of A and B resolves YES (they partition)',
  '  unrelated           — no strict logical constraint holds between them',
  '',
  'Rules:',
  '- Judge logical necessity, not correlation. Two markets that usually move',
  '  together are `unrelated` unless one truly forces the other.',
  '- Different resolution dates almost always break an implication. "X by June"',
  '  and "X by December" nest; "X on June 1" and "X on June 2" do not.',
  '- Different subjects, entities, or thresholds mean `unrelated`.',
  '- `unrelated` is the correct answer for most pairs. Prefer it when unsure.',
  '- Confidence is your probability that the relation is exactly right.',
  '',
  'Reply with JSON only, no prose and no code fence:',
  '{"relation": "...", "rationale": "one sentence", "confidence": 0.0}',
].join('\n');

export function buildUserPrompt(pair: CandidatePair): string {
  return [
    'MARKET A',
    `question: ${pair.aQuestion}`,
    `resolution criteria: ${criteria(pair.aDescription)}`,
    '',
    'MARKET B',
    `question: ${pair.bQuestion}`,
    `resolution criteria: ${criteria(pair.bDescription)}`,
    '',
    'Classify the relation from A to B.',
  ].join('\n');
}

/** The transport. Injectable so tests never touch the network. */
export interface ProposalClient {
  readonly model: string;
  /** Returns the model's raw text, or throws. */
  complete(system: string, user: string): Promise<string>;
}

export interface AnthropicClientOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  /** Retries on 429 and 5xx, handled by the SDK. Default 4. */
  maxRetries?: number;
  /** Thinking depth. `low` is ample for a five-way classification. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * The real transport, on the official SDK.
 *
 * Note what is *not* here: no `temperature`. Current models reject it outright
 * — the first live run of this file returned 180 consecutive 400s because of
 * it — and determinism was never actually purchased by setting it to zero. The
 * comparability a re-run needs comes from the proposal store instead: a pair
 * that has been asked once is never asked again, whatever the answer was.
 *
 * `max_tokens` bounds thinking *and* the answer together, so it is set well
 * above what a one-line JSON verdict needs; a truncated response is a parse
 * failure, and a parse failure discards a pair permanently.
 */
export function createAnthropicClient(options: AnthropicClientOptions): ProposalClient {
  const model = options.model ?? 'claude-opus-5';
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 4,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
  });

  return {
    model,
    async complete(system, user) {
      const message = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 2048,
        system,
        thinking: { type: 'adaptive' },
        output_config: { effort: options.effort ?? 'low' },
        messages: [{ role: 'user', content: user }],
      });

      if (message.stop_reason === 'refusal') {
        throw new Error('anthropic declined to classify this pair');
      }

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      if (text === '') throw new Error('anthropic returned an empty completion');
      return text;
    },
  };
}

/**
 * Pulls the JSON object out of a completion.
 *
 * Models wrap JSON in fences or preamble even when told not to. Extracting the
 * outermost braces is tolerant of *formatting*, which is a presentation issue —
 * it is not tolerant of content, which `proposalResponseSchema` still has to
 * accept in full.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export interface ProposeResult {
  readonly proposals: readonly RelationProposal[];
  readonly stats: {
    readonly considered: number;
    readonly proposed: number;
    readonly unrelated: number;
    readonly parseFailures: number;
    readonly callFailures: number;
  };
}

export interface ProposeOptions {
  /**
   * Keep `unrelated` verdicts as rows too. Default true — a stored `unrelated`
   * is what stops the pair being sent to the model ever again, which is most of
   * the point of persisting proposals at all.
   */
  readonly keepUnrelated?: boolean;
  readonly onProposal?: (proposal: RelationProposal) => void | Promise<void>;
}

/**
 * Classifies candidate pairs. Never writes anything.
 *
 * A pair whose response fails to parse, or whose call fails outright, is
 * counted and dropped. It is not retried with a different prompt and not
 * guessed at — it simply produces no proposal, and remains eligible next run.
 */
export async function proposeRelations(
  pairs: readonly CandidatePair[],
  client: ProposalClient,
  options: ProposeOptions = {},
): Promise<ProposeResult> {
  const keepUnrelated = options.keepUnrelated ?? true;
  const proposals: RelationProposal[] = [];
  let parseFailures = 0;
  let callFailures = 0;
  let unrelated = 0;

  for (const pair of pairs) {
    let raw: string;
    try {
      raw = await client.complete(SYSTEM_PROMPT, buildUserPrompt(pair));
    } catch (error) {
      callFailures += 1;
      log.warn(
        { a: pair.aConditionId, b: pair.bConditionId, error: describeError(error) },
        'proposal call failed, pair skipped',
      );
      continue;
    }

    const parsed = proposalResponseSchema.safeParse(extractJson(raw));
    if (!parsed.success) {
      parseFailures += 1;
      log.warn(
        {
          a: pair.aConditionId,
          b: pair.bConditionId,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          raw: raw.slice(0, 300),
        },
        'proposal did not parse, pair skipped and never guessed at',
      );
      continue;
    }

    if (parsed.data.relation === 'unrelated') unrelated += 1;
    if (parsed.data.relation === 'unrelated' && !keepUnrelated) continue;

    const proposal: RelationProposal = {
      aConditionId: pair.aConditionId,
      bConditionId: pair.bConditionId,
      relation: parsed.data.relation,
      rationale: parsed.data.rationale,
      confidence: parsed.data.confidence,
      model: client.model,
      similarity: pair.similarity ?? null,
    };
    proposals.push(proposal);
    await options.onProposal?.(proposal);
  }

  return {
    proposals,
    stats: {
      considered: pairs.length,
      proposed: proposals.length,
      unrelated,
      parseFailures,
      callFailures,
    },
  };
}
