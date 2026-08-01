import { createLogger } from '../logger.js';
import { canonicalPair, type RelationEdge, type RelationGroup } from './types.js';

/**
 * The relation graph.
 *
 * Implications form a DAG. Complements and partitions hang off it as symmetric
 * pairs and hyperedges — they constrain probabilities but impose no direction,
 * so they take no part in reachability.
 *
 * A cycle in the implication relation means A entails B entails ... entails A,
 * which forces every market on the cycle to the same probability. That is
 * almost never a real discovery about prediction markets and almost always a
 * bug: a subject normalized too aggressively, a threshold parsed off the wrong
 * number, two markets that are not the same question. So cycles are rejected
 * rather than tolerated, and reported loudly enough to be fixed.
 */

const log = createLogger('relation-graph');

export interface GraphMarketMeta {
  readonly question?: string | null;
}

export interface BuildGraphOptions {
  /** Question text by condition id, used to make cycle reports readable. */
  readonly questions?: ReadonlyMap<string, string>;
  /**
   * Keep going after cycles are found, having dropped them. Default false —
   * a cycle is a bug, and building on top of it hides the bug.
   */
  readonly tolerateCycles?: boolean;
}

export interface Cycle {
  /** Condition ids around the cycle; the first is repeated implicitly. */
  readonly nodes: readonly string[];
  readonly edges: readonly RelationEdge[];
}

export class RelationCycleError extends Error {
  readonly cycles: readonly Cycle[];

  constructor(cycles: readonly Cycle[]) {
    super(
      `implication relation contains ${cycles.length} cycle(s); ` +
        'extraction is unsound and the graph was not built',
    );
    this.name = 'RelationCycleError';
    this.cycles = cycles;
  }
}

export interface GraphStats {
  readonly nodes: number;
  readonly impliesEdges: number;
  /** Edges left after transitive reduction. */
  readonly reducedEdges: number;
  readonly complementEdges: number;
  readonly partitions: number;
  readonly cyclesFound: number;
  readonly cyclesDropped: number;
}

interface Neighbour {
  readonly to: string;
  readonly edge: RelationEdge;
}

/**
 * Tarjan's strongly connected components, iterative.
 *
 * Iterative because a recursive walk over an 88-rung ladder chain plus its
 * transitive edges can nest deeply enough to overflow the stack, and a crash
 * here would look like a graph problem rather than a recursion problem.
 */
function stronglyConnected(nodes: readonly string[], out: ReadonlyMap<string, Neighbour[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;

    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;

      const neighbours = out.get(frame.node) ?? [];

      if (frame.next < neighbours.length) {
        const child = neighbours[frame.next]?.to;
        frame.next += 1;
        if (child === undefined) continue;

        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(child) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) components.push(component);
      }
    }
  }

  return components;
}

/** Recovers an actual cycle within a strongly connected component. */
function cycleWithin(component: readonly string[], out: ReadonlyMap<string, Neighbour[]>): Cycle {
  const inComponent = new Set(component);
  const start = component[0] ?? '';
  const parent = new Map<string, RelationEdge>();
  const path: string[] = [];
  const seen = new Set<string>([start]);

  let current = start;
  for (;;) {
    const next = (out.get(current) ?? []).find((n) => inComponent.has(n.to));
    if (next === undefined) break;

    parent.set(next.to, next.edge);
    path.push(current);
    if (next.to === start || seen.has(next.to)) {
      path.push(next.to);
      break;
    }
    seen.add(next.to);
    current = next.to;
  }

  const edges = path
    .slice(1)
    .map((node) => parent.get(node))
    .filter((edge): edge is RelationEdge => edge !== undefined);

  return { nodes: path.length > 0 ? path : [...component], edges };
}

export class RelationGraph {
  readonly #out = new Map<string, Neighbour[]>();
  readonly #in = new Map<string, Neighbour[]>();
  readonly #reduced = new Map<string, Neighbour[]>();
  readonly #complements = new Map<string, RelationEdge[]>();
  readonly #partitions = new Map<string, RelationGroup[]>();
  readonly #groups: RelationGroup[] = [];
  readonly #nodes = new Set<string>();
  readonly #stats: GraphStats;

  private constructor(stats: GraphStats) {
    this.#stats = stats;
  }

  get stats(): GraphStats {
    return this.#stats;
  }

  get nodeCount(): number {
    return this.#nodes.size;
  }

  /**
   * Builds the graph, rejecting cycles.
   *
   * Throws {@link RelationCycleError} unless `tolerateCycles` is set, in which
   * case every edge on a cycle is dropped and the rest is kept.
   */
  static build(
    edges: Iterable<RelationEdge>,
    groups: Iterable<RelationGroup> = [],
    options: BuildGraphOptions = {},
  ): RelationGraph {
    const implies: RelationEdge[] = [];
    const complements: RelationEdge[] = [];
    const nodes = new Set<string>();

    for (const edge of edges) {
      if (edge.fromConditionId === edge.toConditionId) continue;
      nodes.add(edge.fromConditionId);
      nodes.add(edge.toConditionId);
      if (edge.type === 'implies') implies.push(edge);
      else complements.push(edge);
    }

    const out = new Map<string, Neighbour[]>();
    for (const edge of implies) {
      const bucket = out.get(edge.fromConditionId);
      if (bucket === undefined) out.set(edge.fromConditionId, [{ to: edge.toConditionId, edge }]);
      else bucket.push({ to: edge.toConditionId, edge });
    }

    // --- cycles ----------------------------------------------------------
    const components = stronglyConnected([...nodes], out);
    const cycles = components.map((component) => cycleWithin(component, out));

    if (cycles.length > 0) {
      const questions = options.questions;
      for (const cycle of cycles.slice(0, 10)) {
        log.error(
          {
            length: cycle.nodes.length,
            sources: [...new Set(cycle.edges.map((e) => e.source))],
            path: cycle.nodes.map((id) => ({
              conditionId: id,
              question: questions?.get(id)?.slice(0, 120) ?? null,
            })),
          },
          'IMPLICATION CYCLE — extraction is unsound; A entails B entails A forces equal probabilities',
        );
      }
      if (cycles.length > 10) {
        log.error({ suppressed: cycles.length - 10 }, 'further cycles suppressed');
      }
      if (options.tolerateCycles !== true) throw new RelationCycleError(cycles);
    }

    const onCycle = new Set(components.flat());
    const kept = implies.filter(
      (edge) => !(onCycle.has(edge.fromConditionId) && onCycle.has(edge.toConditionId)),
    );

    // --- rebuild from the acyclic remainder --------------------------------
    const acyclicOut = new Map<string, Neighbour[]>();
    const acyclicIn = new Map<string, Neighbour[]>();
    for (const edge of kept) {
      const o = acyclicOut.get(edge.fromConditionId);
      if (o === undefined) acyclicOut.set(edge.fromConditionId, [{ to: edge.toConditionId, edge }]);
      else o.push({ to: edge.toConditionId, edge });

      const i = acyclicIn.get(edge.toConditionId);
      if (i === undefined) acyclicIn.set(edge.toConditionId, [{ to: edge.fromConditionId, edge }]);
      else i.push({ to: edge.fromConditionId, edge });
    }

    const reduced = transitiveReduction([...nodes], acyclicOut);
    const allGroups = [...groups];
    for (const group of allGroups) for (const member of group.members) nodes.add(member);

    const graph = new RelationGraph({
      nodes: nodes.size,
      impliesEdges: kept.length,
      reducedEdges: [...reduced.values()].reduce((sum, list) => sum + list.length, 0),
      complementEdges: complements.length,
      partitions: allGroups.length,
      cyclesFound: cycles.length,
      cyclesDropped: implies.length - kept.length,
    });

    for (const node of nodes) graph.#nodes.add(node);
    for (const [key, value] of acyclicOut) graph.#out.set(key, value);
    for (const [key, value] of acyclicIn) graph.#in.set(key, value);
    for (const [key, value] of reduced) graph.#reduced.set(key, value);

    for (const edge of complements) {
      for (const id of [edge.fromConditionId, edge.toConditionId]) {
        const bucket = graph.#complements.get(id);
        if (bucket === undefined) graph.#complements.set(id, [edge]);
        else bucket.push(edge);
      }
    }

    for (const group of allGroups) {
      graph.#groups.push(group);
      for (const member of group.members) {
        const bucket = graph.#partitions.get(member);
        if (bucket === undefined) graph.#partitions.set(member, [group]);
        else bucket.push(group);
      }
    }

    return graph;
  }

  /** Everything reachable by following implications forward: weaker claims. */
  descendants(conditionId: string): string[] {
    return this.#reachable(conditionId, this.#out);
  }

  /** Everything that reaches this market: stronger claims that entail it. */
  ancestors(conditionId: string): string[] {
    return this.#reachable(conditionId, this.#in);
  }

  /** Direct implications only, after transitive reduction. */
  directDescendants(conditionId: string): RelationEdge[] {
    return (this.#reduced.get(conditionId) ?? []).map((n) => n.edge);
  }

  complementsOf(conditionId: string): RelationEdge[] {
    return this.#complements.get(conditionId) ?? [];
  }

  partitionsContaining(conditionId: string): RelationGroup[] {
    return this.#partitions.get(conditionId) ?? [];
  }

  get partitions(): readonly RelationGroup[] {
    return this.#groups;
  }

  has(conditionId: string): boolean {
    return this.#nodes.has(conditionId);
  }

  #reachable(start: string, adjacency: ReadonlyMap<string, Neighbour[]>): string[] {
    const seen = new Set<string>();
    const stack = [start];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      for (const { to } of adjacency.get(node) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        stack.push(to);
      }
    }

    seen.delete(start);
    return [...seen].toSorted();
  }
}

/**
 * Transitive reduction of a DAG: the smallest edge set with the same
 * reachability.
 *
 * An edge u -> v is redundant when v is already reachable from u through
 * another successor. Dropping those means a consistency check tests each
 * genuine link once rather than re-testing every implied pair — for an 88-rung
 * ladder, 87 edges instead of 3,828.
 *
 * The reachable set of every node is needed to decide redundancy, and holding
 * all of them at once is quadratic: a chain of n nodes has sets of size n,
 * n-1, ... n²/2 entries in total, which is how a 20,000-node chain exhausts
 * the heap. So each set is released as soon as the last predecessor that needs
 * it has been processed, and — when a node is the sole remaining consumer — its
 * successor's set is *reused* rather than copied. A chain then costs one set
 * and one insertion per node instead of a copy per node.
 *
 * Requires an acyclic input; cycles are removed before this is called.
 */
export function transitiveReduction(
  nodes: readonly string[],
  out: ReadonlyMap<string, Neighbour[]>,
): Map<string, Neighbour[]> {
  const order = topologicalOrder(nodes, out);
  const reach = new Map<string, Set<string>>();
  const reduced = new Map<string, Neighbour[]>();

  // How many predecessors still need each node's reachable set. When this hits
  // zero the set is dead and its memory can be reclaimed or repurposed.
  const consumers = new Map<string, number>();
  for (const neighbours of out.values()) {
    for (const { to } of neighbours) consumers.set(to, (consumers.get(to) ?? 0) + 1);
  }

  for (const node of order.toReversed()) {
    const neighbours = out.get(node) ?? [];
    if (neighbours.length === 0) {
      reach.set(node, new Set());
      continue;
    }

    // Take over the largest successor set we are the last consumer of, so the
    // common case — a chain — moves a set instead of copying it.
    let owned: Set<string> | null = null;
    let ownedFrom: string | null = null;

    for (const { to } of neighbours) {
      const remaining = (consumers.get(to) ?? 1) - 1;
      consumers.set(to, remaining);
      if (remaining !== 0) continue;

      const candidate = reach.get(to);
      if (candidate === undefined) continue;
      if (owned === null || candidate.size > owned.size) {
        if (owned !== null && ownedFrom !== null) reach.delete(ownedFrom);
        owned = candidate;
        ownedFrom = to;
      } else {
        reach.delete(to);
      }
    }

    const viaOthers = owned ?? new Set<string>();
    const inherited = new Set(viaOthers);

    for (const { to } of neighbours) {
      if (to === ownedFrom) continue;
      for (const far of reach.get(to) ?? []) inherited.add(far);
    }

    // `inherited` is everything reachable through a successor's successors —
    // exactly the set that makes a direct edge redundant.
    const keep = neighbours.filter(({ to }) => !inherited.has(to));
    if (keep.length > 0) reduced.set(node, keep);

    const own = owned ?? new Set<string>();
    for (const far of inherited) own.add(far);
    for (const { to } of neighbours) own.add(to);

    if (ownedFrom !== null) reach.delete(ownedFrom);
    reach.set(node, own);
  }

  return reduced;
}

/** Kahn's algorithm. Any node left over sits on a cycle and is appended. */
function topologicalOrder(nodes: readonly string[], out: ReadonlyMap<string, Neighbour[]>): string[] {
  const indegree = new Map<string, number>();
  for (const node of nodes) indegree.set(node, indegree.get(node) ?? 0);
  for (const neighbours of out.values()) {
    for (const { to } of neighbours) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order: string[] = [];

  while (queue.length > 0) {
    const node = queue.pop();
    if (node === undefined) continue;
    order.push(node);
    for (const { to } of out.get(node) ?? []) {
      const next = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, next);
      if (next === 0) queue.push(to);
    }
  }

  if (order.length < indegree.size) {
    for (const node of indegree.keys()) if (!order.includes(node)) order.push(node);
  }

  return order;
}

/** Groups a market's relations for display. */
export interface RelatedMarket {
  readonly conditionId: string;
  readonly relation: 'implies' | 'implied-by' | 'complement' | 'partition';
  readonly source: string;
  readonly direct: boolean;
  readonly rationale: string | null;
}

/** Everything related to one market, for the inspector. */
export function relatedTo(graph: RelationGraph, conditionId: string): RelatedMarket[] {
  const out: RelatedMarket[] = [];
  const directOut = new Set(graph.directDescendants(conditionId).map((e) => e.toConditionId));

  for (const id of graph.descendants(conditionId)) {
    const edge = graph.directDescendants(conditionId).find((e) => e.toConditionId === id);
    out.push({
      conditionId: id,
      relation: 'implies',
      source: edge?.source ?? 'transitive',
      direct: directOut.has(id),
      rationale: edge?.rationale ?? null,
    });
  }

  for (const id of graph.ancestors(conditionId)) {
    const edge = graph.directDescendants(id).find((e) => e.toConditionId === conditionId);
    out.push({
      conditionId: id,
      relation: 'implied-by',
      source: edge?.source ?? 'transitive',
      direct: edge !== undefined,
      rationale: edge?.rationale ?? null,
    });
  }

  for (const edge of graph.complementsOf(conditionId)) {
    const [a, b] = canonicalPair(edge.fromConditionId, edge.toConditionId);
    out.push({
      conditionId: a === conditionId ? b : a,
      relation: 'complement',
      source: edge.source,
      direct: true,
      rationale: edge.rationale,
    });
  }

  for (const group of graph.partitionsContaining(conditionId)) {
    for (const member of group.members) {
      if (member === conditionId) continue;
      out.push({
        conditionId: member,
        relation: 'partition',
        source: group.source,
        direct: true,
        rationale: group.rationale,
      });
    }
  }

  return out;
}
