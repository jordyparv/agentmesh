/** Pure DAG utilities: dependency validation, cycle detection, topological order. */
export interface DagEdge {
  from: string; // dependency
  to: string; // dependent
}

export type DagValidation = { ok: true; order: string[] } | { ok: false; error: "cycle"; cycle: string[] } | { ok: false; error: "unknown_node"; node: string } | { ok: false; error: "self_dependency"; node: string };

export function validateDag(nodes: string[], edges: DagEdge[]): DagValidation {
  const set = new Set(nodes);
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    out.set(n, []);
    indeg.set(n, 0);
  }
  for (const e of edges) {
    if (e.from === e.to) return { ok: false, error: "self_dependency", node: e.from };
    if (!set.has(e.from)) return { ok: false, error: "unknown_node", node: e.from };
    if (!set.has(e.to)) return { ok: false, error: "unknown_node", node: e.to };
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  // Kahn's algorithm; deterministic by input order.
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of out.get(n)!) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (order.length === nodes.length) return { ok: true, order };
  return { ok: false, error: "cycle", cycle: findCycle(nodes.filter((n) => indeg.get(n)! > 0), out) };
}

function findCycle(candidates: string[], out: Map<string, string[]>): string[] {
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    color.set(n, 1);
    stack.push(n);
    for (const m of out.get(n) ?? []) {
      if (color.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!color.get(m)) {
        const c = dfs(m);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(n, 2);
    return null;
  };
  for (const n of candidates) if (!color.get(n)) {
    const c = dfs(n);
    if (c) return c;
  }
  return candidates;
}
