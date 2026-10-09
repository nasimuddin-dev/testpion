/**
 * A flow's debugging data: its run history (the runs that included the file, newest first, each step's result with
 * the variables after it), the plan of a run that starts part-way through (Run from here, Run to here, replay of a
 * failed run on its own data) and the designer's state per file (breakpoints and pinned responses), kept in the
 * workspace's `.local/flows/` (per computer, git-ignored; never in the YAML). The app's flow designer, `testpion flow
 * runs`, `testpion test --from / --seed-run` and the flow_runs / run_tests MCP tools read these.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { TestResult, TestStatus, Trace } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { atomicWrite } from '../storage/fsutil.js';
import { isSuiteFile, loadTestsFromFile } from './loader.js';
import { readResultsFile } from './runner.js';
import { readRunSummary } from './run-records.js';
import type { StepResponse } from './flow-blocks.js';
import { PIN_BODY_LIMIT, isPartialValue, type PinnedResponse, type RunSeed } from './debug-hooks.js';

/** One run of a flow, as its history lists it. */
export interface FlowRunRow {
  runId: string;
  name: string;
  startedAt: string;
  durationMs: number;
  /** failed: a step of this file failed or errored; cancelled: the run was stopped; else passed. */
  status: 'passed' | 'failed' | 'cancelled';
  environment?: string;
  /** The steps of this file the run included, and how they went. */
  steps: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  /** The first step of this file that failed or errored, by id. */
  firstFailed?: string;
}

/** A step of a flow file: its id and what it waits for. */
interface StepRef {
  id: string;
  name: string;
  dependsOn: string[];
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** The test file inside tests/ (absolute) and its path with forward slashes, or an error for a missing file or a suite. */
function flowFile(store: WorkspaceStore, file: string): { abs: string; rel: string } {
  const abs = store.safePath(file, store.path('tests'));
  if (!existsSync(abs)) throw new ApsError('ConfigurationError', `No such test file: tests/${file}`);
  if (isSuiteFile(abs)) throw new ApsError('ValidationError', `tests/${file} is a suite: open one of the files it names`);
  return { abs, rel: relative(store.path('tests'), abs).split(sep).join('/') };
}

async function stepsOf(abs: string): Promise<StepRef[]> {
  const out: StepRef[] = [];
  for await (const t of loadTestsFromFile(abs)) {
    out.push({ id: t.id ?? t.name, name: t.name, dependsOn: [...(t.dependsOn ?? [])] });
    if (out.length >= 500) break;
  }
  return out;
}

/** A step by id, else by name; an error that lists the steps when there is none. */
function stepRef(steps: StepRef[], ref: string, what: string): StepRef {
  const s = steps.find((x) => x.id === ref) ?? steps.find((x) => x.name === ref);
  if (!s) throw new ApsError('ValidationError', `${what}: no step "${ref}" in the flow. Steps: ${steps.map((x) => x.id).join(', ') || 'none'}`);
  return s;
}

/** The results of one file in a run, in the order they finished (at most 1000). */
async function resultsOf(store: WorkspaceStore, abs: string, runId: string, ids?: Set<string>): Promise<TestResult[]> {
  const f = join(store.runDir(runId), 'results.jsonl');
  if (!existsSync(f)) return [];
  const wanted = norm(abs);
  const out: TestResult[] = [];
  for await (const r of await readResultsFile(f)) {
    const mine = r.file ? norm(r.file) === wanted : !!ids?.has(r.id);
    if (!mine) continue;
    out.push(r);
    if (out.length >= 1000) break;
  }
  return out;
}

/**
 * The runs that included a flow file, newest first: when, how long, how its steps went. Runs record the files they
 * included (summary.json `files`); older runs are read when they are small enough (at most 5000 results).
 */
export async function flowRuns(store: WorkspaceStore, file: string, opts: { limit?: number; scan?: number } = {}): Promise<{ file: string; runs: FlowRunRow[] }> {
  const { abs, rel } = flowFile(store, file);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const wanted = norm(abs);
  const ids = new Set((await stepsOf(abs)).map((s) => s.id));
  const runs: FlowRunRow[] = [];
  for (const run of store.meta.listRuns({ limit: Math.min(Math.max(opts.scan ?? 300, limit), 1000) }).items) {
    if (runs.length >= limit) break;
    const summary = readRunSummary(store, run.id);
    if (summary?.files && !summary.files.some((f) => norm(f) === wanted)) continue;
    if (!summary?.files && run.total > 5000) continue;
    const results = await resultsOf(store, abs, run.id, ids);
    if (!results.length) continue;
    const count = (s: TestStatus) => results.filter((r) => r.status === s).length;
    const bad = results.find((r) => r.status === 'failed' || r.status === 'error');
    runs.push({
      runId: run.id,
      name: run.name,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      status: summary?.cancelled ? 'cancelled' : bad ? 'failed' : 'passed',
      ...(run.environment ? { environment: run.environment } : {}),
      steps: results.length,
      passed: count('passed'),
      failed: count('failed'),
      errors: count('error'),
      skipped: count('skipped'),
      ...(bad ? { firstFailed: bad.id } : {}),
    });
  }
  return { file: rel, runs };
}

/** One run of a flow in full: each step's result (checks, input, output, timing, the variables after it), in file order. */
export async function flowRunResults(store: WorkspaceStore, file: string, runId: string): Promise<{ file: string; runId: string; results: TestResult[] }> {
  const { abs, rel } = flowFile(store, file);
  const steps = await stepsOf(abs);
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const results = await resultsOf(store, abs, runId, new Set(order.keys()));
  results.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  return { file: rel, runId, results };
}

/** A step's response as an earlier run recorded it: the status, and the output (JSON when it parses). */
function responseOfResult(r: TestResult): StepResponse | undefined {
  const status = (r.metadata as { status?: unknown } | undefined)?.status;
  if (typeof status !== 'number' && r.output === undefined) return undefined;
  let body: unknown = r.output;
  try {
    body = r.output !== undefined ? JSON.parse(r.output) : undefined;
  } catch {
    /* text */
  }
  return { ...(typeof status === 'number' ? { status } : {}), body, text: r.output };
}

/** In-memory data of a recent run (the app keeps the last few): each step's variables and response as they were, unredacted. */
export type RunMemory = (runId: string) => Map<string, { vars?: Record<string, unknown>; response?: StepResponse }> | undefined;

/**
 * The seed of a run that starts after `before` steps of an earlier run: their variables (the last recorded set;
 * redacted or cut values are left to the environment), responses, conditions and branches not taken.
 */
export function seedFromResults(results: TestResult[], before: Set<string>, memory?: ReturnType<RunMemory>): RunSeed {
  const vars: Record<string, unknown> = {};
  const responses: Record<string, StepResponse> = {};
  const conditions: Record<string, boolean> = {};
  const branchSkipped: string[] = [];
  for (const r of results) {
    if (!before.has(r.id)) continue;
    const kept = memory?.get(r.id);
    for (const [k, v] of Object.entries(kept?.vars ?? r.variables ?? {})) if (!isPartialValue(v)) vars[k] = v;
    const resp = kept?.response ?? responseOfResult(r);
    if (resp) responses[r.id] = resp;
    if (r.type === 'condition' && r.status === 'passed' && typeof r.metadata?.condition === 'boolean') conditions[r.id] = r.metadata.condition;
    const reason = String(r.metadata?.reason ?? '');
    if (r.status === 'skipped' && /branch|^if: .* is false$/.test(reason)) branchSkipped.push(r.id);
  }
  return { vars, responses, conditions, branchSkipped };
}

/** What a partial run of a flow runs and starts from. */
export interface FlowRunPlan {
  file: string;
  /** The steps to run (by id); the others are taken from the seed run. Undefined: every step. */
  onlyIds?: string[];
  seed?: RunSeed;
  /** The step the run starts from (Run from here, replay). */
  from?: string;
  /** The run the seed came from. */
  seedRunId?: string;
  /** What the plan does, in a sentence (for the CLI and agents). */
  note: string;
}

/**
 * Plan a partial run of a flow file:
 * - `from`: that step and every step after it in the file, seeded with what the steps before it had in `seedRunId`
 *   (default: the latest run of the file);
 * - `to`: that step with the steps it waits for (and theirs), nothing seeded;
 * - `seedRunId` alone (replay): the run's data up to its first failing step, then that step and the rest.
 */
export async function flowRunPlan(store: WorkspaceStore, file: string, o: { from?: string; to?: string; seedRunId?: string; memory?: RunMemory }): Promise<FlowRunPlan> {
  const { abs, rel } = flowFile(store, file);
  const steps = await stepsOf(abs);
  if (o.to) {
    const target = stepRef(steps, o.to, 'Run to here');
    const byId = new Map(steps.map((s) => [s.id, s]));
    const keep = new Set<string>();
    const walk = (id: string) => {
      if (keep.has(id) || !byId.has(id)) return;
      keep.add(id);
      for (const d of byId.get(id)!.dependsOn) walk(d);
    };
    walk(target.id);
    const onlyIds = steps.filter((s) => keep.has(s.id)).map((s) => s.id);
    return { file: rel, onlyIds, note: `Runs ${target.id} with the ${onlyIds.length - 1} step${onlyIds.length === 2 ? '' : 's'} it waits for` };
  }
  if (!o.from && !o.seedRunId) return { file: rel, note: 'Runs every step' };
  let seedRunId = o.seedRunId;
  let results: TestResult[] = [];
  if (!seedRunId) {
    // the latest run that has every step before the start (a run from here itself has only the steps it ran)
    const before = new Set(
      steps
        .slice(
          0,
          steps.findIndex((s) => s.id === stepRef(steps, o.from!, 'Run from here').id),
        )
        .map((s) => s.id),
    );
    const runs = (await flowRuns(store, rel, { limit: 30 })).runs;
    if (!runs.length) throw new ApsError('ValidationError', `Run from here needs an earlier run of tests/${rel}: run the flow once first`);
    for (const r of runs) {
      const rs = (await flowRunResults(store, rel, r.runId)).results;
      if ([...before].every((id) => rs.some((x) => x.id === id))) {
        seedRunId = r.runId;
        results = rs;
        break;
      }
    }
    seedRunId ??= runs[0]!.runId;
  }
  if (!results.length) results = (await flowRunResults(store, rel, seedRunId)).results;
  if (!results.length) throw new ApsError('ValidationError', `Run ${seedRunId} did not include tests/${rel}`);
  let from: StepRef;
  if (o.from) from = stepRef(steps, o.from, 'Run from here');
  else {
    const bad = results.find((r) => r.status === 'failed' || r.status === 'error');
    if (!bad)
      throw new ApsError('ValidationError', `Nothing failed in run ${seedRunId}: give a step to start from (--from / from)`, {
        suggestions: ['Replay a run whose flow failed, or run from a step with its data.'],
      });
    from = stepRef(steps, bad.id, 'Replay');
  }
  const i = steps.findIndex((s) => s.id === from.id);
  const before = new Set(steps.slice(0, i).map((s) => s.id));
  const onlyIds = steps.slice(i).map((s) => s.id);
  const seed = seedFromResults(results, before, o.memory?.(seedRunId));
  return {
    file: rel,
    onlyIds,
    seed,
    from: from.id,
    seedRunId,
    note: `Runs ${from.id} and the ${onlyIds.length - 1} step${onlyIds.length === 2 ? '' : 's'} after it with the variables and responses of run ${seedRunId} (${Object.keys(seed.vars ?? {}).length} variables)`,
  };
}

/* ------------------------------------------------------------------ the designer's state: breakpoints and pins */

/** The flow designer's state of a file: kept per computer in `.local/flows/` (git-ignored), never in the YAML. */
export interface FlowDesignerState {
  breakpoints: string[];
  pins: Record<string, PinnedResponse>;
}

function stateFile(store: WorkspaceStore, rel: string): string {
  const hash = createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 10);
  return join(store.root, '.local', 'flows', `${rel.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}-${hash}.json`);
}

/** Breakpoints and pinned responses of a flow file (none when it has no state yet). */
export function readFlowState(store: WorkspaceStore, file: string): FlowDesignerState & { file: string } {
  const { rel } = flowFile(store, file);
  const f = stateFile(store, rel);
  let data: Partial<FlowDesignerState> = {};
  try {
    if (existsSync(f)) data = JSON.parse(readFileSync(f, 'utf8')) as Partial<FlowDesignerState>;
  } catch {
    data = {};
  }
  return {
    file: rel,
    breakpoints: Array.isArray(data.breakpoints) ? data.breakpoints.filter((x): x is string => typeof x === 'string') : [],
    pins: data.pins && typeof data.pins === 'object' && !Array.isArray(data.pins) ? data.pins : {},
  };
}

function writeFlowState(store: WorkspaceStore, rel: string, state: FlowDesignerState): void {
  const f = stateFile(store, rel);
  mkdirSync(join(store.root, '.local', 'flows'), { recursive: true });
  atomicWrite(f, JSON.stringify({ file: rel, ...state }, null, 2));
}

/** Set the breakpoints of a flow file (step ids). */
export function setFlowBreakpoints(store: WorkspaceStore, file: string, ids: string[]): FlowDesignerState & { file: string } {
  const s = readFlowState(store, file);
  const next = { breakpoints: [...new Set(ids.map(String))].slice(0, 500), pins: s.pins };
  writeFlowState(store, s.file, next);
  return { file: s.file, ...next };
}

/** Pin a response on a step (its body cut at 1 MB): runs from the designer answer the step with it. */
export function pinFlowStep(store: WorkspaceStore, file: string, stepId: string, response: StepResponse & { fromRunId?: string }): FlowDesignerState & { file: string } {
  const s = readFlowState(store, file);
  let text = response.text ?? (response.body === undefined ? undefined : typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  const truncated = (text?.length ?? 0) > PIN_BODY_LIMIT;
  if (truncated) text = text!.slice(0, PIN_BODY_LIMIT);
  const pin: PinnedResponse = {
    ...(response.status !== undefined ? { status: response.status } : {}),
    ...(response.headers ? { headers: response.headers.slice(0, 200) } : {}),
    ...(!truncated && response.body !== undefined && typeof response.body !== 'string' ? { body: response.body } : {}),
    ...(text !== undefined ? { text } : {}),
    pinnedAt: new Date().toISOString(),
    ...(response.fromRunId ? { fromRunId: response.fromRunId } : {}),
    ...(truncated ? { truncated } : {}),
  };
  const next = { breakpoints: s.breakpoints, pins: { ...s.pins, [stepId]: pin } };
  writeFlowState(store, s.file, next);
  return { file: s.file, ...next };
}

/** Remove a step's pin: it calls the API again. */
export function unpinFlowStep(store: WorkspaceStore, file: string, stepId: string): FlowDesignerState & { file: string } {
  const s = readFlowState(store, file);
  const pins = { ...s.pins };
  delete pins[stepId];
  const next = { breakpoints: s.breakpoints, pins };
  writeFlowState(store, s.file, next);
  return { file: s.file, ...next };
}

/**
 * A step's latest response as stored: from its trace (status, headers and up to 16 KB of the body) when the run kept
 * one, else its result (status and the output summary). Undefined when no run of the file has the step.
 */
export async function storedStepResponse(store: WorkspaceStore, file: string, stepId: string, runId?: string): Promise<(StepResponse & { fromRunId: string }) | undefined> {
  const id = runId ?? (await flowRuns(store, file, { limit: 1 })).runs[0]?.runId;
  if (!id) return undefined;
  const r = (await flowRunResults(store, file, id)).results.find((x) => x.id === stepId);
  if (!r || r.status === 'skipped') return undefined;
  const trace: Trace | undefined = r.traceId ? store.loadTrace(r.traceId) : undefined;
  const http = trace?.spans.find((s) => s.kind === 'http' && s.output && typeof s.output === 'object');
  if (http) {
    const out = http.output as { status?: number; headers?: Array<[string, string]>; body?: unknown };
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: out.status, headers: out.headers, body, text, fromRunId: id };
  }
  const resp = responseOfResult(r);
  return resp ? { ...resp, fromRunId: id } : undefined;
}
