/**
 * The dashboard stylesheet.
 *
 * A string in a TypeScript module rather than a file in a `public/` directory,
 * because `tsc` only emits `src/**` + `.ts` — a static directory would need a
 * copy step in the build, and "no build step" was the point. It is served with
 * a content hash in its ETag, so editing it invalidates the cache without a
 * version number to remember to bump.
 *
 * Mobile first, and that is not a slogan here: the acceptance criterion is that
 * this is legible on a phone, so the wide layouts are the media query and the
 * narrow one is the default. Tables become cards below 40rem — a five-column
 * table on a 375px screen is either unreadable or a horizontal scroll nobody
 * discovers.
 */
export const CSS = String.raw`
:root {
  --bg: #fbfbfa;
  --panel: #ffffff;
  --ink: #1b1b1a;
  --muted: #6b6b66;
  --line: #e3e3df;
  --accent: #2f5d50;
  --bad: #a8321f;
  --warn: #a9791d;
  --good: #2f6b3a;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a;
    --panel: #1e2024;
    --ink: #e8e8e4;
    --muted: #9a9a94;
    --line: #2e3137;
    --accent: #7fbfa8;
    --bad: #e8806c;
    --warn: #d9ad5a;
    --good: #7fc08c;
  }
}

* { box-sizing: border-box; }

/* Nothing may make the document wider than the screen. Every horizontal
   overflow here has been a long market question or condition id refusing to
   wrap, so the cure is applied at the text rather than by clipping the page. */
html { overflow-x: hidden; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-text-size-adjust: 100%;
}

a { color: var(--accent); }

header {
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 5;
}

.bar {
  max-width: 60rem;
  margin: 0 auto;
  padding: 0.75rem 1rem 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 1rem;
}

.brand { font-weight: 650; letter-spacing: -0.01em; }
.brand small { color: var(--muted); font-weight: 400; margin-left: 0.5rem; }

nav {
  max-width: 60rem;
  margin: 0 auto;
  padding: 0 1rem;
  display: flex;
  gap: 0.25rem;
  overflow-x: auto;
  scrollbar-width: none;
}
nav::-webkit-scrollbar { display: none; }

nav a {
  /* 44px tall: a tap target that works with a thumb. */
  padding: 0.65rem 0.75rem;
  min-height: 44px;
  display: flex;
  align-items: center;
  white-space: nowrap;
  text-decoration: none;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  font-size: 0.94rem;
}
nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--accent); }

main { max-width: 60rem; margin: 0 auto; padding: 1rem 1rem 4rem; }

h2 { font-size: 1.05rem; margin: 1.75rem 0 0.6rem; letter-spacing: -0.01em; }
h2:first-child { margin-top: 0.25rem; }
p.note { color: var(--muted); font-size: 0.86rem; margin: 0.3rem 0 0.9rem; }

.cards {
  display: grid;
  gap: 0.6rem;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0.75rem 0.85rem;
}
.card .k { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
.card .v { font-size: 1.5rem; font-weight: 620; font-variant-numeric: tabular-nums; margin-top: 0.15rem; }
.card .s { color: var(--muted); font-size: 0.8rem; }

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--line); }
tbody tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 550; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }

th[data-sort] { cursor: pointer; user-select: none; white-space: nowrap; }
th[data-sort]:hover { color: var(--ink); }
th[data-sort]::after { content: ""; opacity: 0.35; margin-left: 0.3rem; }
th[data-sort][aria-sort="ascending"]::after { content: "\2191"; opacity: 1; }
th[data-sort][aria-sort="descending"]::after { content: "\2193"; opacity: 1; }

.tag {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.75rem;
  border: 1px solid var(--line);
  color: var(--muted);
  white-space: nowrap;
}
.tag.confirmed { color: var(--good); border-color: currentColor; }
.tag.apparent { color: var(--muted); }
.tag.open { color: var(--warn); border-color: currentColor; }
.tag.bad { color: var(--bad); border-color: currentColor; }

/* Market questions and condition ids are long and unbreakable. Without this
   they set the width of the page and everything else scrolls off the side. */
.q { display: block; overflow-wrap: anywhere; }
.mono { font-family: var(--mono); font-size: 0.85em; overflow-wrap: anywhere; }
.tv { min-width: 0; overflow-wrap: anywhere; }

select, button, input {
  font: inherit;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  min-height: 44px;
  max-width: 100%;
}
button { cursor: pointer; }
.controls { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.8rem; }

.chart-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem; }
/* A fixed aspect box: Chart.js needs a sized parent or it grows without bound. */
.chart-box { position: relative; height: 17rem; }
@media (min-width: 40rem) { .chart-box { height: 21rem; } }

/* --- family constraint drawing ----------------------------------------- */

.fam { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem; }

/* The bar and its constraint line share one positioning context, so the line
   is placed by percentage of the same box the segments are measured in. */
.stack-wrap { position: relative; padding-bottom: 1.35rem; margin-top: 0.35rem; }

.stack {
  display: flex;
  height: 3rem;
  border-radius: 6px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
.seg {
  min-width: 2px;
  border-right: 1px solid var(--panel);
  background: var(--accent);
  opacity: 0.85;
}
.seg:nth-child(even) { opacity: 0.62; }
.seg.over { background: var(--bad); opacity: 0.9; }

/* The constraint itself: a hard line at probability 1.0, spanning the bar. */
.limit-line {
  position: absolute;
  top: -0.25rem;
  height: 3.5rem;
  border-left: 2px dashed var(--bad);
  pointer-events: none;
}
.limit-label {
  position: absolute;
  top: 3.4rem;
  transform: translateX(-50%);
  font-size: 0.72rem;
  color: var(--bad);
  font-weight: 600;
  white-space: nowrap;
}

.rung { display: grid; grid-template-columns: 1fr; gap: 0.15rem; padding: 0.45rem 0; border-bottom: 1px solid var(--line); }
.rung:last-child { border-bottom: 0; }
.lbl { font-size: 0.85rem; display: flex; justify-content: space-between; gap: 0.6rem; align-items: baseline; }
/* The label takes the slack and wraps; the number never wraps and never shrinks. */
.lbl > *:first-child { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.lbl > *:last-child { flex: 0 0 auto; font-family: var(--mono); white-space: nowrap; }
.track { position: relative; height: 0.85rem; border-radius: 4px; background: color-mix(in srgb, var(--ink) 7%, transparent); }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); opacity: 0.75; }
.rung.broken .fill { background: var(--bad); opacity: 0.9; }
/* Where the price is not allowed to go: the tightest thing this rung implies. */
.ceil { position: absolute; top: -3px; bottom: -3px; border-left: 2px solid var(--warn); }
.rung.broken .ceil { border-color: var(--bad); }

.verdict { margin: 0.75rem 0 0; padding: 0.6rem 0.75rem; border-radius: 8px; font-size: 0.9rem; }
.verdict.ok { background: color-mix(in srgb, var(--good) 12%, transparent); color: var(--good); }
.verdict.no { background: color-mix(in srgb, var(--bad) 12%, transparent); color: var(--bad); }
.verdict.unknown { background: color-mix(in srgb, var(--muted) 12%, transparent); color: var(--muted); }

.empty { color: var(--muted); padding: 1.5rem 0.75rem; text-align: center; }
.err { color: var(--bad); padding: 0.75rem; }

footer { max-width: 60rem; margin: 0 auto; padding: 0 1rem 3rem; color: var(--muted); font-size: 0.8rem; }
footer code { font-family: var(--mono); }

/* --- phones: tables become cards ---------------------------------------- */
@media (max-width: 40rem) {
  main { padding: 0.85rem 0.7rem 3rem; }
  .panel { background: transparent; border: 0; border-radius: 0; }
  table, tbody, tr, td { display: block; width: 100%; }
  thead { display: none; }
  tbody tr {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    margin-bottom: 0.5rem;
    padding: 0.25rem 0.1rem;
  }
  td {
    border-bottom: 0;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.28rem 0.75rem;
    min-width: 0;
  }
  td > .tv { text-align: right; }
  td.num > .tv { text-align: right; }
  /* The header each cell lost when the table stopped being a table. */
  td::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex: 0 0 auto;
  }
  td.wide { display: block; }
  td.wide::before { display: block; margin-bottom: 0.15rem; }
  td.wide > .tv { text-align: left; }
}
`;
