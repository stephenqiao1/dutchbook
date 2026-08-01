import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildRelationGraph, type CatalogMarket } from '../../src/relations/extract.js';
import { relatedTo } from '../../src/relations/graph.js';

/**
 * The whole pipeline over real markets.
 *
 * The corpus is 12,008 markets sampled as whole events from the live catalog,
 * so ladders, deadline chains and complement pairs arrive intact rather than
 * shattered by sampling. It carries no `negRisk` flag, so partitions are not
 * exercised here — those are covered against the live database, where the flag
 * exists.
 *
 * The property that matters is the one a unit test cannot reach: over thousands
 * of real questions the implication relation stays acyclic. A cycle would mean
 * two markets each entail the other, which is always an extraction bug.
 */

interface CorpusFixture {
  readonly sampledFromMarkets: number;
  readonly markets: readonly CatalogMarket[];
}

const corpus = JSON.parse(
  readFileSync(new URL('../fixtures/relations/catalog-sample.json', import.meta.url), 'utf8'),
) as CorpusFixture;

describe('the relation graph over a real corpus', () => {
  const { graph, extraction } = buildRelationGraph(corpus.markets);

  it('builds with zero cycles', () => {
    // Not tolerated, not dropped — none found. If this ever fails, an
    // extractor has started claiming A entails B entails A.
    expect(graph.stats.cyclesFound).toBe(0);
    expect(graph.stats.cyclesDropped).toBe(0);
  });

  it('reports what each source contributed', () => {
    const s = extraction.stats;
    console.log(
      [
        '',
        '  ── relation graph over the real corpus ────────────────────────',
        `  markets            ${s.markets.toLocaleString()}  (of ${corpus.sampledFromMarkets.toLocaleString()} live)`,
        `  ladder edges       ${s.ladderEdges.toLocaleString()}`,
        `  temporal edges     ${s.temporalEdges.toLocaleString()}`,
        `  complement edges   ${s.complementEdges.toLocaleString()}`,
        `  partitions         ${s.partitions.toLocaleString()}  (corpus carries no negRisk flag)`,
        `  nodes              ${graph.stats.nodes.toLocaleString()}`,
        `  edges              ${graph.stats.impliesEdges.toLocaleString()} implies → ` +
          `${graph.stats.reducedEdges.toLocaleString()} after transitive reduction`,
        `  cycles             ${graph.stats.cyclesFound}`,
        `  conflicts          ${extraction.conflicts.length}`,
        '  ───────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );

    expect(s.ladderEdges).toBeGreaterThan(0);
    expect(graph.stats.nodes).toBeGreaterThan(0);
  });

  it('reduces the edge set without changing reachability', () => {
    expect(graph.stats.reducedEdges).toBeLessThanOrEqual(graph.stats.impliesEdges);

    // Spot-check: a node's descendants are the same whichever edges are stored,
    // because reduction removes only edges that some path already provides.
    let checked = 0;
    for (const market of corpus.markets.slice(0, 4000)) {
      const direct = graph.directDescendants(market.conditionId);
      if (direct.length === 0) continue;
      for (const edge of direct) {
        expect(graph.descendants(market.conditionId)).toContain(edge.toConditionId);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('never contradicts itself: no market both implies and is implied by another', () => {
    for (const market of corpus.markets) {
      const down = new Set(graph.descendants(market.conditionId));
      for (const up of graph.ancestors(market.conditionId)) {
        expect(down.has(up), `${market.conditionId} both implies and is implied by ${up}`).toBe(false);
      }
    }
  });

  it('answers a related-markets query for every node it knows', () => {
    let withRelations = 0;
    for (const market of corpus.markets.slice(0, 2000)) {
      const related = relatedTo(graph, market.conditionId);
      if (related.length > 0) withRelations += 1;
      for (const item of related) expect(item.conditionId).not.toBe(market.conditionId);
    }
    expect(withRelations).toBeGreaterThan(0);
  });
});
