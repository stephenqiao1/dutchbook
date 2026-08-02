/**
 * The single document the whole dashboard is.
 *
 * The chart library is the one external dependency on the page. It is pinned to
 * an exact version and carries a subresource-integrity hash, so the CDN can
 * serve a different file but the browser will not run it. `crossorigin` is
 * required for SRI to be checked at all.
 *
 * Everything else — markup, styles, behaviour — is served from this origin.
 */
const CHART_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
const CHART_SRI = 'sha384-vsrfeLOOY6KuIYKDlmVH5UiBmgIdB1oEf7p01YgWHuqmOHfZr374+odEv96n9tNC';

export function html(version: string, assetTag: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Coherence monitoring for the Polymarket catalog: relation graph, violation history, and lifetimes.">
<title>dutchbook — coherence monitor</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%E2%9A%96%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/app.css?v=${assetTag}">
<script src="${CHART_SRC}" integrity="${CHART_SRI}" crossorigin="anonymous" defer></script>
<script src="/app.js?v=${assetTag}" defer></script>
</head>
<body>
<header>
  <div class="bar">
    <div class="brand">dutchbook <small>coherence monitor</small></div>
  </div>
  <nav>
    <a href="#/">Status</a>
    <a href="#/violations">Violations</a>
    <a href="#/lifetimes">Lifetimes</a>
    <a href="#/families">Families</a>
  </nav>
</header>
<main id="view"><p class="empty">Loading…</p></main>
<footer>
  <p>Read-only. Public JSON: <code>/api/violations</code>, <code>/api/relations</code>,
     <code>/api/status</code>, <code>/api/lifetimes</code>, <code>/api/families</code>.</p>
  <p>Prices are cached midpoints, not executable quotes. A confirmed violation was priced
     against live order-book depth after fees and slippage; an apparent one was not.
     Nothing here is trading advice. Version ${escapeHtml(version)}.</p>
</footer>
</body>
</html>
`;
}

/** The version string comes from `package.json`, but escaping it costs nothing. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
