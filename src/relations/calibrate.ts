import { sql } from 'drizzle-orm';

import { closeDatabase, db } from '../db/client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { bandsAreDisjoint, parseBand, type Band } from './bands.js';
import {
  createAnthropicClient,
  proposalResponseSchema,
  extractJson,
  buildUserPrompt,
  SYSTEM_PROMPT,
  type CandidatePair,
  type ProposedType,
} from './proposer.js';

/**
 * `pnpm relations:calibrate [--per-class=40]`
 *
 * Measures the classifier against ground truth, and writes nothing anywhere.
 *
 * This exists because the acceptance rate produced by `relations:review` is not
 * on its own a measurement of the model. It is a measurement of the model *as
 * judged by whoever reviewed*, on whatever pairs happened to reach the top of
 * the queue, with no denominator for the relations the model missed. That
 * number is worth reporting — it is what a reviewer actually experienced — but
 * it is not evidence about reliability, and publishing it as though it were
 * would be the more misleading of the two options.
 *
 * So this harness builds three sets whose correct answer is known before the
 * model is asked, from sources the model cannot see:
 *
 *   implies             — pairs the deterministic threshold-ladder and temporal
 *                         extractors already connected. Parser output, not
 *                         model output, and not mentioned in the prompt.
 *   mutually_exclusive  — disjoint numeric bands over the same subject and
 *                         date. Two ranges that do not overlap cannot both
 *                         contain the settlement price. This is arithmetic.
 *   unrelated           — markets drawn from two different events. Not a proof,
 *                         but as close to one as this catalog offers.
 *
 * The result is a confusion matrix, which is a claim that can be checked. Note
 * what it still cannot tell you: all three classes are drawn from families the
 * deterministic extractors could already handle, so this measures the model on
 * cases where a right answer demonstrably exists — not on the open-ended pairs
 * the pipeline actually sends it. It is a floor on competence, not an estimate
 * of field precision.
 */

const log = createLogger('relations:calibrate');

type Label = Extract<ProposedType, 'implies' | 'implied_by' | 'mutually_exclusive' | 'unrelated'>;

interface LabelledPair extends CandidatePair {
  readonly truth: Label;
  readonly family: 'entailment' | 'bands' | 'cross-event';
}

/** Deterministic shuffle, so a re-run scores the same sample. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface MarketRow extends Record<string, unknown> {
  condition_id: string;
  event_id: string | null;
  question: string;
  description: string | null;
}

async function entailmentSet(count: number): Promise<LabelledPair[]> {
  const rows = await db.execute<MarketRow & { to_condition_id: string; to_question: string; to_description: string | null }>(sql`
    select fm.condition_id, fm.event_id, fm.question, fm.description,
           tm.condition_id as to_condition_id, tm.question as to_question,
           tm.description as to_description
    from relations r
    join markets fm on fm.condition_id = r.from_condition_id
    join markets tm on tm.condition_id = r.to_condition_id
    where r.source in ('ladder', 'temporal') and r.type = 'implies'
      and fm.question is not null and tm.question is not null
    order by md5(r.from_condition_id || r.to_condition_id)
    limit ${count}
  `);

  // Half are presented reversed. Direction is the most plausible place for the
  // model to be confidently wrong, and a set presented one way round would not
  // detect a classifier that always answers `implies`.
  return rows.map((row, index) => {
    const forward = index % 2 === 0;
    return forward
      ? {
          aConditionId: row.condition_id,
          aQuestion: row.question,
          aDescription: row.description,
          bConditionId: row.to_condition_id,
          bQuestion: row.to_question,
          bDescription: row.to_description,
          truth: 'implies' as const,
          family: 'entailment' as const,
        }
      : {
          aConditionId: row.to_condition_id,
          aQuestion: row.to_question,
          aDescription: row.to_description,
          bConditionId: row.condition_id,
          bQuestion: row.question,
          bDescription: row.description,
          truth: 'implied_by' as const,
          family: 'entailment' as const,
        };
  });
}

async function bandSet(count: number): Promise<LabelledPair[]> {
  const rows = await db.execute<MarketRow>(sql`
    select condition_id, event_id, question, description
    from markets
    where question ~ 'between .+ and ' and missing_since is null
    order by condition_id
  `);

  const byKey = new Map<string, Array<{ row: MarketRow; band: Band }>>();
  for (const row of rows) {
    const band = parseBand(row.question);
    if (band === null) continue;
    const key = `${row.event_id ?? ''}::${band.prefix}::${band.suffix}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ row, band });
  }

  const pairs: LabelledPair[] = [];
  for (const group of byKey.values()) {
    const sorted = group.toSorted((x, y) => x.band.low - y.band.low);
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (!bandsAreDisjoint(a.band, b.band)) continue;
      pairs.push({
        aConditionId: a.row.condition_id,
        aQuestion: a.row.question,
        aDescription: a.row.description,
        bConditionId: b.row.condition_id,
        bQuestion: b.row.question,
        bDescription: b.row.description,
        truth: 'mutually_exclusive',
        family: 'bands',
      });
    }
  }

  return seededShuffle(pairs, 20_260_801).slice(0, count);
}

async function crossEventSet(count: number): Promise<LabelledPair[]> {
  const rows = await db.execute<MarketRow>(sql`
    select distinct on (event_id) condition_id, event_id, question, description
    from markets
    where question is not null and question <> '' and missing_since is null
      and event_id is not null
    order by event_id, condition_id
  `);

  const shuffled = seededShuffle(rows, 20_260_802);
  const pairs: LabelledPair[] = [];
  for (let i = 0; i + 1 < shuffled.length && pairs.length < count; i += 2) {
    const a = shuffled[i]!;
    const b = shuffled[i + 1]!;
    pairs.push({
      aConditionId: a.condition_id,
      aQuestion: a.question,
      aDescription: a.description,
      bConditionId: b.condition_id,
      bQuestion: b.question,
      bDescription: b.description,
      truth: 'unrelated',
      family: 'cross-event',
    });
  }
  return pairs;
}

function bar(n: number, total: number): string {
  const width = total === 0 ? 0 : Math.round((n / total) * 24);
  return '█'.repeat(width).padEnd(24, '·');
}

async function main(): Promise<number> {
  const perClassArg = process.argv.find((a) => a.startsWith('--per-class='))?.split('=')[1];
  const perClass = Number.isFinite(Number(perClassArg)) ? Number(perClassArg) : 40;

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stdout.write('ANTHROPIC_API_KEY is not set\n');
    return 1;
  }

  const [entail, bands, cross] = await Promise.all([
    entailmentSet(perClass),
    bandSet(perClass),
    crossEventSet(perClass),
  ]);
  const cases = [...entail, ...bands, ...cross];

  log.info(
    { entailment: entail.length, bands: bands.length, crossEvent: cross.length },
    'calibration set built',
  );
  if (cases.length === 0) {
    process.stdout.write('\n  no labelled cases available in this database\n\n');
    return 1;
  }

  const client = createAnthropicClient({ apiKey });

  // Classified one at a time through exactly the production prompt. Anything
  // else would be measuring a different system than the one that runs.
  const results: Array<{ truth: Label; answer: ProposedType | 'ERROR'; pair: LabelledPair }> = [];
  for (const [index, pair] of cases.entries()) {
    let answer: ProposedType | 'ERROR' = 'ERROR';
    try {
      const raw = await client.complete(SYSTEM_PROMPT, buildUserPrompt(pair));
      const parsed = proposalResponseSchema.safeParse(extractJson(raw));
      if (parsed.success) answer = parsed.data.relation;
    } catch (error) {
      log.warn({ error: describeError(error) }, 'calibration call failed');
    }
    results.push({ truth: pair.truth, answer, pair });
    if ((index + 1) % 20 === 0) log.info({ done: index + 1, total: cases.length }, 'classifying');
  }

  // An `implies`/`implied_by` confusion is scored as wrong, deliberately: an
  // implication pointed the wrong way is not a weaker constraint, it is a
  // false one, and a solver would act on it.
  const families = ['entailment', 'bands', 'cross-event'] as const;
  const lines: string[] = [
    '',
    '  ── classifier calibration against ground truth ────────────────',
    `  model            ${client.model}`,
    `  cases            ${results.length}`,
    '',
  ];

  let correctAll = 0;
  for (const family of families) {
    const subset = results.filter((r) => r.pair.family === family);
    if (subset.length === 0) continue;
    const correct = subset.filter((r) => r.answer === r.truth).length;
    correctAll += correct;
    lines.push(
      `  ${family.padEnd(12)} ${bar(correct, subset.length)} ` +
        `${String(correct).padStart(3)}/${String(subset.length).padEnd(3)} ` +
        `${((correct / subset.length) * 100).toFixed(1)}%`,
    );

    const wrong = new Map<string, number>();
    for (const r of subset) {
      if (r.answer !== r.truth) wrong.set(r.answer, (wrong.get(r.answer) ?? 0) + 1);
    }
    for (const [answer, n] of [...wrong.entries()].toSorted((x, y) => y[1] - x[1])) {
      lines.push(`                 └─ said ${answer.padEnd(20)} ${n}`);
    }
  }

  lines.push(
    '',
    `  OVERALL          ${((correctAll / results.length) * 100).toFixed(1)}%  ` +
      `(${correctAll}/${results.length})`,
    '',
    '  Ground truth comes from the deterministic extractors, band arithmetic,',
    '  and event separation — never from the model. Nothing was written.',
    '  ───────────────────────────────────────────────────────────────',
    '',
  );
  process.stdout.write(lines.join('\n'));

  // A per-case dump, so a claim in the README can be traced to the cases
  // behind it rather than taken on trust.
  if (process.argv.includes('--verbose')) {
    for (const r of results) {
      if (r.answer === r.truth) continue;
      process.stdout.write(
        `\n  WRONG  truth=${r.truth} said=${r.answer}\n` +
          `    A ${r.pair.aQuestion}\n    B ${r.pair.bQuestion}\n`,
      );
    }
    process.stdout.write('\n');
  }

  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  log.error({ error: describeError(error) }, 'calibration failed');
}
await closeDatabase().catch(() => {});
process.exit(code);
