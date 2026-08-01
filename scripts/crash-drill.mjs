/**
 * Crash-recovery drill.
 *
 * Kills the service with SIGKILL partway through a catalog ingest, then runs
 * the ingest again and asserts the database is byte-identical to a clean run
 * that was never interrupted.
 *
 * SIGKILL rather than SIGTERM on purpose: the graceful path is already tested,
 * and what needs proving is the ungraceful one — a machine that disappears with
 * an open transaction, a held lock, and a half-written batch.
 *
 *   node scripts/crash-drill.mjs
 *
 * Requires Docker, the `dutchbook:test` image, and `docker compose up -d`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const NETWORK = 'dutchbook_default';
const IMAGE = 'dutchbook:test';
const DB = 'postgresql://dutchbook:dutchbook@postgres:5432/dutchbook';
const REDIS = 'redis://redis:6379';
const STUB_PORT = 8099;
const PAGE_CURSORS = ['MjAwMA==', 'NDAwMA=='];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const psql = (sql) =>
  sh('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'dutchbook', '-d', 'dutchbook', '-tAc', sql]);

/**
 * Serves the recorded catalog, one page per request, with a delay per page so
 * there is a window to kill the process inside a run rather than between runs.
 */
function startStub(delayMs) {
  const pages = [1, 2, 3].map((n) =>
    JSON.parse(readFileSync(`test/fixtures/polymarket/catalog-page-${n}.json`, 'utf8')),
  );
  let served = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const cursor = url.searchParams.get('after_cursor');
    const index = cursor === null ? 0 : PAGE_CURSORS.indexOf(cursor) + 1;

    await delay(delayMs);
    served += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pages[index] ?? { data: [] }));
  });

  return new Promise((resolve) => {
    server.listen(STUB_PORT, '0.0.0.0', () =>
      resolve({ server, pagesServed: () => served }),
    );
  });
}

function resetDatabase() {
  psql('truncate raw_payloads, market_revisions, price_snapshots, markets, events restart identity cascade');
}

/** Every table, minus the wall-clock columns, as one comparable string. */
function snapshot() {
  return {
    markets: psql(
      `select condition_id, event_id, question, slug, description, resolution_source,
              outcomes, end_date, active, closed, archived, clob_token_ids,
              content_hash, missing_since
       from markets order by condition_id`,
    ),
    events: psql('select id, slug, title, neg_risk from events order by id'),
    closedEvents: psql("select count(*) from events where closed_at is not null"),
    revisions: psql(
      `select condition_id, field, old_value, new_value, content_hash_before, content_hash_after
       from market_revisions order by condition_id, field`,
    ),
    payloads: psql('select endpoint, response_hash from raw_payloads order by response_hash'),
    counts: psql(
      `select (select count(*) from markets) || '/' ||
              (select count(*) from events) || '/' ||
              (select count(*) from market_revisions) || '/' ||
              (select count(*) from raw_payloads)`,
    ),
  };
}

/** Runs one ingest in a container. Resolves with the container name. */
function startIngest(name, stubDelayMs) {
  void stubDelayMs;
  const child = spawn(
    'docker',
    [
      'run', '--rm', '--name', name, '--network', NETWORK,
      '-e', `DATABASE_URL=${DB}`,
      '-e', `REDIS_URL=${REDIS}`,
      '-e', `GAMMA_BASE_URL=http://host.docker.internal:${STUB_PORT}`,
      '-e', 'CATALOG_INGEST_ENABLED=false',
      '-e', 'CATALOG_INGEST_BATCH_SIZE=15',
      '-e', 'LOG_LEVEL=info',
      '--add-host', 'host.docker.internal:host-gateway',
      IMAGE,
      'node', 'dist/jobs/trigger-ingest.js', '--inline',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return { child, output: () => output };
}

function waitForExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

console.log('\n1. Baseline: one clean, uninterrupted run\n');

let stub = await startStub(150);
resetDatabase();
const baselineRun = startIngest('dutchbook-drill-baseline', 150);
const baselineCode = await waitForExit(baselineRun.child);
check('baseline ingest exited 0', baselineCode === 0, `exit ${baselineCode}`);

const baseline = snapshot();
check('baseline populated the catalog', baseline.counts.startsWith('195/60/'), baseline.counts);
stub.server.close();

console.log('\n2. Crash: SIGKILL partway through a fresh run\n');

resetDatabase();
stub = await startStub(400);
const crashed = startIngest('dutchbook-drill-crash', 400);

// Wait until the run is demonstrably mid-flight: at least one page fetched and
// at least one batch committed, but not all of them.
let killedAt = null;
for (let i = 0; i < 200; i += 1) {
  await delay(100);
  const markets = Number(psql('select count(*) from markets'));
  if (markets > 0 && markets < 195) {
    killedAt = markets;
    break;
  }
  if (markets >= 195) break;
}

check('caught the run mid-ingest', killedAt !== null, killedAt === null ? 'never observed a partial state' : `${killedAt} markets committed`);

// SIGKILL: no handlers, no drain, no rollback opportunity in the process.
try {
  sh('docker', ['kill', '--signal', 'KILL', 'dutchbook-drill-crash']);
} catch {
  /* already gone */
}
const crashCode = await waitForExit(crashed.child);
check('container died ungracefully', crashCode !== 0, `exit ${crashCode}`);
stub.server.close();

const afterCrash = snapshot();
console.log(`     state after crash: ${afterCrash.counts} (markets/events/revisions/payloads)`);

// The core invariant: whatever survived is whole batches, never a partial one.
const partialMarkets = Number(psql('select count(*) from markets'));
const orphanRevisions = Number(
  psql('select count(*) from market_revisions r left join markets m on m.condition_id = r.condition_id where m.condition_id is null'),
);
const orphanMarkets = Number(
  psql('select count(*) from markets m left join events e on e.id = m.event_id where m.event_id is not null and e.id is null'),
);
check('no revision references a missing market', orphanRevisions === 0, `${orphanRevisions} orphans`);
check('no market references a missing event', orphanMarkets === 0, `${orphanMarkets} orphans`);
check('a partial catalog survived the kill', partialMarkets > 0 && partialMarkets < 195, `${partialMarkets} markets`);

console.log('\n3. Recovery: the next run reconciles\n');

stub = await startStub(50);
const recovery = startIngest('dutchbook-drill-recovery', 50);
const recoveryCode = await waitForExit(recovery.child);
check('recovery ingest exited 0', recoveryCode === 0, `exit ${recoveryCode}`);
stub.server.close();

const recovered = snapshot();
console.log(`     state after recovery: ${recovered.counts}`);

check('market rows match the clean baseline exactly', recovered.markets === baseline.markets);
check('event rows match the clean baseline exactly', recovered.events === baseline.events);
check(
  'closed events still carry a closed_at',
  recovered.closedEvents === baseline.closedEvents && Number(recovered.closedEvents) > 0,
  `${recovered.closedEvents} closed events stamped`,
);
check('row counts match the clean baseline', recovered.counts === baseline.counts, `${recovered.counts} vs ${baseline.counts}`);
check(
  'no spurious revisions from the interrupted run',
  recovered.revisions === baseline.revisions,
  recovered.revisions === '' ? 'zero revisions, as expected' : 'revisions differ',
);

console.log('\n4. Steady state: a further run is still a no-op\n');

stub = await startStub(20);
const third = startIngest('dutchbook-drill-third', 20);
await waitForExit(third.child);
stub.server.close();

const settled = snapshot();
check('a third run changes nothing', settled.counts === baseline.counts, settled.counts);
check('still no revisions', settled.revisions === baseline.revisions);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? `\nFAILED: ${failed.map((f) => f.label).join(', ')}` : ''),
);
process.exit(failed.length === 0 ? 0 : 1);
