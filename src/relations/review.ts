import { createInterface } from 'node:readline/promises';

import { closeDatabase, db } from '../db/client.js';
import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';
import {
  loadPendingProposals,
  proposalPrecision,
  recordVerdict,
  type PendingProposal,
} from './proposals-store.js';

/**
 * `pnpm relations:review`
 *
 * Presents pending proposals one at a time and records a verdict for each.
 * This is the only path from a model's output into the graph.
 *
 * The reviewer's identity is recorded on every verdict, because the precision
 * number this produces is a claim about a model's reliability *as judged by
 * someone*, and a number without a judge attached cannot be interpreted.
 */

const log = createLogger('relations:review');

const RELATION_MEANING: Readonly<Record<string, string>> = {
  implies: 'A YES  ⇒  B YES        (P(A) ≤ P(B))',
  implied_by: 'B YES  ⇒  A YES        (P(B) ≤ P(A))',
  mutually_exclusive: 'never both YES         (P(A) + P(B) ≤ 1)',
  complement: 'exactly one YES        (P(A) + P(B) = 1)',
  unrelated: 'no logical constraint',
};

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line !== '' && line.length + word.length + 1 > width) {
      lines.push(line);
      line = '';
    }
    line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

/** Percentage, or an em dash when there is nothing to average. */
function pct(n: number | null, places = 1): string {
  return n === null ? '—' : `${(n * 100).toFixed(places)}%`;
}

function trim(text: string | null): string {
  return text === null || text.trim() === '' ? '(none)' : text.replace(/\s+/g, ' ').slice(0, 1500);
}

function render(proposal: PendingProposal, index: number, total: number): string {
  return [
    '',
    '─'.repeat(78),
    `  proposal ${index}/${total}   id ${proposal.id}   ${proposal.model}`,
    `  similarity ${pct(proposal.similarity, 0)}   model confidence ${pct(proposal.modelConfidence, 0)}`,
    '',
    '  A  ' + proposal.lowConditionId,
    wrap(proposal.lowQuestion, 72, '     '),
    '',
    '  B  ' + proposal.highConditionId,
    wrap(proposal.highQuestion, 72, '     '),
    '',
    `  PROPOSED: ${proposal.proposedType}`,
    `            ${RELATION_MEANING[proposal.proposedType] ?? ''}`,
    '',
    '  rationale:',
    wrap(proposal.rationale, 72, '     '),
    '',
    '  [a]ccept  [r]eject  [s]kip  [d]etail  [q]uit',
  ].join('\n');
}

function detail(proposal: PendingProposal): string {
  return [
    '',
    '  A resolution criteria:',
    wrap(trim(proposal.lowDescription), 72, '     '),
    '',
    '  B resolution criteria:',
    wrap(trim(proposal.highDescription), 72, '     '),
    '',
  ].join('\n');
}

/**
 * Applies verdicts a reviewer reached away from the terminal.
 *
 * The file is one `<id> <a|r|s> [note]` per line. This is a different input
 * device for the same act, not a way around it: every line still goes through
 * `recordVerdict`, still names a reviewer, and still cannot touch a proposal
 * that already has a verdict. What it does not do is let anything be decided
 * without someone having written the decision down.
 *
 * `--reviewer` is mandatory here, unlike the interactive path where the shell
 * user is a reasonable default. A batch file has no ambient identity, and an
 * unattributed precision number cannot be interpreted.
 */
async function applyFromFile(
  path: string,
  reviewer: string,
): Promise<{ applied: number; malformed: number }> {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  const statuses: Readonly<Record<string, 'accepted' | 'rejected' | 'skipped'>> = {
    a: 'accepted',
    r: 'rejected',
    s: 'skipped',
  };

  let applied = 0;
  let unchanged = 0;
  let edges = 0;
  let malformed = 0;

  for (const line of lines) {
    const [rawId, verdict, ...rest] = line.split(/\s+/);
    const proposalId = Number(rawId);
    const status = statuses[(verdict ?? '').toLowerCase()];
    if (!Number.isInteger(proposalId) || status === undefined) {
      process.stdout.write(`  ! malformed line, skipped: ${line}\n`);
      malformed += 1;
      continue;
    }

    const note = rest.join(' ').trim();
    const result = await recordVerdict(
      { proposalId, status, reviewedBy: reviewer, ...(note === '' ? {} : { note }) },
      db,
    );
    if (result.applied) applied += 1;
    else unchanged += 1;
    if (result.edgeWritten) edges += 1;
  }

  process.stdout.write(
    `\n  applied ${applied}   already decided ${unchanged}   malformed ${malformed}` +
      `\n  edges written ${edges}\n`,
  );
  return { applied, malformed };
}

async function main(): Promise<number> {
  const applyArg = process.argv.find((a) => a.startsWith('--apply='))?.split('=')[1];
  const reviewerArg = process.argv.find((a) => a.startsWith('--reviewer='))?.split('=')[1];

  if (applyArg !== undefined) {
    const reviewer = reviewerArg ?? process.env['REVIEWER'];
    if (reviewer === undefined || reviewer.trim() === '') {
      process.stdout.write(
        '\n  --apply requires --reviewer=<name> (or REVIEWER in the environment).\n' +
          '  A precision figure with no named judge cannot be interpreted.\n\n',
      );
      return 1;
    }
    const { applied, malformed } = await applyFromFile(applyArg, reviewer.trim());
    await summarize(applied);
    return malformed > 0 ? 2 : 0;
  }

  const reviewer =
    reviewerArg ??
    process.env['REVIEWER'] ??
    process.env['USER'] ??
    process.env['LOGNAME'] ??
    'unknown';

  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg === undefined ? 200 : Number(limitArg.split('=')[1]);

  const pending = await loadPendingProposals(db, {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
    includeUnrelated: process.argv.includes('--include-unrelated'),
  });

  if (pending.length === 0) {
    process.stdout.write('\n  no pending proposals to review\n\n');
    const stats = await proposalPrecision(db);
    process.stdout.write(
      `  reviewed ${stats.reviewed}  accepted ${stats.accepted}  rejected ${stats.rejected}` +
        `  precision ${pct(stats.precision)}\n\n`,
    );
    return 0;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let decided = 0;

  try {
    for (const [index, proposal] of pending.entries()) {
      process.stdout.write(render(proposal, index + 1, pending.length));

      let done = false;
      while (!done) {
        const answer = (await rl.question('\n  > ')).trim().toLowerCase();

        switch (answer) {
          case 'a':
          case 'accept': {
            const note = (await rl.question('  note (optional): ')).trim();
            const result = await recordVerdict(
              { proposalId: proposal.id, status: 'accepted', reviewedBy: reviewer, ...(note === '' ? {} : { note }) },
              db,
            );
            process.stdout.write(
              result.edgeWritten
                ? '  ✓ accepted — edge written to relations\n'
                : '  ✓ accepted — recorded, no edge (mutually_exclusive has no pairwise form yet)\n',
            );
            decided += 1;
            done = true;
            break;
          }
          case 'r':
          case 'reject': {
            const note = (await rl.question('  why (optional): ')).trim();
            await recordVerdict(
              { proposalId: proposal.id, status: 'rejected', reviewedBy: reviewer, ...(note === '' ? {} : { note }) },
              db,
            );
            process.stdout.write('  ✗ rejected — permanently, never re-proposed\n');
            decided += 1;
            done = true;
            break;
          }
          case 's':
          case 'skip':
            await recordVerdict(
              { proposalId: proposal.id, status: 'skipped', reviewedBy: reviewer },
              db,
            );
            process.stdout.write('  — skipped\n');
            done = true;
            break;
          case 'd':
          case 'detail':
            process.stdout.write(detail(proposal));
            break;
          case 'q':
          case 'quit':
            done = true;
            process.stdout.write('\n');
            return await summarize(decided);
          default:
            process.stdout.write('  a / r / s / d / q\n');
        }
      }
    }
  } finally {
    rl.close();
  }

  return await summarize(decided);
}

async function summarize(decided: number): Promise<number> {
  const stats = await proposalPrecision(db);

  process.stdout.write(
    [
      '',
      '  ── review session ─────────────────────────────────────────────',
      `  decided this session   ${decided}`,
      `  accepted (all time)    ${stats.accepted}`,
      `  rejected (all time)    ${stats.rejected}`,
      `  skipped                ${stats.skipped}`,
      `  still pending          ${stats.pending}`,
      `  PRECISION              ${pct(stats.precision)}   (accepted / decided)`,
      '',
      ...stats.byType.map(
        (t) =>
          `    ${t.proposedType.padEnd(20)} ${String(t.accepted).padStart(4)} / ` +
          `${String(t.accepted + t.rejected).padStart(4)}   ${pct(t.precision)}`,
      ),
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
  log.error({ error: describeError(error) }, 'review failed');
}
await closeDatabase().catch(() => {});
process.exit(code);
