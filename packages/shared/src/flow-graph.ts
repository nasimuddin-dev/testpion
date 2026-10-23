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
  /** A delay step: the milliseconds it waits. */
  ms?: number;
  /** A condition step: its expression; any other step: its `if:` (it runs only when that is true). */
  if?: string;
  /** A branch of a condition it depends on: runs when the condition came out true (or false). */
  when?: boolean;
  /** A repeat / forEach step: "× 3", "× each row of datasets/users.csv". */
  loop?: string;
  /** A sub-flow step: the file it runs. */
  flow?: string;
  /** A log step: the message (a template). */
  message?: string;
  /** A Wait until: the expression the step is run again until (its `until.if`). */
  until?: string;
  /** A Wait until's tries in the latest run. */
  tries?: number;
  /** A clean-up step: runs after every other step of the file, whatever happened (drawn in the Finally lane). */
  finally?: boolean;
  /** The parallel group the step is in (drawn in a frame with the group's other steps). */
  parallel?: string;
  /** A Set variable step: the names it writes, and where (run, environment, collection, global). */
  set?: string[];
  scope?: string;
  /** An Assert step: how many checks, and on what (the previous response, or the variables). */
  checks?: number;
  subject?: string;
  /** The names the step extracts for the steps after it. */
  extract?: string[];
  /** The {{variables}} the step reads (its request, checks and scripts). */
  uses?: string[];
  /** Variables it reads that no earlier step extracts and the environment does not define (likely a mistake). */
  unresolved?: string[];
  /** Where the flow designer put the step (the file's `layout:`); without it the step is laid out in its column. */
  position?: [number, number];
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
  /** The variables the source extracts and the target reads: what flows along the edge (only when there are some). */
  vars?: string[];
  /** From a condition: the branch (its true or false output) the target runs on. */
  when?: boolean;
}

/** What a step shows under its name: the request, the wait, the condition, the sub-flow, the message. */
export function stepDetail(s: FlowStep): string {
  if (s.method && s.url) return `${s.method} ${s.url}`;
  if (s.type === 'delay' && s.ms !== undefined) return `wait ${s.ms} ms`;
  if (s.type === 'condition' && s.if) return `if ${s.if}`;
  if (s.type === 'flow' && s.flow) return `runs ${s.flow}`;
  if (s.type === 'log' && s.message !== undefined) return `log ${s.message}`;
  if (s.type === 'set' && s.set) return `set ${s.set.join(', ')}${s.scope && s.scope !== 'run' ? ` → ${s.scope}` : ''}`;
  if (s.type === 'assert') return `${s.checks ?? 0} check${s.checks === 1 ? '' : 's'} on ${s.subject === 'variables' ? 'the variables' : 'the response'}`;
  return s.type;
}

/** What a Wait until shows: "until $.status == 'done' · 3 tries" (the tries of the latest run, when known). */
export function untilLabel(s: FlowStep): string | undefined {
  if (!s.until) return undefined;
  return `until ${s.until}${s.tries !== undefined ? ` · ${s.tries} ${s.tries === 1 ? 'try' : 'tries'}` : ''}`;
}

/** A frame around steps on the canvas: a parallel group (its steps may run together) or the Finally lane (clean-up that always runs). */
export interface FlowGroup {
  kind: 'parallel' | 'finally';
  /** The group's name (parallel), or "finally". */
  name: string;
  ids: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The room a frame leaves around its steps, and above them for its label. */
const GROUP_PAD = 12;
const GROUP_HEAD = 20;

/** The frames of the laid-out nodes: one per parallel group, one for the finally steps. */
export function flowGroups(nodes: FlowNode[]): FlowGroup[] {
  const sets = new Map<string, { kind: FlowGroup['kind']; name: string; nodes: FlowNode[] }>();
  for (const n of nodes) {
    const key = n.step.finally ? 'finally' : n.step.parallel ? `parallel:${n.step.parallel}` : undefined;
    if (!key) continue;
    const g = sets.get(key) ?? sets.set(key, { kind: n.step.finally ? 'finally' : 'parallel', name: n.step.finally ? 'finally' : n.step.parallel!, nodes: [] }).get(key)!;
    g.nodes.push(n);
  }
  return [...sets.values()].map((g) => {
    const x = Math.min(...g.nodes.map((n) => n.x)) - GROUP_PAD;
    const y = Math.min(...g.nodes.map((n) => n.y)) - GROUP_PAD - GROUP_HEAD;
    const w = Math.max(...g.nodes.map((n) => n.x + n.w)) + GROUP_PAD - x;
    const h = Math.max(...g.nodes.map((n) => n.y + n.h)) + GROUP_PAD - y;
    return { kind: g.kind, name: g.name, ids: g.nodes.map((n) => n.id), x, y, w, h };
  });
}

/** Something the layout could not honour: a dependency nobody defines, a cycle. The diagram still draws. */
interface FlowProblem {
  step: string;
  message: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Frames: the parallel groups and the Finally lane. */
  groups: FlowGroup[];
  problems: FlowProblem[];
  width: number;
  height: number;
}

interface FlowLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
}

const DEFAULTS: Required<FlowLayoutOptions> = { nodeWidth: 220, nodeHeight: 72, gapX: 64, gapY: 20 };

/** A step's size on the canvas. */
export const STEP_SIZE = { w: DEFAULTS.nodeWidth, h: DEFAULTS.nodeHeight };

/**
 * Where a new step (or a step put somewhere) can go: `at` when nothing is there, else the nearest free place below it
 * in the same column (a gap of `margin` around every box). The one placement rule of the designer: the picker, the
 * toolbar, a drop, a paste, a duplicate and a step dropped into a parallel group all use it. With `nearest` (a step
 * put where the user pointed: "Add step here") the free place nearest to `at` in any direction: below, above, right or left.
 */
export function freeSpot(occupied: Array<{ x: number; y: number; w: number; h: number }>, at: [number, number], size: { w: number; h: number } = STEP_SIZE, margin = 16, nearest = false): [number, number] {
  const x0 = Math.round(at[0]);
  const y0 = Math.round(at[1]);
  const hitAt = (x: number, y: number) => occupied.find((b) => x < b.x + b.w + margin && x + size.w + margin > b.x && y < b.y + b.h + margin && y + size.h + margin > b.y);
  /** Step away from what is in the way, one box at a time, in one direction, until the place is free. */
  const walk = (dir: 'down' | 'up' | 'right' | 'left'): [number, number] => {
    let x = x0;
    let y = y0;
    for (let i = 0; i < 1000; i++) {
      const hit = hitAt(x, y);
      if (!hit) break;
      if (dir === 'down') y = Math.round(hit.y + hit.h + margin);
      else if (dir === 'up') y = Math.round(hit.y - size.h - margin);
      else if (dir === 'right') x = Math.round(hit.x + hit.w + margin);
      else x = Math.round(hit.x - size.w - margin);
    }
    return [x, y];
  };
  if (!nearest) return walk('down');
  const dist = (p: [number, number]) => Math.hypot(p[0] - x0, p[1] - y0);
  return (['down', 'up', 'right', 'left'] as const).map(walk).reduce((best, p) => (dist(p) < dist(best) ? p : best));
}

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
        const src = byId.get(d)!;
        const target = byId.get(id)!;
        const vars = (src.extract ?? []).filter((v) => target.uses?.includes(v));
        edges.push({ from: d, to: id, ...(vars.length ? { vars } : {}), ...(src.type === 'condition' && target.when !== undefined ? { when: target.when } : {}) });
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
  // the finally steps form the last lane: after every other step (in file order, after the finally steps they wait for)
  const lastNormal = ids.reduce((m, id) => (byId.get(id)!.finally ? m : Math.max(m, layerOf.get(id)!)), -1);
  for (const id of ids)
    if (byId.get(id)!.finally) layerOf.set(id, deps.get(id)!.reduce((m, d) => (byId.get(d)!.finally ? Math.max(m, layerOf.get(d)! + 1) : m), Math.max(layerOf.get(id)!, lastNormal + 1)));
  const layers: string[][] = [];
  for (const id of ids) (layers[layerOf.get(id)!] ??= []).push(id);
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];
  // inside a column the steps of a parallel group sit together (their frame then holds only them)
  const groupAt = new Map<string, number>();
  for (const id of ids) {
    const g = byId.get(id)!.parallel;
    if (g && !groupAt.has(g)) groupAt.set(g, order.get(id)!);
  }
  const sortKey = (id: string) => (byId.get(id)!.parallel ? groupAt.get(byId.get(id)!.parallel!)! : order.get(id)!);
  for (const l of layers) l.sort((a, b) => sortKey(a) - sortKey(b) || order.get(a)! - order.get(b)!);
  /** A column with each parallel group's steps next to each other (at its first member's place). */
  const joinGroups = (l: string[]): string[] => {
    const out: string[] = [];
    for (const id of l) {
      const g = byId.get(id)!.parallel;
      const last = g ? out.map((o) => byId.get(o)!.parallel).lastIndexOf(g) : -1;
      if (last >= 0) out.splice(last + 1, 0, id);
      else out.push(id);
    }
    return out;
  };
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
  layers.forEach((l, i) => (layers[i] = joinGroups(l)));
  index();
  // positions: columns left to right, each column centred on the tallest one; a frame's steps get room for its label
  const frameOf = (id: string) => (byId.get(id)!.finally ? 'finally' : byId.get(id)!.parallel ? `p:${byId.get(id)!.parallel}` : '');
  const offsets = layers.map((l) => {
    let y = 0;
    return l.map((id, ri) => {
      const f = frameOf(id);
      const prev = ri > 0 ? frameOf(l[ri - 1]!) : '';
      if (ri > 0) y += o.nodeHeight + o.gapY;
      // entering a frame (its label above), or leaving one (its bottom edge below the step before)
      if (f !== prev) y += (f ? GROUP_PAD + GROUP_HEAD : 0) + (prev ? GROUP_PAD : 0);
      else if (ri === 0 && f) y += GROUP_PAD + GROUP_HEAD;
      return y;
    });
  });
  const colHeight = (li: number) => (layers[li]!.length ? offsets[li]![offsets[li]!.length - 1]! + o.nodeHeight + (frameOf(layers[li]![layers[li]!.length - 1]!) ? GROUP_PAD : 0) : 0);
  const height = Math.max(o.nodeHeight, ...layers.map((_, li) => colHeight(li)));
  const nodes: FlowNode[] = [];
  layers.forEach((l, li) => {
    const top = (height - colHeight(li)) / 2;
    l.forEach((id, ri) => nodes.push({ id, step: byId.get(id)!, layer: li, row: ri, x: li * (o.nodeWidth + o.gapX), y: top + offsets[li]![ri]!, w: o.nodeWidth, h: o.nodeHeight }));
  });
  nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  // steps placed by hand (the designer's layout:) keep their place; the others go below them, in their columns
  const placed = nodes.filter((n) => n.step.position);
  if (placed.length) {
    const below = Math.max(...placed.map((n) => n.step.position![1] + o.nodeHeight)) + o.gapY * 2;
    for (const n of nodes) {
      if (n.step.position) {
        n.x = n.step.position[0];
        n.y = n.step.position[1];
      } else n.y += below;
    }
    return { nodes, edges, groups: flowGroups(nodes), problems, width: Math.max(...nodes.map((n) => n.x + n.w)), height: Math.max(...nodes.map((n) => n.y + n.h)) };
  }
  return { nodes, edges, groups: flowGroups(nodes), problems, width: layers.length ? layers.length * o.nodeWidth + (layers.length - 1) * o.gapX : 0, height: layers.length ? height : 0 };
}

/** The 1-based line of a step in its file's text: its `name:` line (the first that matches), for jumping to it in an editor. */
export function stepLine(text: string, name: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*-?\\s*name:\\s*(["']?)${n}\\1\\s*(#.*)?$`);
  let i = lines.findIndex((l) => re.test(l));
  // a step written on one line as a flow map: - { id: echo, name: Echo who, url: … }
  if (i < 0) {
    const inline = new RegExp(`[{,]\\s*name:\\s*(["']?)${n}\\1\\s*[,}]`);
    i = lines.findIndex((l) => inline.test(l));
  }
  return i >= 0 ? i + 1 : undefined;
}

/**
 * `stepLine` for many steps at once: the file is split and scanned once, every `name:` line noted, then each name is a map read
 * (stepLine split the file and compiled one or two regular expressions per step: 500 steps x every line of the file).
 */
export function stepLines(text: string): (name: string) => number | undefined {
  const block = new Map<string, number>();
  const inline = new Map<string, number>();
  const blockRe = /^\s*-?\s*name:\s*(["']?)(.+?)\1\s*(#.*)?$/;
  const inlineRe = /[{,]\s*name:\s*(["']?)(.+?)\1\s*[,}]/g;
  text.split(/\r?\n/).forEach((l, i) => {
    const b = blockRe.exec(l);
    if (b && !block.has(b[2]!)) block.set(b[2]!, i + 1);
    if (l.includes('name:'))
      for (const m of l.matchAll(inlineRe)) if (!inline.has(m[2]!)) inline.set(m[2]!, i + 1);
  });
  return (name) => block.get(name) ?? inline.get(name);
}

/* ------------------------------------------------------------------ notes and frames (the canvas only) */

/** The colours a sticky note or a frame can have (names, so the file reads well and the theme picks the shade). */
export const FLOW_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'] as const;

/** A sticky note on the canvas (the file's `layout.notes`): Markdown text in a box. The runner ignores it. */
export interface FlowNote {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  text: string;
}

/** A coloured frame with a title around some steps (the file's `layout.frames`): it only groups them visually. */
export interface FlowFrameDef {
  id: string;
  title: string;
  color?: string;
  steps: string[];
}

/** A frame placed around its steps. */
export interface FlowFrameBox extends FlowFrameDef {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A frame's room around its steps: more than a parallel group's, so a frame drawn around one holds it whole. */
const FRAME_PAD = 22;
const FRAME_HEAD = 26;

/** The frames around the laid-out nodes (a frame whose steps are all gone is left out). */
export function frameBoxes(nodes: Array<Pick<FlowNode, 'id' | 'x' | 'y' | 'w' | 'h'> & { step?: { finally?: boolean; parallel?: string } }>, frames: FlowFrameDef[] | undefined): FlowFrameBox[] {
  if (!frames?.length) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: FlowFrameBox[] = [];
  for (const f of frames) {
    const inside = f.steps.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
    if (!inside.length) continue;
    // a step in a parallel frame or the Finally lane: room for that frame's label too
    const grouped = inside.some((n) => n.step?.parallel || n.step?.finally);
    const extra = grouped ? GROUP_PAD : 0;
    const x = Math.min(...inside.map((n) => n.x)) - FRAME_PAD - extra;
    const y = Math.min(...inside.map((n) => n.y)) - FRAME_PAD - FRAME_HEAD - (grouped ? GROUP_PAD + GROUP_HEAD : 0);
    const w = Math.max(...inside.map((n) => n.x + n.w)) + FRAME_PAD + extra - x;
    const h = Math.max(...inside.map((n) => n.y + n.h)) + FRAME_PAD + extra - y;
    out.push({ ...f, x, y, w, h });
  }
  return out;
}

/** The notes and frames of a file's `layout:` (what is not a step's [x, y]); anything malformed is left out. */
export function layoutExtras(layout: unknown): { notes: FlowNote[]; frames: FlowFrameDef[] } {
  const l = layout && typeof layout === 'object' && !Array.isArray(layout) ? (layout as Record<string, unknown>) : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const notes = (Array.isArray(l.notes) ? l.notes : [])
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object' && !Array.isArray(n) && (typeof n.id === 'string' || typeof n.id === 'number'))
    .map((n) => ({
      id: String(n.id),
      x: num(n.x, 0),
      y: num(n.y, 0),
      w: Math.max(80, num(n.w, 220)),
      h: Math.max(48, num(n.h, 120)),
      ...(typeof n.color === 'string' ? { color: n.color } : {}),
      text: typeof n.text === 'string' ? n.text : n.text === undefined || n.text === null ? '' : String(n.text),
    }));
  const frames = (Array.isArray(l.frames) ? l.frames : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f) && (typeof f.id === 'string' || typeof f.id === 'number'))
    .map((f) => ({
      id: String(f.id),
      title: typeof f.title === 'string' ? f.title : String(f.title ?? ''),
      ...(typeof f.color === 'string' ? { color: f.color } : {}),
      steps: (Array.isArray(f.steps) ? f.steps : []).map(String),
    }));
  return { notes, frames };
}

/* ------------------------------------------------------------------ checks as you edit */

type FlowCheckKind = 'unset-variable' | 'missing-step' | 'unreachable' | 'cycle' | 'when-without-condition' | 'waits-for-finally';

/** Something likely wrong in a flow, on a step (and an edge): the designer's problems strip, `testpion flow`, lint. */
export interface FlowCheck {
  kind: FlowCheckKind;
  severity: 'error' | 'warning';
  /** The step it is about. */
  step: string;
  message: string;
  /** The connection it is about, when it is one. */
  edge?: { from: string; to: string };
}

/** A condition's expression that is always true or always false: `true`, `false` (as written). */
const constantIf = (s: FlowStep | undefined): boolean | undefined => {
  const t = s?.if?.trim().toLowerCase();
  return t === 'true' ? true : t === 'false' ? false : undefined;
};

/**
 * What the designer checks as you edit: variables a step reads that nothing sets (its `unresolved`, computed with the
 * environment), a dependsOn nobody in the file defines, cycles, steps that can never run (they wait for a step in a
 * cycle, for a missing step, for a finally step, for a step that never runs, or only for branches that are never
 * taken: a condition written as `if: true` / `if: false`), `when:` without a condition to pick a branch of, and
 * steps that wait for a finally step. Mirrors the runner's rules: a step skipped because its branch was not taken
 * skips the steps after it only when all of what they wait for was not taken; finally steps run whatever happened.
 */
export function flowChecks(steps: FlowStep[]): FlowCheck[] {
  const out: FlowCheck[] = [];
  const byId = new Map<string, FlowStep>();
  for (const s of steps) if (!byId.has(s.id)) byId.set(s.id, s);
  const all = [...byId.values()];
  const deps = (s: FlowStep) => [...new Set(s.dependsOn ?? [])];
  const label = (id: string) => `"${byId.get(id)?.name ?? id}"`;
  // cycles: the strongly connected parts of the graph (Tarjan, without recursion: a chain of thousands of steps must not
  // overflow the stack), or a step that waits for itself. `post` is the steps in post-order: dependencies first.
  const depsOf = new Map(all.map((s) => [s.id, deps(s).filter((d) => byId.has(d))]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const inCycle = new Map<string, string[]>();
  const cycleText = new Map<string[], string>();
  const post: string[] = [];
  let next = 0;
  for (const root of all) {
    if (index.has(root.id)) continue;
    const work: Array<{ id: string; i: number }> = [{ id: root.id, i: 0 }];
    index.set(root.id, next);
    low.set(root.id, next++);
    stack.push(root.id);
    onStack.add(root.id);
    while (work.length) {
      const top = work[work.length - 1]!;
      const ds = depsOf.get(top.id)!;
      if (top.i < ds.length) {
        const d = ds[top.i++]!;
        if (!index.has(d)) {
          index.set(d, next);
          low.set(d, next++);
          stack.push(d);
          onStack.add(d);
          work.push({ id: d, i: 0 });
        } else if (onStack.has(d)) low.set(top.id, Math.min(low.get(top.id)!, index.get(d)!));
        continue;
      }
      work.pop();
      post.push(top.id);
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(top.id)!));
      if (low.get(top.id) === index.get(top.id)) {
        const part: string[] = [];
        let x: string;
        do {
          x = stack.pop()!;
          onStack.delete(x);
          part.push(x);
        } while (x !== top.id);
        if (part.length > 1 || depsOf.get(top.id)!.includes(top.id)) for (const p of part) inCycle.set(p, part);
      }
    }
  }
  for (const s of all) {
    const part = inCycle.get(s.id);
    if (part) {
      // one text per cycle, naming at most five of its steps (a cycle of thousands stays one short line)
      let names = cycleText.get(part);
      if (!names) {
        const shown = part.slice(0, 5).map(label).join(', ');
        names = part.length === 1 ? `${label(s.id)} waits for itself` : `${shown}${part.length > 5 ? ` and ${part.length - 5} more` : ''} wait for each other (a cycle)`;
        cycleText.set(part, names);
      }
      const d = deps(s).find((x) => inCycle.get(x) === part);
      out.push({ kind: 'cycle', severity: 'error', step: s.id, message: `${names}: none of them can run`, ...(d ? { edge: { from: d, to: s.id } } : {}) });
    }
    for (const v of s.unresolved ?? [])
      out.push({ kind: 'unset-variable', severity: 'warning', step: s.id, message: `${label(s.id)} reads {{${v}}}, which no earlier step sets and the environment does not define` });
    for (const d of deps(s)) {
      if (!byId.has(d)) out.push({ kind: 'missing-step', severity: 'warning', step: s.id, message: `${label(s.id)} waits for "${d}", which no step of this file defines: it never runs when the file runs on its own` });
      else if (byId.get(d)!.finally && !s.finally)
        out.push({ kind: 'waits-for-finally', severity: 'error', step: s.id, edge: { from: d, to: s.id }, message: `${label(s.id)} waits for ${label(d)}, a finally step: finally steps run after every other step, so it never runs` });
    }
    if (s.when !== undefined && !deps(s).some((d) => byId.get(d)?.type === 'condition'))
      out.push({ kind: 'when-without-condition', severity: 'warning', step: s.id, message: `${label(s.id)} has when: ${s.when} but waits for no condition step: connect it from a condition's true or false output (or remove when:)` });
  }
  // what never runs: "hard" (skipped as a failure: whatever waits for it skips) or "branch" (not taken: what waits only for not-taken steps skips)
  const dead = new Map<string, { how: 'hard' | 'branch'; why: string; direct: boolean }>();
  for (const s of all) {
    if (inCycle.has(s.id)) dead.set(s.id, { how: 'hard', why: 'it is in a cycle', direct: true });
    else if (!s.finally && deps(s).some((d) => !byId.has(d) || byId.get(d)!.finally)) dead.set(s.id, { how: 'hard', why: 'see above', direct: true });
    else if (s.type !== 'condition' && constantIf(s) === false) dead.set(s.id, { how: 'branch', why: `its if: is always false`, direct: false });
    else if (s.when !== undefined) {
      const c = deps(s).find((d) => byId.get(d)?.type === 'condition' && constantIf(byId.get(d)) !== undefined && constantIf(byId.get(d)) !== s.when);
      if (c) dead.set(s.id, { how: 'branch', why: `it is on the ${s.when} branch of ${label(c)}, whose if: is always ${String(!s.when)}`, direct: false });
    }
  }
  // one pass, dependencies first (post-order): what a step waits for is decided before the step (cycles are dead already)
  for (const id of post) {
    const s = byId.get(id)!;
    if (dead.has(id) || s.finally) continue;
    const ds = depsOf.get(id)!;
    if (!ds.length) continue;
    const hard = ds.find((d) => dead.get(d)?.how === 'hard');
    if (hard) dead.set(id, { how: 'hard', why: `it waits for ${label(hard)}, which never runs`, direct: false });
    else if (ds.every((d) => dead.has(d))) dead.set(id, { how: 'branch', why: `everything it waits for (${ds.map(label).join(', ')}) never runs`, direct: false });
  }
  for (const s of all) {
    const d = dead.get(s.id);
    if (d && !d.direct) out.push({ kind: 'unreachable', severity: 'warning', step: s.id, message: `${label(s.id)} can never run: ${d.why}` });
  }
  const order = new Map(steps.map((s, i) => [s.id, i]));
  return out.sort((a, b) => (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0));
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
      stepDetail(s),
      s.type !== 'condition' && s.if ? `if ${s.if}` : '',
      s.loop ?? '',
      untilLabel(s) ?? '',
      s.extract?.length ? `→ ${s.extract.join(', ')}` : '',
      s.status ? `${s.status}${s.durationMs !== undefined ? ` · ${s.durationMs} ms` : ''}` : '',
    ].filter(Boolean);
    const colour = s.status === 'passed' ? ', color="#2e8b57"' : s.status === 'failed' || s.status === 'error' ? ', color="#c0392b"' : s.status === 'skipped' ? ', color="#999999", style=dashed' : '';
    lines.push(`  ${dotId(s.id)} [label="${dotText([s.name, ...detail].join('\n'))}"${s.type === 'condition' ? ', shape=diamond' : ''}${colour}];`);
  }
  for (const e of g.edges) {
    const label = [e.when !== undefined ? String(e.when) : '', e.vars?.length ? e.vars.join(', ') : ''].filter(Boolean).join(': ');
    lines.push(`  ${dotId(e.from)} -> ${dotId(e.to)}${label ? ` [label="${dotText(label)}"]` : ''};`);
  }
  g.groups.forEach((x, i) => {
    lines.push(`  subgraph cluster_${i} {`, `    label="${dotText(x.kind === 'finally' ? 'finally' : `parallel · ${x.name}`)}"; style=dashed;`);
    for (const id of x.ids) lines.push(`    ${dotId(id)};`);
    lines.push('  }');
  });
  for (const p of g.problems) lines.push(`  // ${dotText(p.message)}`);
  lines.push('}');
  return lines.join('\n') + '\n';
}
