import { describe, expect, it } from 'vitest';

import {
  RelationCycleError,
  RelationGraph,
  relatedTo,
} from '../../src/relations/graph.js';
import type { RelationEdge, RelationGroup } from '../../src/relations/types.js';

const implies = (from: string, to: string, source: RelationEdge['source'] = 'ladder'): RelationEdge => ({
  fromConditionId: from,
  toConditionId: to,
  type: 'implies',
  source,
  confidence: 1,
  rationale: `${from} entails ${to}`,
});

const complement = (a: string, b: string): RelationEdge => ({
  fromConditionId: a,
  toConditionId: b,
  type: 'complement',
  source: 'complement',
  confidence: 1,
  rationale: `${a} and ${b} are complements`,
});

const partition = (key: string, members: string[]): RelationGroup => ({
  key,
  type: 'partition',
  source: 'neg-risk-event',
  confidence: 1,
  members: members.toSorted(),
  rationale: `${members.length} exclusive outcomes summing to 1`,
});

describe('building the graph', () => {
  it('records nodes, edges, complements and partitions', () => {
    const graph = RelationGraph.build(
      [implies('c', 'b'), implies('b', 'a'), complement('x', 'y')],
      [partition('p1', ['m1', 'm2', 'm3'])],
    );

    expect(graph.stats.impliesEdges).toBe(2);
    expect(graph.stats.complementEdges).toBe(1);
    expect(graph.stats.partitions).toBe(1);
    expect(graph.stats.cyclesFound).toBe(0);
    // Partition members become nodes even with no implication touching them.
    expect(graph.has('m2')).toBe(true);
  });

  it('drops self-edges rather than treating them as cycles', () => {
    const graph = RelationGraph.build([implies('a', 'a'), implies('b', 'a')]);
    expect(graph.stats.impliesEdges).toBe(1);
    expect(graph.stats.cyclesFound).toBe(0);
  });

  it('builds an empty graph without complaint', () => {
    const graph = RelationGraph.build([]);
    expect(graph.stats.nodes).toBe(0);
    expect(graph.descendants('nobody')).toEqual([]);
  });
});

describe('cycle detection', () => {
  it('throws on a two-node cycle', () => {
    expect(() => RelationGraph.build([implies('a', 'b'), implies('b', 'a')])).toThrow(
      RelationCycleError,
    );
  });

  it('throws on a longer cycle', () => {
    const build = (): RelationGraph =>
      RelationGraph.build([implies('a', 'b'), implies('b', 'c'), implies('c', 'a')]);

    expect(build).toThrow(RelationCycleError);
    try {
      build();
    } catch (error) {
      expect(error).toBeInstanceOf(RelationCycleError);
      if (!(error instanceof RelationCycleError)) return;
      expect(error.cycles).toHaveLength(1);
      expect(error.cycles[0]?.nodes.length).toBeGreaterThanOrEqual(3);
      expect(error.message).toContain('unsound');
    }
  });

  it('reports several independent cycles at once', () => {
    try {
      RelationGraph.build([
        implies('a', 'b'),
        implies('b', 'a'),
        implies('x', 'y'),
        implies('y', 'x'),
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RelationCycleError);
      if (error instanceof RelationCycleError) expect(error.cycles).toHaveLength(2);
    }
  });

  it('keeps the acyclic remainder when told to tolerate cycles', () => {
    const graph = RelationGraph.build(
      [implies('a', 'b'), implies('b', 'a'), implies('p', 'q'), implies('q', 'r')],
      [],
      { tolerateCycles: true },
    );

    expect(graph.stats.cyclesFound).toBe(1);
    expect(graph.stats.cyclesDropped).toBe(2);
    // The healthy chain survives.
    expect(graph.descendants('p')).toEqual(['q', 'r']);
    // The cyclic pair contributes no reachability.
    expect(graph.descendants('a')).toEqual([]);
  });

  it('does not mistake a diamond for a cycle', () => {
    // a -> b -> d and a -> c -> d: two paths, no cycle.
    const graph = RelationGraph.build([
      implies('a', 'b'),
      implies('a', 'c'),
      implies('b', 'd'),
      implies('c', 'd'),
    ]);

    expect(graph.stats.cyclesFound).toBe(0);
    expect(graph.descendants('a')).toEqual(['b', 'c', 'd']);
  });

  it('does not mistake a complement pair for a cycle', () => {
    // Complements are symmetric and stored once; they must not enter the DAG.
    const graph = RelationGraph.build([complement('a', 'b'), complement('b', 'a')]);
    expect(graph.stats.cyclesFound).toBe(0);
  });
});

describe('transitive reduction', () => {
  it('removes an edge already implied by a longer path', () => {
    // a -> b -> c plus the shortcut a -> c. The shortcut is redundant.
    const graph = RelationGraph.build([implies('a', 'b'), implies('b', 'c'), implies('a', 'c')]);

    expect(graph.stats.impliesEdges).toBe(3);
    expect(graph.stats.reducedEdges).toBe(2);
    expect(graph.directDescendants('a').map((e) => e.toConditionId)).toEqual(['b']);
    // Reachability is unchanged.
    expect(graph.descendants('a')).toEqual(['b', 'c']);
  });

  it('collapses a fully transitive chain to its covering edges', () => {
    // Every ordered pair over a 5-rung ladder: 10 edges in, 4 out.
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const edges: RelationEdge[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) edges.push(implies(ids[i]!, ids[j]!));
    }

    const graph = RelationGraph.build(edges);
    expect(graph.stats.impliesEdges).toBe(10);
    expect(graph.stats.reducedEdges).toBe(4);
    expect(graph.descendants('r1')).toEqual(['r2', 'r3', 'r4', 'r5']);
  });

  it('keeps both branches of a diamond', () => {
    const graph = RelationGraph.build([
      implies('a', 'b'),
      implies('a', 'c'),
      implies('b', 'd'),
      implies('c', 'd'),
    ]);

    // Nothing is redundant here: removing a->b loses no reachability only if
    // b is reachable another way, and it is not.
    expect(graph.stats.reducedEdges).toBe(4);
  });

  it('preserves reachability exactly', () => {
    const edges = [
      implies('a', 'b'),
      implies('b', 'c'),
      implies('c', 'd'),
      implies('a', 'd'),
      implies('a', 'c'),
      implies('b', 'd'),
    ];
    const full = RelationGraph.build(edges);

    for (const node of ['a', 'b', 'c', 'd']) {
      const viaReduced = full.descendants(node);
      // Reachability computed from the unreduced edge set must agree.
      const expected = new Set<string>();
      const stack = [node];
      while (stack.length > 0) {
        const current = stack.pop();
        for (const e of edges.filter((x) => x.fromConditionId === current)) {
          if (expected.has(e.toConditionId)) continue;
          expected.add(e.toConditionId);
          stack.push(e.toConditionId);
        }
      }
      expect(viaReduced).toEqual([...expected].toSorted());
    }
  });
});

describe('queries', () => {
  const graph = RelationGraph.build(
    [
      implies('high', 'mid'),
      implies('mid', 'low'),
      implies('other', 'low'),
      complement('low', 'lowNeg'),
    ],
    [partition('p:evt', ['home', 'draw', 'away'])],
  );

  it('descendants are the weaker claims implied downstream', () => {
    expect(graph.descendants('high')).toEqual(['low', 'mid']);
    expect(graph.descendants('low')).toEqual([]);
  });

  it('ancestors are the stronger claims that entail it', () => {
    expect(graph.ancestors('low')).toEqual(['high', 'mid', 'other']);
    expect(graph.ancestors('high')).toEqual([]);
  });

  it('finds the partitions a market belongs to', () => {
    expect(graph.partitionsContaining('draw')).toHaveLength(1);
    expect(graph.partitionsContaining('draw')[0]?.members).toEqual(['away', 'draw', 'home']);
    expect(graph.partitionsContaining('high')).toEqual([]);
  });

  it('finds complements from either side', () => {
    expect(graph.complementsOf('low')).toHaveLength(1);
    expect(graph.complementsOf('lowNeg')).toHaveLength(1);
  });

  it('collects everything related to a market, marking transitive links', () => {
    const related = relatedTo(graph, 'high');

    const implied = related.filter((r) => r.relation === 'implies');
    expect(implied.map((r) => r.conditionId).toSorted()).toEqual(['low', 'mid']);

    // mid is a stored edge; low is only reachable through it.
    expect(implied.find((r) => r.conditionId === 'mid')?.direct).toBe(true);
    expect(implied.find((r) => r.conditionId === 'low')?.direct).toBe(false);
  });

  it('reports partition siblings without the market itself', () => {
    const related = relatedTo(graph, 'draw');
    const siblings = related.filter((r) => r.relation === 'partition');

    expect(siblings.map((r) => r.conditionId).toSorted()).toEqual(['away', 'home']);
    expect(siblings.every((r) => r.source === 'neg-risk-event')).toBe(true);
  });

  it('returns nothing for an unknown market', () => {
    expect(relatedTo(graph, 'never-seen')).toEqual([]);
  });
});

describe('scale', () => {
  it('handles a long chain without overflowing the stack', () => {
    // Deep enough that a recursive Tarjan would blow up.
    const edges: RelationEdge[] = [];
    for (let i = 0; i < 20_000; i += 1) edges.push(implies(`n${i}`, `n${i + 1}`));

    const graph = RelationGraph.build(edges);
    expect(graph.stats.cyclesFound).toBe(0);
    expect(graph.stats.reducedEdges).toBe(20_000);
    expect(graph.descendants('n0')).toHaveLength(20_000);
  });

  it('detects a cycle closed at the end of a long chain', () => {
    const edges: RelationEdge[] = [];
    for (let i = 0; i < 5_000; i += 1) edges.push(implies(`n${i}`, `n${i + 1}`));
    edges.push(implies('n5000', 'n0'));

    expect(() => RelationGraph.build(edges)).toThrow(RelationCycleError);
  });
});
