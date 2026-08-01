import { inArray, sql } from 'drizzle-orm';

import { closeDatabase, db } from '../db/client.js';
import { markets } from '../db/schema.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import { embedMarkets, findCandidatePairs, DEFAULT_SIMILARITY_THRESHOLD } from './candidates.js';
import { createEmbedder } from './embeddings.js';
import { saveProposals } from './proposals-store.js';
import { createAnthropicClient, proposeRelations, type CandidatePair } from './proposer.js';

/**
 * `pnpm relations:propose [--limit=N] [--threshold=0.82] [--dry-run]`
 *
 * Embeds anything new, draws candidate pairs from the vector index, asks the
 * model about each, and stores the answers as pending proposals.
 *
 * Writes nothing to `relations`. Every row it creates needs a verdict from
 * `pnpm relations:review` before it constrains anything.
 *
 * Re-running is free for pairs already seen: the candidate query excludes any
 * pair with an existing proposal, whatever its verdict.
 */

const log = createLogger('relations:propose');

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function main(): Promise<number> {
  const limit = numberArg('limit', 200);
  const threshold = numberArg('threshold', DEFAULT_SIMILARITY_THRESHOLD);
  const dryRun = process.argv.includes('--dry-run');

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stdout.write('ANTHROPIC_API_KEY is not set\n');
    return 1;
  }

  // 1. Embeddings, only for markets whose question actually changed.
  const toEmbed = await db.execute<{ condition_id: string; question: string; content_hash: string }>(sql`
    select condition_id, question, content_hash
    from markets
    where question is not null and question <> '' and missing_since is null
  `);
  log.info({ markets: toEmbed.length }, 'embedding pass');

  const embedder = createEmbedder();
  const embedded = await embedMarkets(
    toEmbed.map((r) => ({
      conditionId: r.condition_id,
      question: r.question,
      contentHash: r.content_hash,
    })),
    embedder,
    db,
    { onProgress: (done, total) => { if (done % 2048 === 0) log.info({ done, total }, 'embedding'); } },
  );

  // 2. Candidates the deterministic extractors did not already explain.
  //
  // `--spread` samples the eligible population uniformly instead of taking the
  // most-similar pairs. Use it when the point of the run is to measure how
  // reliable the model is, rather than to harvest the easiest edges.
  const order = process.argv.includes('--spread') ? 'spread' : 'similarity';
  const candidates = await findCandidatePairs(db, { threshold, limit, order });
  log.info({ candidates: candidates.length, threshold, order }, 'candidate pairs');

  if (candidates.length === 0) {
    process.stdout.write('\n  no new candidate pairs — nothing to propose\n\n');
    return 0;
  }

  const ids = [...new Set(candidates.flatMap((c) => [c.lowConditionId, c.highConditionId]))];
  const texts = await db
    .select({
      conditionId: markets.conditionId,
      question: markets.question,
      description: markets.description,
    })
    .from(markets)
    .where(inArray(markets.conditionId, ids));
  const byId = new Map(texts.map((r) => [r.conditionId, r]));

  const pairs: CandidatePair[] = candidates.flatMap((candidate) => {
    const a = byId.get(candidate.lowConditionId);
    const b = byId.get(candidate.highConditionId);
    if (a === undefined || b === undefined) return [];
    if (a.question === null || b.question === null) return [];
    return [{
      aConditionId: a.conditionId,
      aQuestion: a.question,
      aDescription: a.description,
      bConditionId: b.conditionId,
      bQuestion: b.question,
      bDescription: b.description,
      similarity: candidate.similarity,
    }];
  });

  if (dryRun) {
    process.stdout.write(`\n  ${pairs.length} candidate pairs (dry run, no model calls)\n\n`);
    for (const pair of pairs.slice(0, 20)) {
      process.stdout.write(
        `  ${(pair.similarity ?? 0).toFixed(3)}  ${pair.aQuestion.slice(0, 62)}\n` +
          `         ${pair.bQuestion.slice(0, 62)}\n\n`,
      );
    }
    return 0;
  }

  // 3. Classify. The client is the only thing here that touches the network.
  const client = createAnthropicClient({ apiKey });
  const { proposals, stats } = await proposeRelations(pairs, client);

  // 4. Persist as pending. Nothing enters `relations` on this path.
  const saved = await saveProposals(proposals, db);

  process.stdout.write(
    [
      '',
      '  ── proposal run ───────────────────────────────────────────────',
      `  embedded          ${embedded.embedded} (${embedded.skipped} already current)`,
      `  candidate pairs   ${pairs.length}  (similarity ≥ ${threshold})`,
      `  model answers     ${stats.proposed}   unrelated ${stats.unrelated}`,
      `  parse failures    ${stats.parseFailures}   call failures ${stats.callFailures}`,
      `  stored pending    ${saved.inserted}   already known ${saved.duplicate}`,
      '',
      '  Nothing entered the graph. Run `pnpm relations:review` to decide.',
      '  ───────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  log.error({ error: describeError(error) }, 'propose failed');
}
await closeDatabase().catch(() => {});
process.exit(code);
