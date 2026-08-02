/**
 * The dashboard client.
 *
 * Vanilla, no framework, no build. Hash routing so the whole thing is one
 * document the server never re-renders, and every view is a pure function from
 * fetched JSON to DOM.
 *
 * The one rule worth stating: **nothing is ever assigned to `innerHTML` from
 * server data.** Market questions are attacker-controlled — anyone can create a
 * market on Polymarket — so every value goes in through `textContent` or an
 * attribute. The helpers below make that the path of least resistance rather
 * than a thing to remember.
 */
export const JS = String.raw`
const VIEWS = {
  '': status,
  '/': status,
  '/violations': violations,
  '/lifetimes': lifetimes,
  '/families': families,
};

const view = document.getElementById('view');

// --- tiny DOM helpers ------------------------------------------------------

/**
 * Elements are built, never parsed. Text always arrives as a text node, so a
 * market question containing markup is a question containing markup and not a
 * script tag.
 */
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const fmtInt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Number(seconds));
  if (s < 60) return s.toFixed(0) + 's';
  if (s < 3600) return (s / 60).toFixed(1) + 'm';
  if (s < 86400) return (s / 3600).toFixed(1) + 'h';
  return (s / 86400).toFixed(1) + 'd';
}

/** Edges are per-share, so cents is the unit a trader actually thinks in. */
function fmtEdge(edge) {
  if (edge === null || edge === undefined) return '—';
  return (Number(edge) * 100).toFixed(2) + '¢';
}

const fmtMoney = (v) => (v === null || v === undefined ? '—' : '$' + Number(v).toFixed(2));
const fmtProb = (p) => (p === null || p === undefined ? '—' : Number(p).toFixed(3));

function fmtAgo(iso) {
  if (!iso) return 'never';
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return '—';
  return fmtDuration(seconds) + ' ago';
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function show(nodes) {
  view.replaceChildren(...nodes);
}

function loading() {
  show([el('p', { class: 'empty', text: 'Loading…' })]);
}

function card(k, v, s) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v }),
    s ? el('div', { class: 's', text: s }) : null,
  ]);
}

/**
 * A cell that keeps its column name on phones, where the header is gone.
 *
 * The value is always wrapped in an element, never left as a bare text node.
 * On phones the cell is a flex row, and an anonymous text box cannot be given a
 * zero min-width — so a long constraint key refuses to shrink and pushes the
 * whole page wider than the screen, which is exactly what it did.
 */
function td(label, value, cls) {
  const node = el('td', { 'data-label': label, class: cls || null });
  const wrap = el('span', { class: 'tv' });
  if (typeof value === 'string' || typeof value === 'number') wrap.textContent = String(value);
  else if (value) wrap.append(value);
  node.append(wrap);
  return node;
}

function statusTag(row) {
  if (row.everConfirmed) return el('span', { class: 'tag confirmed', text: 'confirmed' });
  return el('span', { class: 'tag apparent', text: 'apparent' });
}

function polymarketLink(slug, text) {
  if (!slug) return el('span', { class: 'q', text: text || '—' });
  return el('a', {
    class: 'q',
    href: 'https://polymarket.com/market/' + encodeURIComponent(slug),
    rel: 'noopener noreferrer',
    target: '_blank',
    text: text || slug,
  });
}

// --- 1. live status --------------------------------------------------------

async function status() {
  loading();
  const data = await getJSON('/api/status');
  const v = data.violations;

  const cards = el('div', { class: 'cards' }, [
    card('Markets tracked', fmtInt(data.markets.tracked), fmtInt(data.markets.closed) + ' closed'),
    card('Relation edges', fmtInt(data.relations.edges), fmtInt(data.relations.groups) + ' partition groups'),
    card('Open violations', fmtInt(v.openConfirmed), fmtInt(v.openApparent) + ' apparent'),
    card('Confirmed, all time', fmtInt(v.everConfirmed), fmtInt(v.total) + ' episodes'),
    card('Median lifetime', fmtDuration(v.medianLifetimeSeconds), 'confirmed, closed'),
    card('Last ingest', fmtAgo(data.ingest && data.ingest.lastSuccessAt), data.ingest && data.ingest.lastSuccessAt ? 'succeeded' : 'no record'),
  ]);

  const sources = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Source' }),
        el('th', { text: 'Type' }),
        el('th', { class: 'num', text: 'Edges' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      data.relations.bySource.map((row) =>
        el('tr', {}, [
          td('Source', el('span', { class: 'mono', text: row.source })),
          td('Type', row.type),
          td('Edges', fmtInt(row.count), 'num'),
        ]),
      ),
    ),
  ]);

  const openRows = data.open.map((row) =>
    el('tr', {}, [
      td('Market', polymarketLink(row.slug, row.question || row.constraintKey), 'wide'),
      td('Constraint', el('span', { class: 'mono', text: row.constraintKey })),
      td('Status', statusTag({ everConfirmed: row.status === 'confirmed' })),
      td('Net edge', fmtEdge(row.netEdge), 'num'),
      td('Profit', fmtMoney(row.netProfit), 'num'),
      td('Age', fmtDuration(row.ageSeconds), 'num'),
    ]),
  );

  const openTable = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Market' }),
        el('th', { text: 'Constraint' }),
        el('th', { text: 'Status' }),
        el('th', { class: 'num', text: 'Net edge' }),
        el('th', { class: 'num', text: 'Profit' }),
        el('th', { class: 'num', text: 'Age' }),
      ]),
    ]),
    el('tbody', {}, openRows),
  ]);

  show([
    el('h2', { text: 'Live status' }),
    // The panels are served stale-while-revalidate, so this is the honest
    // answer to "how current is this" — without it, stale would be invisible.
    el('p', { class: 'note', text: 'Snapshot taken ' + fmtAgo(data.generatedAt) + '. Refreshes every 30s.' }),
    cards,
    el('h2', { text: 'Relation edges by source' }),
    data.relations.bySource.length
      ? el('div', { class: 'panel' }, [sources])
      : el('p', {
          class: 'empty',
          text: 'No relations extracted yet. Run relations:extract to populate the graph.',
        }),
    el('h2', { text: 'Currently open violations' }),
    el('p', {
      class: 'note',
      text: 'Confirmed means a correcting trade was priced against live depth and still made money after fees and slippage. Apparent means the gap was real on midpoints but the spread ate it.',
    }),
    data.open.length
      ? el('div', { class: 'panel' }, [openTable])
      : el('p', { class: 'empty', text: 'Nothing open. Every constraint is currently satisfied.' }),
  ]);
}

// --- 2. violation history --------------------------------------------------

const COLUMNS = [
  { key: 'question', label: 'Market', wide: true, sort: 'question' },
  { key: 'constraintKey', label: 'Constraint', sort: 'constraintKey' },
  { key: 'kind', label: 'Kind', sort: 'kind' },
  { key: 'status', label: 'Status', sort: 'everConfirmed' },
  { key: 'peakNetEdge', label: 'Peak edge', num: true, sort: 'peakNetEdge' },
  { key: 'lifetimeSeconds', label: 'Lifetime', num: true, sort: 'lifetimeSeconds' },
  { key: 'detectedAt', label: 'Detected', num: true, sort: 'detectedAt' },
];

let sortKey = 'detectedAt';
let sortDir = -1;

async function violations() {
  loading();
  const data = await getJSON('/api/violations?limit=500');
  const rows = data.violations;

  /**
   * A sort control, not just clickable headers.
   *
   * On a phone the table is a stack of cards and the header row is display:none
   * — so "tap a column to sort" is an instruction about something that is not
   * on screen. The select is the only way to sort on the device this is meant
   * to be legible on.
   */
  const sortPicker = el(
    'select',
    { 'aria-label': 'Sort by' },
    COLUMNS.map((col) => el('option', { value: col.sort, text: 'Sort: ' + col.label })),
  );
  const dirButton = el('button', { type: 'button', 'aria-label': 'Reverse sort order' });

  const controls = el('div', { class: 'controls' }, [
    sortPicker,
    dirButton,
    el('span', {
      class: 'note',
      text: 'Showing ' + rows.length + ' of ' + fmtInt(data.total) + ' episodes.',
    }),
  ]);

  const body = el('tbody');
  const head = el(
    'tr',
    {},
    COLUMNS.map((col) =>
      el('th', {
        'data-sort': col.sort,
        class: col.num ? 'num' : null,
        text: col.label,
        role: 'button',
        tabindex: '0',
      }),
    ),
  );

  function render() {
    const sorted = rows.slice().sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x > y ? 1 : -1) * sortDir;
    });

    body.replaceChildren(
      ...sorted.map((row) =>
        el('tr', {}, [
          td('Market', polymarketLink(row.slug, row.question || '(market not in catalog)'), 'wide'),
          td('Constraint', el('span', { class: 'mono', text: row.constraintKey })),
          td('Kind', row.kind),
          td(
            'Status',
            el('span', {}, [
              statusTag(row),
              row.open ? el('span', { class: 'tag open', text: 'open' }) : null,
            ]),
          ),
          td('Peak edge', fmtEdge(row.peakNetEdge), 'num'),
          td('Lifetime', fmtDuration(row.lifetimeSeconds) + (row.open ? '+' : ''), 'num'),
          td('Detected', fmtAgo(row.detectedAt), 'num'),
        ]),
      ),
    );

    for (const th of head.children) {
      const key = th.getAttribute('data-sort');
      if (key === sortKey) th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    }

    sortPicker.value = sortKey;
    dirButton.textContent = sortDir === 1 ? '\u2191 Ascending' : '\u2193 Descending';
  }

  function onSort(event) {
    const key = event.target.getAttribute && event.target.getAttribute('data-sort');
    if (!key) return;
    if (key === sortKey) sortDir = -sortDir;
    else {
      sortKey = key;
      // Numbers and dates are most useful largest-first; text is not.
      sortDir = key === 'question' || key === 'constraintKey' || key === 'kind' ? 1 : -1;
    }
    render();
  }

  sortPicker.addEventListener('change', () => {
    sortKey = sortPicker.value;
    sortDir = sortKey === 'question' || sortKey === 'constraintKey' || sortKey === 'kind' ? 1 : -1;
    render();
  });
  dirButton.addEventListener('click', () => {
    sortDir = -sortDir;
    render();
  });

  head.addEventListener('click', onSort);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSort(e);
    }
  });

  render();

  show([
    el('h2', { text: 'Violation history' }),
    controls,
    rows.length
      ? el('div', { class: 'panel' }, [el('table', {}, [el('thead', {}, [head]), body])])
      : el('p', { class: 'empty', text: 'No violations recorded yet.' }),
  ]);
}

// --- 3. lifetime distribution ----------------------------------------------

let chart = null;

async function lifetimes() {
  loading();
  const data = await getJSON('/api/lifetimes');

  const cards = el('div', { class: 'cards' }, [
    card('Closed episodes', fmtInt(data.closed)),
    card('Median lifetime', fmtDuration(data.medianSeconds)),
    card('p90 lifetime', fmtDuration(data.p90Seconds)),
    card('Median, confirmed', fmtDuration(data.confirmedMedianSeconds)),
  ]);

  const canvas = el('canvas', { id: 'lifetime-chart' });
  const wrap = el('div', { class: 'chart-wrap' }, [el('div', { class: 'chart-box' }, [canvas])]);

  show([
    el('h2', { text: 'Violation lifetime distribution' }),
    cards,
    el('h2', { text: 'How long they last' }),
    el('p', {
      class: 'note',
      text: 'Closed episodes only — an open one has no lifetime yet. The left of this chart is the part nobody could have traded by hand.',
    }),
    wrap,
  ]);

  if (!data.closed) {
    wrap.replaceChildren(el('p', { class: 'empty', text: 'No closed episodes yet.' }));
    return;
  }

  // The library is a CDN script; the page must still work when it does not load.
  if (typeof Chart === 'undefined') {
    wrap.replaceChildren(
      el('p', { class: 'err', text: 'Chart library unavailable. Counts by bucket:' }),
      el(
        'ul',
        {},
        data.buckets.map((b) => el('li', { text: b.label + ': ' + b.count + ' (' + b.confirmed + ' confirmed)' })),
      ),
    );
    return;
  }

  const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim();
  const line = getComputedStyle(document.body).getPropertyValue('--line').trim();

  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.buckets.map((b) => b.label),
      datasets: [
        {
          label: 'Apparent',
          data: data.buckets.map((b) => b.count - b.confirmed),
          backgroundColor: 'rgba(127,127,127,0.45)',
        },
        {
          label: 'Confirmed',
          data: data.buckets.map((b) => b.confirmed),
          backgroundColor: 'rgba(47,109,58,0.85)',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: ink, maxRotation: 60, minRotation: 0 } },
        y: { stacked: true, beginAtZero: true, grid: { color: line }, ticks: { color: ink, precision: 0 } },
      },
      plugins: {
        legend: { labels: { color: ink, boxWidth: 12 } },
        tooltip: { callbacks: { title: (items) => 'Lifetime ' + items[0].label } },
      },
    },
  });
}

// --- 4. market family view -------------------------------------------------

async function families() {
  loading();
  const list = await getJSON('/api/families');

  if (!list.families.length) {
    show([
      el('h2', { text: 'Market families' }),
      el('p', { class: 'empty', text: 'No families in the graph yet.' }),
    ]);
    return;
  }

  const picker = el(
    'select',
    { id: 'family-picker', 'aria-label': 'Choose a market family' },
    list.families.map((f) =>
      el('option', { value: f.key, text: f.kind + ' · ' + f.members + ' · ' + f.label }),
    ),
  );

  const target = el('div', { id: 'family-target' });

  show([
    el('h2', { text: 'Market family' }),
    el('p', {
      class: 'note',
      text: 'A partition must sum to exactly 1. A ladder must never price a market above something it entails. Both constraints are drawn, so a violation is the picture being wrong rather than a number you have to check.',
    }),
    el('div', { class: 'controls' }, [picker]),
    target,
  ]);

  const initial = location.hash.split('?')[1];
  const wanted = initial && new URLSearchParams(initial).get('family');
  if (wanted && list.families.some((f) => f.key === wanted)) picker.value = wanted;

  async function load() {
    target.replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));
    try {
      const family = await getJSON('/api/families/' + encodeURIComponent(picker.value));
      target.replaceChildren(family.kind === 'partition' ? drawPartition(family) : drawLadder(family));
    } catch (err) {
      target.replaceChildren(el('p', { class: 'err', text: String(err.message || err) }));
    }
  }

  picker.addEventListener('change', load);
  await load();
}

function verdict(family) {
  if (family.magnitude === null) {
    return el('p', {
      class: 'verdict unknown',
      text:
        'Not screenable: ' +
        (family.members.length - family.pricedMembers) +
        ' of ' +
        family.members.length +
        ' members have no cached price.',
    });
  }
  if (!family.violated) {
    return el('p', {
      class: 'verdict ok',
      text: 'Coherent — off by ' + fmtEdge(Math.abs(family.magnitude)) + ', inside the tick-size threshold.',
    });
  }
  return el('p', {
    class: 'verdict no',
    text: 'Violated by ' + fmtEdge(Math.abs(family.magnitude)) + ' per share.',
  });
}

/**
 * A partition: one stacked bar against a hard line at 1.0.
 *
 * Scaled so the line sits inside the box even when the sum overshoots, because
 * the overshoot is the entire point — clipping it at 100% width would hide
 * exactly the case worth seeing.
 */
function drawPartition(family) {
  const sum = family.sum || 0;
  const scaleMax = Math.max(1, sum) * 1.08;
  const pct = (value) => (value / scaleMax) * 100;

  let running = 0;
  const segments = family.members
    .filter((m) => m.price !== null)
    .map((m) => {
      const over = running >= 1;
      running += m.price;
      const seg = el('div', {
        class: 'seg' + (over ? ' over' : ''),
        style: 'width:' + pct(m.price) + '%',
        title: (m.question || m.conditionId) + ' — ' + fmtProb(m.price),
      });
      return seg;
    });

  const rows = family.members.map((m) =>
    el('div', { class: 'rung' }, [
      el('div', { class: 'lbl' }, [
        polymarketLink(m.slug, m.question || m.conditionId),
        el('span', { text: fmtProb(m.price) }),
      ]),
      el('div', { class: 'track' }, [
        el('div', { class: 'fill', style: 'width:' + Math.min(100, (m.price || 0) * 100) + '%' }),
      ]),
    ]),
  );

  return el('div', { class: 'fam' }, [
    el('div', { class: 'lbl' }, [
      el('strong', { text: 'Sum of member prices' }),
      el('span', { class: 'mono', text: family.sum === null ? '—' : family.sum.toFixed(4) }),
    ]),
    el('div', { class: 'stack-wrap' }, [
      el('div', { class: 'stack' }, segments),
      el('div', { class: 'limit-line', style: 'left:' + pct(1) + '%' }),
      el('div', { class: 'limit-label', style: 'left:' + pct(1) + '%', text: 'must equal 1.00' }),
    ]),
    verdict(family),
    el('h2', { text: 'Members' }),
    el('div', {}, rows),
  ]);
}

/**
 * A ladder: one rung per market, in entailment order, each with a ceiling.
 *
 * The ceiling is the lowest price among the markets this one implies — the
 * highest this market is allowed to be. A rung whose fill crosses its own
 * ceiling is the violation, drawn.
 */
function drawLadder(family) {
  const price = new Map(family.members.map((m) => [m.conditionId, m.price]));
  const order = topological(family);

  const ceilingOf = new Map();
  for (const edge of family.edges) {
    const to = price.get(edge.to);
    if (to === null || to === undefined) continue;
    const current = ceilingOf.get(edge.from);
    if (current === undefined || to < current) ceilingOf.set(edge.from, to);
  }

  const rows = order.map((m) => {
    const p = price.get(m.conditionId);
    const ceiling = ceilingOf.get(m.conditionId);
    const broken = p !== null && ceiling !== undefined && p - ceiling > 0.005;

    return el('div', { class: 'rung' + (broken ? ' broken' : '') }, [
      el('div', { class: 'lbl' }, [
        polymarketLink(m.slug, m.question || m.conditionId),
        el('span', {
          text: fmtProb(p) + (ceiling === undefined ? '' : ' / max ' + fmtProb(ceiling)),
        }),
      ]),
      el('div', { class: 'track' }, [
        el('div', { class: 'fill', style: 'width:' + Math.min(100, (p || 0) * 100) + '%' }),
        ceiling === undefined
          ? null
          : el('div', {
              class: 'ceil',
              style: 'left:' + Math.min(100, ceiling * 100) + '%',
              title: 'implied ceiling ' + fmtProb(ceiling),
            }),
      ]),
    ]);
  });

  const broken = family.edges.filter((e) => e.satisfied === false);

  return el('div', { class: 'fam' }, [
    el('p', {
      class: 'note',
      text:
        family.edges.length +
        ' entailment edge(s). Each market must be priced at or below everything it entails; the amber mark is that ceiling.',
    }),
    verdict(family),
    el('div', {}, rows),
    broken.length
      ? el('div', {}, [
          el('h2', { text: 'Broken edges' }),
          el(
            'div',
            { class: 'panel' },
            [
              el('table', {}, [
                el('thead', {}, [
                  el('tr', {}, [
                    el('th', { text: 'Entails' }),
                    el('th', { class: 'num', text: 'Excess' }),
                  ]),
                ]),
                el(
                  'tbody',
                  {},
                  broken.map((e) =>
                    el('tr', {}, [
                      td(
                        'Entails',
                        el('span', { class: 'mono', text: short(e.from) + ' → ' + short(e.to) }),
                        'wide',
                      ),
                      td('Excess', fmtEdge(e.slack), 'num'),
                    ]),
                  ),
                ),
              ]),
            ],
          ),
        ])
      : null,
  ]);
}

const short = (id) => (id && id.length > 12 ? id.slice(0, 10) + '…' : id || '—');

/**
 * Members in entailment order: antecedents before what they entail.
 *
 * Kahn's algorithm, and it must tolerate a cycle — the relation graph rejects
 * cycles on write, but this view is fed by whatever is in the database, and a
 * layout that hangs on bad data is worse than one that falls back to price
 * order.
 */
function topological(family) {
  const byId = new Map(family.members.map((m) => [m.conditionId, m]));
  const outgoing = new Map();
  const indegree = new Map();
  for (const m of family.members) {
    outgoing.set(m.conditionId, []);
    indegree.set(m.conditionId, 0);
  }
  for (const edge of family.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(byId.get(id));
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  if (out.length !== family.members.length) {
    return family.members.slice().sort((a, b) => (b.price || 0) - (a.price || 0));
  }
  return out;
}

// --- routing ---------------------------------------------------------------

async function route() {
  const path = (location.hash.replace(/^#/, '').split('?')[0]) || '/';
  const render = VIEWS[path] || status;

  for (const link of document.querySelectorAll('nav a')) {
    const target = link.getAttribute('href').replace(/^#/, '') || '/';
    if (target === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  try {
    await render();
  } catch (err) {
    show([
      el('p', { class: 'err', text: 'Could not load: ' + String(err.message || err) }),
      el('button', { type: 'button', text: 'Retry', id: 'retry' }),
    ]);
    const retry = document.getElementById('retry');
    if (retry) retry.addEventListener('click', route);
  }
}

window.addEventListener('hashchange', route);
route();

// The status view is the one people leave open on a wall. Nothing else polls.
setInterval(() => {
  const path = (location.hash.replace(/^#/, '').split('?')[0]) || '/';
  if (path === '/' || path === '') route();
}, 30000);
`;
