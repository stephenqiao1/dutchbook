/**
 * Prices a hand-picked market against its live order book and prints the
 * numbers a Polymarket order ticket shows, so the two can be compared directly.
 *
 * `pnpm tsx scripts/verify-executable-cost.mts <token_id> [size] [category]`
 *
 * The category is optional and only affects the fee line — the venue does not
 * publish it, so without one the conservative 0.07 rate applies and the total
 * is an upper bound. Notional and average price are exact either way.
 *
 * The UI's order ticket, when you type a share count into the Buy side, shows
 * the average price it expects to pay and the total cost. Both come from
 * walking the same public book this script walks, so if `executableCost` is
 * right the two agree to the tick.
 *
 * A second, deliberately independent calculation runs alongside — written
 * straight off the raw JSON, sorting nothing and sharing no code with
 * `executableCost` — because a walker checked only against itself proves
 * nothing. If they disagree, the disagreement is the finding.
 */
import { ClobClient, topOfBook } from '../src/polymarket/clob.js';
import { resolveFeeRate, takerFee } from '../src/pricing/costs.js';
import { executableCost } from '../src/pricing/executable.js';

const tokenId = process.argv[2];
const size = Number(process.argv[3] ?? 500);
const category = process.argv[4];

if (tokenId === undefined || tokenId === '') {
  console.error('usage: verify-executable-cost.mts <token_id> [size]');
  process.exit(1);
}

const client = new ClobClient();

const raw = await fetch('https://clob.polymarket.com/books', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify([{ token_id: tokenId }]),
}).then((r) => r.json() as Promise<Array<{ asks?: { price: string; size: string }[] }>>);

const book = await client.fetchBook(tokenId);
if (book === null) {
  console.error(`no book for token ${tokenId}`);
  process.exit(1);
}

const baseFeeBps = await client.fetchBaseFeeBps(tokenId);
const feeRate = resolveFeeRate({ baseFeeBps, category });

const top = topOfBook(book);
const cost = executableCost(book, 'buy', size, { feeRate });

// --- independent check, straight off the raw payload -----------------------
// Sorts ascending itself rather than reusing the client's normalisation, so a
// bug in that normalisation cannot hide here.
const rawAsks = (raw[0]?.asks ?? [])
  .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
  .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
  .toSorted((a, b) => a.price - b.price);

let remaining = size;
let checkNotional = 0;
let checkFilled = 0;
let checkFee = 0;
for (const level of rawAsks) {
  if (remaining <= 0) break;
  const take = Math.min(remaining, level.size);
  checkNotional += take * level.price;
  checkFee += takerFee(take, level.price, feeRate);
  checkFilled += take;
  remaining -= take;
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const cents = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(2)}¢`);

console.log(`
  ── buy ${size} shares ────────────────────────────────────────────
  token            ${tokenId.slice(0, 20)}…
  market           ${book.conditionId ?? '(unknown)'}
  book built       ${book.timestamp?.toISOString() ?? '(no timestamp)'}
  staleness        ${book.timestamp === null ? '—' : `${Date.now() - book.timestamp.getTime()} ms`}

  best ask         ${cents(top.ask)}      best bid ${cents(top.bid)}
  spread           ${cents(top.spread)}   midpoint ${cents(top.mid)}
  ask depth        ${book.asks.reduce((s, l) => s + l.size, 0).toLocaleString()} shares over ${book.asks.length} levels

  ── what the order ticket should say ──────────────────────────────
  filled           ${cost.filled} / ${size}${cost.partial ? '  (PARTIAL — book too thin)' : ''}
  avg price        ${cents(cost.avgPrice)}
  total (no fee)   ${usd(cost.notional)}
  fee              ${usd(cost.fee)}   (rate ${feeRate}${category === undefined ? ' — conservative default, category not published' : ` — ${category}`}, base_fee ${baseFeeBps ?? 'n/a'})
  TOTAL COST       ${usd(cost.totalCost)}
  effective price  ${cents(cost.effectivePrice)}
  slippage vs ask  ${cost.slippage === null ? '—' : `${(cost.slippage * 100).toFixed(3)}%`}
  levels consumed  ${cost.levelsConsumed}

  ── independent recomputation from raw JSON ───────────────────────
  filled           ${checkFilled}
  notional         ${usd(checkNotional)}
  fee              ${usd(checkFee)}
  agrees           ${
    Math.abs(checkNotional - cost.notional) < 1e-9 &&
    Math.abs(checkFee - cost.fee) < 1e-9 &&
    checkFilled === cost.filled
      ? 'YES'
      : 'NO — investigate'
  }

  Compare against the Polymarket UI order ticket for this market.
  ──────────────────────────────────────────────────────────────────
`);

// The first few levels, so the arithmetic above can be checked by hand.
console.log('  first ask levels the order walks:');
let cumulative = 0;
for (const level of book.asks.slice(0, 8)) {
  cumulative += level.size;
  console.log(
    `    ${(level.price * 100).toFixed(2).padStart(6)}¢  ×${String(level.size).padStart(10)}` +
      `   cumulative ${cumulative.toFixed(0).padStart(10)}`,
  );
}
console.log('');
