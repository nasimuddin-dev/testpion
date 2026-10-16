/**
 * A test file as a flow: its steps (what the Flow view, `testpion flow` and the flow_graph MCP tool show), with the
 * latest run's result of each step. The layout itself is @testpion/shared's flowGraph (the window draws it too).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { extname } from 'node:path';
import { parseYaml } from '../util/lazy-yaml.js';
import { flowChecks, flowGraph, layoutExtras, stepLine, templateVariables, toDot, type FlowCheck, type FlowFrameDef, type FlowGraph, type FlowNote, type FlowStep } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { TestCase } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { relativeInside } from '../storage/fsutil.js';
import { isSuiteFile, loadTestsFromFile } from './loader.js';
import { readResultsFile } from './runner.js';
import { loopLabel } from './flow-blocks.js';

export interface FlowOfFile {
  /** The file inside tests/, with forward slashes. */
  file: string;
  steps: FlowStep[];
  /** The latest run that included the file, when there is one: the steps carry its status and duration. */
  run?: { runId: string; name: string; startedAt: string };
  /** With `raw: true`: each step as written in the file (by step id), for the flow designer's inspector. */
  raw?: Record<string, Record<string, unknown>>;  /** With `raw: true`: the file's `output:` (what the flow returns), when it declares one. */
  output?: Record<string, unknown>;
  /** The sticky notes on the canvas (`layout.notes`), when there are some. */
  notes?: FlowNote[];
  /** The coloured frames around steps (`layout.frames`), when there are some. */
  frames?: FlowFrameDef[];
  /** The flow's inputs (the designer's Start node): `expose.inputs` when exposed, else `defaults.vars`. */
  inputs?: Array<{ name: string; default?: unknown; description?: string }>;
  /** The MCP tool the file is exposed as (its `expose.tool`), when it is. */
  exposed?: string;
  /**
   * The auth each HTTP step inherits from the file's `defaults: auth:` (by step id) and where it comes from: in effect
   * while the step has no auth of its own, `overridden` when it has. What the inspector shows instead of "No auth", and
   * what Inherit goes back to. Without `raw`, a credential typed into the file is `***` ({{variables}} are kept).
   */
  inheritedAuth?: Record<string, { auth: Record<string, unknown>; from: 'defaults'; overridden?: true }>;
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const SECRET_AUTH_KEY = /^(token|password|secret|clientSecret|consumerSecret|tokenSecret|secretKey|accessKey|privateKey|value|sessionToken)$/;

/**
 * The auth HTTP steps inherit from `defaults: auth:`: each step with no auth of its own (none at the step, none in its
 * `request:`) runs with it, as the loader merges it (loader.ts); a step's own auth (even `{ type: none }`) overrides it.
 */
export function inheritedAuthOf(defaults: Record<string, unknown>, steps: FlowStep[], items: Array<Record<string, unknown>>, o: { redact?: boolean } = {}): FlowOfFile['inheritedAuth'] {
  const written = defaults.auth;
  if (!isMap(written) || typeof written.type !== 'string') return undefined;
  // for agents and the terminal: a credential typed into the file is not repeated ({{variables}} are kept)
  const auth = o.redact ? Object.fromEntries(Object.entries(written).map(([k, v]) => [k, SECRET_AUTH_KEY.test(k) && typeof v === 'string' && !/^\s*\{\{[^{}]+\}\}\s*$/.test(v) ? '***' : v])) : written;
  const out: NonNullable<FlowOfFile['inheritedAuth']> = {};
  steps.forEach((s, i) => {
    if (s.type !== 'http') return;
    const item = items[i] ?? {};
    const own = item.auth ?? (isMap(item.request) ? item.request.auth : undefined);
    out[s.id] = { auth, from: 'defaults', ...(own !== undefined ? { overridden: true as const } : {}) };
  });
  return Object.keys(out).length ? out : undefined;
}

// tp.environment.set('x', ...) and the like: a script that sets a variable for the steps after it
const SET_RE = /\b(?:tp|pm)\.(?:environment|collectionVariables|globals|variables)\.set\(\s*(['"`])([^'"`]+)\1/g;

/** The {{variables}} a test reads anywhere in what it sends, checks and runs (not its name or notes). */
export function variablesUsedBy(t: TestCase): string[] {
  const { name: _n, description: _d, id: _i, file: _f, extract: _e, ...rest } = t as TestCase & { file?: string };
  return templateVariables(JSON.stringify(rest).replace(/\\"/g, '"'));
}

/** The variables a test makes for the tests after it: what it extracts and what its scripts set. */
export function variablesSetBy(t: TestCase): string[] {
  const out = new Set(Object.keys(t.extract ?? {}));
  if (t.type === 'set') for (const k of Object.keys(t.set)) out.add(k);
  for (const s of [t.preRequestScript, t.testScript, t.type === 'script' ? t.script : undefined]) for (const m of (s ?? '').matchAll(SET_RE)) out.add(m[2]!);
  return [...out];
}

/**
 * Mark on each step the variables it reads that nothing provides: not the environment (`known`), not its own vars,
 * not a step before it in the file or one it waits for. A hint for the designer: a script may still set them.
 */
export function markUnresolved(steps: FlowStep[], tests: TestCase[], known: Iterable<string>): void {
  const base = new Set(known);
  const byId = new Map(steps.map((s, i) => [s.id, i]));
  const setBy = tests.map(variablesSetBy);
  const ancestors = (i: number, seen = new Set<number>()): Set<number> => {
    for (const d of steps[i]!.dependsOn ?? []) {
      const j = byId.get(d);
      if (j !== undefined && !seen.has(j)) {
        seen.add(j);
        ancestors(j, seen);
      }
    }
    return seen;
  };
  steps.forEach((s, i) => {
    if (!s.uses?.length) return;
    const have = new Set(base);
    for (const k of Object.keys(tests[i]!.variables ?? {})) have.add(k);
    for (let j = 0; j < i; j++) for (const v of setBy[j]!) have.add(v);
    for (const j of ancestors(i)) for (const v of setBy[j]!) have.add(v);
    const missing = s.uses.filter((v) => !have.has(v));
    if (missing.length) s.unresolved = missing;
  });
}

/** The test as a flow step: name, type, the request line for HTTP, what it extracts and what it waits for. */
export function flowStepOf(t: TestCase): FlowStep {
  const s: FlowStep = { id: t.id ?? t.name, name: t.name, type: t.type };
  if (t.type === 'http') {
    s.method = t.request.method;
    s.url = t.request.url;
  } else if (t.type === 'graphql') s.url = t.endpoint;
  else if (t.type === 'grpc') {
    s.method = t.method;
    s.url = t.target;
  } else if (t.type === 'delay') s.ms = t.ms;
  else if (t.type === 'flow') s.flow = t.flowFile;
  else if (t.type === 'log') s.message = t.message;
  else if (t.type === 'set') {
    s.set = Object.keys(t.set);
    s.scope = t.scope;
  } else if (t.type === 'assert') {
    s.checks = t.assertions?.length ?? 0;
    s.subject = t.subject;
  }
  if (t.until) s.until = t.until.if;
  if (t.finally) s.finally = true;
  if (t.parallel) s.parallel = t.parallel;
  if (t.if !== undefined) s.if = t.if;
  if (t.when !== undefined) s.when = t.when;
  const loop = loopLabel(t);
  if (loop) s.loop = loop;
  // a script step's values are what it sets (tp.variables.set …): the edges after it are labelled with them
  const made = t.type === 'script' || t.type === 'set' ? variablesSetBy(t) : Object.keys(t.extract ?? {});
  if (made.length) s.extract = made;
  if (t.dependsOn?.length) s.dependsOn = [...t.dependsOn];
  const uses = variablesUsedBy(t);
  if (uses.length) s.uses = uses;
  return s;
}

/** `file` as given to `testpion flow` (from the current folder, e.g. tests/rest/auth.yaml, or inside tests/): the path inside tests/. */
export function testFileRef(store: WorkspaceStore, file: string): string {
  const fromCwd = resolve(file);
  // the current folder is a real path; the workspace may be named through a link (-w /tmp/ws on macOS)
  const rel = existsSync(fromCwd) ? relativeInside(store.path('tests'), fromCwd) : undefined;
  return (rel ?? file).split(sep).join('/');
}

/** The steps of a test file (inside tests/) with the latest run's result of each, when a run included the file. */
export async function flowOfFile(store: WorkspaceStore, file: string, opts: { runs?: number; raw?: boolean; known?: Iterable<string>; text?: string } = {}): Promise<FlowOfFile> {
  const abs = store.safePath(file, store.path('tests'));
  if (!existsSync(abs)) throw new ApsError('ConfigurationError', `No such test file: tests/${file}`);
  const rel = relative(store.path('tests'), abs).split(sep).join('/');
  if (isSuiteFile(abs)) return { file: rel, steps: [] };
  // `text`: the file as an editor holds it now (unsaved), so the canvas never shows an older version than the editor
  const text = opts.text ?? readFileSync(abs, 'utf8');
  const steps: FlowStep[] = [];
  const tests: TestCase[] = [];
  for await (const t of loadTestsFromFile(abs, opts.text)) {
    const s = flowStepOf(t);
    s.line = stepLine(text, t.name);
    steps.push(s);
    tests.push(t);
    if (steps.length >= 500) break;
  }
  const out: FlowOfFile = { file: rel, steps };
  // the designer's layout: and each step as written
  let data: unknown;
  try {
    data = extname(abs).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch {
    data = undefined;
  }
  const root = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const layout = root?.layout && typeof root.layout === 'object' ? (root.layout as Record<string, unknown>) : {};
  for (const s of steps) {
    const p = layout[s.id];
    if (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) s.position = [p[0] as number, p[1] as number];
  }
  const { notes, frames } = layoutExtras(layout);
  if (notes.length) out.notes = notes;
  if (frames.length) out.frames = frames;
  // the Start node: what the flow is exposed as, and the values a run starts with
  const expose = root?.expose && typeof root.expose === 'object' && !Array.isArray(root.expose) ? (root.expose as Record<string, unknown>) : undefined;
  if (expose) out.exposed = typeof expose.tool === 'string' ? expose.tool : '';
  const defaultsMap = root?.defaults && typeof root.defaults === 'object' && !Array.isArray(root.defaults) ? (root.defaults as Record<string, unknown>) : {};
  const inputs = expose
    ? (Array.isArray(expose.inputs) ? expose.inputs : [])
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof (i as Record<string, unknown>).name === 'string')
        .map((i) => ({ name: String(i.name), ...(i.default !== undefined ? { default: i.default } : {}), ...(typeof i.description === 'string' ? { description: i.description } : {}) }))
    : defaultsMap.vars && typeof defaultsMap.vars === 'object' && !Array.isArray(defaultsMap.vars)
      ? Object.entries(defaultsMap.vars as Record<string, unknown>).map(([name, v]) => ({ name, default: v }))
      : [];
  if (inputs.length) out.inputs = inputs;
  if (opts.known) markUnresolved(steps, tests, opts.known);
  {
    // the auth steps inherit from defaults: (the designer, `testpion flow --json`, flow_graph); typed secrets are only
    // in the designer's raw read, which shows the file as written
    const items = Array.isArray(data) ? data : Array.isArray(root?.tests) ? (root!.tests as unknown[]) : [];
    const inherited = items.length === steps.length ? inheritedAuthOf(defaultsMap, steps, items as Array<Record<string, unknown>>, { redact: !opts.raw }) : undefined;
    if (inherited) out.inheritedAuth = inherited;
  }
  if (opts.raw) {
    const items = Array.isArray(data) ? data : Array.isArray(root?.tests) ? (root!.tests as unknown[]) : root ? [root] : [];
    if (items.length === steps.length) out.raw = Object.fromEntries(steps.map((s, i) => [s.id, (items[i] ?? {}) as Record<string, unknown>]));
    if (root?.output && typeof root.output === 'object' && !Array.isArray(root.output)) out.output = root.output as Record<string, unknown>;
  }
  if (!steps.length) return out;
  // the latest run that included the file (by the results' file, else by the steps' ids), newest first
  const ids = new Set(steps.map((s) => s.id));
  const wanted = abs.replace(/\\/g, '/').toLowerCase();
  for (const run of store.meta.listRuns({ limit: Math.min(Math.max(opts.runs ?? 30, 1), 300) }).items) {
    const results = join(store.runDir(run.id), 'results.jsonl');
    if (!existsSync(results)) continue;
    const found = new Map<string, { status: string; durationMs: number; tries?: number }>();
    for await (const r of await readResultsFile(results)) {
      const sameFile = r.file ? r.file.replace(/\\/g, '/').toLowerCase() === wanted : ids.has(r.id);
      const tries = typeof r.metadata?.tries === 'number' ? r.metadata.tries : undefined;
      if (sameFile && ids.has(r.id) && !found.has(r.id)) found.set(r.id, { status: r.status, durationMs: r.durationMs, ...(tries !== undefined ? { tries } : {}) });
    }
    if (!found.size) continue;
    for (const s of steps) {
      const r = found.get(s.id);
      if (r) Object.assign(s, r);
    }
    out.run = { runId: run.id, name: run.name, startedAt: run.startedAt };
    break;
  }
  return out;
}

/**
 * The flow with its layout and DOT: what `testpion flow --json` and the flow_graph tool answer. `checks` are the
 * designer's checks as you edit (cycles, steps that can never run, when: without a condition, steps waiting for a
 * finally step, a dependsOn nobody defines, and with an environment's variables known: variables nothing sets).
 */
export function flowReport(flow: FlowOfFile): FlowOfFile & {
  graph: Pick<FlowGraph, 'edges' | 'problems'> & { groups: Array<{ kind: string; name: string; ids: string[] }> };
  layers: string[][];
  checks: FlowCheck[];
  dot: string;
} {
  const g = flowGraph(flow.steps);
  const layers: string[][] = [];
  for (const n of g.nodes) (layers[n.layer] ??= []).push(n.id);
  // the frames without their places: which steps are in a parallel group, which in the Finally lane
  const groups = g.groups.map(({ kind, name, ids }) => ({ kind, name, ids }));
  return { ...flow, graph: { edges: g.edges, problems: g.problems, groups }, layers, checks: flowChecks(flow.steps), dot: toDot(flow.steps, flow.file) };
}
