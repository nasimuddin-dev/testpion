/**
 * A test file as a flow: its steps (what the Flow view, `testpion flow` and the flow_graph MCP tool show), with the
 * latest run's result of each step. The layout itself is @testpion/shared's flowGraph (the window draws it too).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { extname } from 'node:path';
import { parseYaml } from '../util/lazy-yaml.js';
import { flowGraph, stepLine, templateVariables, toDot, type FlowGraph, type FlowStep } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { TestCase } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { isSuiteFile, loadTestsFromFile } from './loader.js';
import { readResultsFile } from './runner.js';

export interface FlowOfFile {
  /** The file inside tests/, with forward slashes. */
  file: string;
  steps: FlowStep[];
  /** The latest run that included the file, when there is one: the steps carry its status and duration. */
  run?: { runId: string; name: string; startedAt: string };
  /** With `raw: true`: each step as written in the file (by step id), for the flow designer's inspector. */
  raw?: Record<string, Record<string, unknown>>;
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
  for (const s of [t.preRequestScript, t.testScript]) for (const m of (s ?? '').matchAll(SET_RE)) out.add(m[2]!);
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
  if (t.extract && Object.keys(t.extract).length) s.extract = Object.keys(t.extract);
  if (t.dependsOn?.length) s.dependsOn = [...t.dependsOn];
  const uses = variablesUsedBy(t);
  if (uses.length) s.uses = uses;
  return s;
}

/** `file` as given to `testpion flow` (from the current folder, e.g. tests/rest/auth.yaml, or inside tests/): the path inside tests/. */
export function testFileRef(store: WorkspaceStore, file: string): string {
  const tests = store.path('tests');
  const fromCwd = resolve(file);
  const rel = relative(tests, fromCwd);
  const inside = existsSync(fromCwd) && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
  return inside.split(sep).join('/');
}

/** The steps of a test file (inside tests/) with the latest run's result of each, when a run included the file. */
export async function flowOfFile(store: WorkspaceStore, file: string, opts: { runs?: number; raw?: boolean; known?: Iterable<string> } = {}): Promise<FlowOfFile> {
  const abs = store.safePath(file, store.path('tests'));
  if (!existsSync(abs)) throw new ApsError('ConfigurationError', `No such test file: tests/${file}`);
  const rel = relative(store.path('tests'), abs).split(sep).join('/');
  if (isSuiteFile(abs)) return { file: rel, steps: [] };
  const text = readFileSync(abs, 'utf8');
  const steps: FlowStep[] = [];
  const tests: TestCase[] = [];
  for await (const t of loadTestsFromFile(abs)) {
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
  if (opts.known) markUnresolved(steps, tests, opts.known);
  if (opts.raw) {
    const items = Array.isArray(data) ? data : Array.isArray(root?.tests) ? (root!.tests as unknown[]) : root ? [root] : [];
    if (items.length === steps.length) out.raw = Object.fromEntries(steps.map((s, i) => [s.id, (items[i] ?? {}) as Record<string, unknown>]));
  }
  if (!steps.length) return out;
  // the latest run that included the file (by the results' file, else by the steps' ids), newest first
  const ids = new Set(steps.map((s) => s.id));
  const wanted = abs.replace(/\\/g, '/').toLowerCase();
  for (const run of store.meta.listRuns({ limit: Math.min(Math.max(opts.runs ?? 30, 1), 300) }).items) {
    const results = join(store.runDir(run.id), 'results.jsonl');
    if (!existsSync(results)) continue;
    const found = new Map<string, { status: string; durationMs: number }>();
    for await (const r of await readResultsFile(results)) {
      const sameFile = r.file ? r.file.replace(/\\/g, '/').toLowerCase() === wanted : ids.has(r.id);
      if (sameFile && ids.has(r.id) && !found.has(r.id)) found.set(r.id, { status: r.status, durationMs: r.durationMs });
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

/** The flow with its layout and DOT: what `testpion flow --json` and the flow_graph tool answer. */
export function flowReport(flow: FlowOfFile): FlowOfFile & { graph: Pick<FlowGraph, 'edges' | 'problems'>; layers: string[][]; dot: string } {
  const g = flowGraph(flow.steps);
  const layers: string[][] = [];
  for (const n of g.nodes) (layers[n.layer] ??= []).push(n.id);
  return { ...flow, graph: { edges: g.edges, problems: g.problems }, layers, dot: toDot(flow.steps, flow.file) };
}
