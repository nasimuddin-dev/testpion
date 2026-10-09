/**
 * A test file as a flow: its steps (what the Flow view, `testpion flow` and the flow_graph MCP tool show), with the
 * latest run's result of each step. The layout itself is @testpion/shared's flowGraph (the window draws it too).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { flowGraph, stepLine, toDot, type FlowGraph, type FlowStep } from '@testpion/shared';
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
  }
  if (t.extract && Object.keys(t.extract).length) s.extract = Object.keys(t.extract);
  if (t.dependsOn?.length) s.dependsOn = [...t.dependsOn];
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
export async function flowOfFile(store: WorkspaceStore, file: string, opts: { runs?: number } = {}): Promise<FlowOfFile> {
  const abs = store.safePath(file, store.path('tests'));
  if (!existsSync(abs)) throw new ApsError('ConfigurationError', `No such test file: tests/${file}`);
  const rel = relative(store.path('tests'), abs).split(sep).join('/');
  if (isSuiteFile(abs)) return { file: rel, steps: [] };
  const text = readFileSync(abs, 'utf8');
  const steps: FlowStep[] = [];
  for await (const t of loadTestsFromFile(abs)) {
    const s = flowStepOf(t);
    s.line = stepLine(text, t.name);
    steps.push(s);
    if (steps.length >= 500) break;
  }
  const out: FlowOfFile = { file: rel, steps };
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
