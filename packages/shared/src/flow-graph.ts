/**
 * A flow as a diagram: the steps of a test file (chained with `dependsOn`) laid out left to right in layers.
 * Pure: no DOM, no Node. The app's FlowDiagram draws the result; the CLI and the MCP tool print it (or its DOT).
 */

/** One step of a flow: what the app, the CLI and the MCP tool show of a test. */
export interface FlowStep {
  id: string;
  name: string;
  type: string;
  /** HTTP: the method and the URL (as written, variables unresolved). */
  method?: string;
  url?: string;
  /** The names the step extracts for the steps after it. */
  extract?: string[];
  dependsOn?: string[];
  /** The 1-based line of the step in its file, when known. */
  line?: number;
  /** The latest run's result of the step, when there is one. */
  status?: string;
  durationMs?: number;
}

export interface FlowNode {
  id: string;
  step: FlowStep;
  /** Column (0 = the sources) and row inside it. */
  layer: number;
  row: number;
  /** Top-left corner and size, in the diagram's units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowEdge {
  from: string;
  to: string;
}

/** Something the layout could not honour: a dependency nobody defines, a cycle. The diagram still draws. */
export interface FlowProblem {
  step: string;
  message: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  problems: FlowProblem[];
  width: number;
  height: number;
}

export interface FlowLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
}

const DEFAULTS: Required<FlowLayoutOptions> = { nodeWidth: 220, nodeHeight: 72, gapX: 64, gapY: 20 };

/**
 * Lay the steps out: longest-path layering (a step sits one column right of the last step it depends on), then
 * barycentre ordering inside each column (a step near the mean row of its dependencies, so edges cross little).
 * Steps nothing depends on and that depend on nothing sit in the first column in file order.
 * A dependency nobody defines, or an edge that would close a cycle, is dropped and reported in `problems`.
 */
export function flowGraph(steps: FlowStep[], opts: FlowLayoutOptions = {}): FlowGraph {
  const o = { ...DEFAULTS, ...opts };
  const problems: FlowProblem[] = [];
  const byId = new Map<string, FlowStep>();
  for (const s of steps) {
    if (byId.has(s.id)) problems.push({ step: s.id, message: `Two steps have the id "${s.id}"; dependsOn can name only one of them` });
    else byId.set(s.id, s);
  }
  const ids = [...byId.keys()];
  const order = new Map(ids.map((id, i) => [id, i]));
  // the edges, without those to a missing step
  const deps = new Map<string, string[]>(ids.map((id) => [id, []]));
  const edges: FlowEdge[] = [];
  for (const id of ids) {
    for (const d of byId.get(id)!.dependsOn ?? []) {
      if (!byId.has(d)) problems.push({ step: id, message: `"${id}" depends on "${d}", which no step of the file defines` });
      else if (d === id) problems.push({ step: id, message: `"${id}" depends on itself` });
      else if (!deps.get(id)!.includes(d)) {
        deps.get(id)!.push(d);
        edges.push({ from: d, to: id });
      }
    }
  }
  // cycles: an edge that leads back into the path being walked is dropped (the layering needs a DAG)
  const state = new Map<string, 'walking' | 'done'>();
  const walk = (id: string) => {
    state.set(id, 'walking');
    for (const d of [...deps.get(id)!]) {
      const s = state.get(d);
      if (s === 'walking') {
        problems.push({ step: id, message: `"${id}" and "${d}" depend on each other (a cycle); neither can run first` });
        deps.set(
          id,
          deps.get(id)!.filter((x) => x !== d),
        );
        const i = edges.findIndex((e) => e.from === d && e.to === id);
        if (i >= 0) edges.splice(i, 1);
      } else if (!s) walk(d);
    }
    state.set(id, 'done');
  };
  for (const id of ids) if (!state.has(id)) walk(id);
  // longest path from a source
  const layerOf = new Map<string, number>();
  const layer = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    const l = deps.get(id)!.reduce((m, d) => Math.max(m, layer(d) + 1), 0);
    layerOf.set(id, l);
    return l;
  };
  for (const id of ids) layer(id);
  const layers: string[][] = [];
  for (const id of ids) (layers[layerOf.get(id)!] ??= []).push(id);
  for (const l of layers) l.sort((a, b) => order.get(a)! - order.get(b)!);
  // barycentre ordering: a few sweeps, forward by the dependencies' rows, backward by the dependants'
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) succ.get(e.from)!.push(e.to);
  const rowOf = new Map<string, number>();
  const index = () => layers.forEach((l) => l.forEach((id, i) => rowOf.set(id, i)));
  index();
  const sortBy = (l: string[], neighbours: (id: string) => string[]) => {
    const key = new Map(l.map((id, i) => [id, neighbours(id).length ? neighbours(id).reduce((s, n) => s + rowOf.get(n)!, 0) / neighbours(id).length : i]));
    l.sort((a, b) => key.get(a)! - key.get(b)! || order.get(a)! - order.get(b)!);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    if (sweep % 2 === 0) for (let i = 1; i < layers.length; i++) sortBy(layers[i]!, (id) => deps.get(id)!);
    else for (let i = layers.length - 2; i >= 0; i--) sortBy(layers[i]!, (id) => succ.get(id)!);
    index();
  }
  // positions: columns left to right, each column centred on the tallest one
  const rows = Math.max(1, ...layers.map((l) => l.length));
  const height = rows * o.nodeHeight + (rows - 1) * o.gapY;
  const nodes: FlowNode[] = [];
  layers.forEach((l, li) => {
    const top = (height - (l.length * o.nodeHeight + (l.length - 1) * o.gapY)) / 2;
    l.forEach((id, ri) => nodes.push({ id, step: byId.get(id)!, layer: li, row: ri, x: li * (o.nodeWidth + o.gapX), y: top + ri * (o.nodeHeight + o.gapY), w: o.nodeWidth, h: o.nodeHeight }));
  });
  nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { nodes, edges, problems, width: layers.length ? layers.length * o.nodeWidth + (layers.length - 1) * o.gapX : 0, height: layers.length ? height : 0 };
}

/** The 1-based line of a step in its file's text: its `name:` line (the first that matches), for jumping to it in an editor. */
export function stepLine(text: string, name: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*-?\\s*name:\\s*(["']?)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*(#.*)?$`);
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : undefined;
}

const dotId = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const dotText = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** The flow as Graphviz DOT (`dot -Tsvg`): one node per step with its type, method and URL, one edge per dependency. */
export function toDot(steps: FlowStep[], name = 'flow'): string {
  const g = flowGraph(steps);
  const lines = [`digraph ${dotId(name)} {`, '  rankdir=LR;', '  node [shape=box, fontname="Helvetica", fontsize=10];'];
  for (const n of g.nodes) {
    const s = n.step;
    const detail = [
      s.method && s.url ? `${s.method} ${s.url}` : s.type,
      s.extract?.length ? `→ ${s.extract.join(', ')}` : '',
      s.status ? `${s.status}${s.durationMs !== undefined ? ` · ${s.durationMs} ms` : ''}` : '',
    ].filter(Boolean);
    const colour = s.status === 'passed' ? ', color="#2e8b57"' : s.status === 'failed' || s.status === 'error' ? ', color="#c0392b"' : s.status === 'skipped' ? ', color="#999999", style=dashed' : '';
    lines.push(`  ${dotId(s.id)} [label="${dotText([s.name, ...detail].join('\n'))}"${colour}];`);
  }
  for (const e of g.edges) lines.push(`  ${dotId(e.from)} -> ${dotId(e.to)};`);
  for (const p of g.problems) lines.push(`  // ${dotText(p.message)}`);
  lines.push('}');
  return lines.join('\n') + '\n';
}
