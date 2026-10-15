/**
 * A flow at scale: one run of a flow file with given variables (`runFlowOnce`, its own variables and cookies, the
 * steps' results, what it extracted and its `output:`), and a data-driven run (`runFlowData`): the flow once per row of
 * a dataset (CSV, JSON, JSONL, SQLite, PostgreSQL / MySQL, or the file's own `data:`), each row's fields as variables
 * with `$row` (the record) and `$index` (0-based), rows `concurrency` at a time, `bail` stopping at the first failing
 * row, the signal cancelling. Host-agnostic: the CLI, the MCP server and the app give it their engine services.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { parseYaml } from '../util/lazy-yaml.js';
import type { TestCase, TestResult } from '../model/types.js';
import { ApsError, normalizeError } from '../errors.js';
import { CookieJar } from '../cookies/cookie-jar.js';
import { REDACTED, type Redactor } from '../util/redact.js';
import type { ExecServices } from './execute.js';
import { runTests } from './runner.js';
import { loadTestsFromFile } from './loader.js';
import { readFlowOutput, resolveOutput } from './flow-blocks.js';
import { boundValue } from './debug-hooks.js';
import { readDataset, type DatasetRecord, type DatasetSource } from './datasets.js';
import { flowRunStatus, type FlowRunStatus } from '@testpion/shared';
import { dbKindOf } from './db-datasets.js';

/** The most steps a flow file run at scale may have. */
export const MAX_FLOW_STEPS = 1000;
/** The most rows a data-driven run reads (a `limit` may lower it). */
export const MAX_DATA_ROWS = 100_000;
/** Full step results are kept for failing rows (up to this many) … */
export const KEEP_FAILED_ROW_STEPS = 1000;
/** The failing rows a run's result lists (all rows go to `onRow`). */
export const LISTED_FAILED_ROWS = 100;
/** … and for the first passing rows. */
export const KEEP_PASSED_ROW_STEPS = 100;

// how a run went (skipped when nothing ran), the same in the engine, the CLI, the MCP tools and the window
export { flowRunStatus, scaleRunStatus, type FlowRunStatus } from '@testpion/shared';

/** One run of a flow file. */
export interface FlowIterationResult {
  status: FlowRunStatus;
  durationMs: number;
  /** The steps' results (redacted), in file order. */
  steps: TestResult[];
  /** The first step (file order) that failed or errored. */
  failedStep?: string;
  /** Why it failed: that step's error, else its first failing check. */
  error?: string;
  /** What the flow extracted or set (runtime variables, minus the inputs), redacted and bounded. */
  extracted: Record<string, unknown>;
  /** The file's `output:`, resolved after the run (redacted and bounded); undefined when it declares none. */
  output?: Record<string, unknown>;
}

/** A flow file's steps, read once (a run at scale runs them many times). */
export async function loadFlowSteps(file: string): Promise<TestCase[]> {
  if (!existsSync(file)) throw new ApsError('ConfigurationError', `No such test file: ${file}`);
  const out: TestCase[] = [];
  for await (const t of loadTestsFromFile(file)) {
    out.push(t);
    if (out.length > MAX_FLOW_STEPS) throw new ApsError('ValidationError', `A flow run at scale has at most ${MAX_FLOW_STEPS} steps`);
  }
  if (!out.length) throw new ApsError('ValidationError', `${file} has no steps to run`);
  return out;
}

/** A value as results keep it: secrets masked, long values cut. */
export function shownValue(key: string, v: unknown, redactor: Redactor): unknown {
  return redactor.isSensitiveKey(key) ? REDACTED : redactor.redact(boundValue(v));
}

const firstProblem = (r: TestResult): string | undefined => r.error?.message ?? r.checks.find((c) => !c.passed)?.message ?? (r.metadata?.reason as string | undefined);

/**
 * Run a flow file once with `inputs` as variables (on a copy of the services' variables, with a cookie jar of its
 * own, never persisting what Set variable writes). `tests` are the file's steps when already read.
 */
export async function runFlowOnce(o: {
  file: string;
  services: ExecServices;
  tests?: TestCase[];
  /** The file's `output:` when already read (null: it has none); read from the file otherwise. */
  output?: Record<string, unknown> | null;
  inputs?: Record<string, unknown>;
  signal?: AbortSignal;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  cookieJar?: CookieJar;
  name?: string;
  runId?: string;
  environment?: string;
  /** Keep the steps' traces (the app's run detail): passed to runTests with its trace mode. */
  traceMode?: 'all' | 'failures' | 'none';
  onTrace?: Parameters<typeof runTests>[0]['onTrace'];
}): Promise<FlowIterationResult> {
  const tests = o.tests ?? (await loadFlowSteps(o.file));
  const vars = o.services.vars.clone();
  const inputs = o.inputs ?? {};
  for (const [k, v] of Object.entries(inputs)) vars.set(k, v, 'runtime');
  const before = vars.scopeValues('runtime');
  const services: ExecServices = { ...o.services, vars, cookieJar: o.cookieJar ?? new CookieJar(), persistVariable: undefined, pinned: undefined };
  const got = new Map<string, TestResult>();
  const summary = await runTests({
    name: o.name ?? o.file,
    ...(o.runId ? { runId: o.runId } : {}),
    tests,
    services,
    concurrency: o.concurrency ?? 4,
    retries: o.retries,
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    traceMode: o.traceMode ?? 'none',
    onTrace: o.onTrace,
    environment: o.environment,
    onEvent: (e) => void (e.type === 'test-end' && got.set(e.result.id, e.result)),
  });
  const steps: TestResult[] = [];
  for (const t of tests) {
    const r = got.get(t.id ?? t.name);
    if (r) steps.push(r);
  }
  const bad = steps.find((r) => r.status === 'failed' || r.status === 'error');
  const redactor = o.services.redactor;
  const extracted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars.scopeValues('runtime'))) if (!(k in inputs) && (!(k in before) || before[k] !== v)) extracted[k] = shownValue(k, v, redactor);
  const declared = o.output === undefined ? readFlowOutput(o.file) : (o.output ?? undefined);
  let output: Record<string, unknown> | undefined;
  if (declared) output = Object.fromEntries(Object.entries(resolveOutput(declared, vars)).map(([k, v]) => [k, shownValue(k, v, redactor)]));
  return {
    status: flowRunStatus(steps, summary.cancelled),
    durationMs: summary.durationMs,
    steps,
    ...(bad ? { failedStep: bad.id, error: firstProblem(bad) } : {}),
    extracted,
    ...(output ? { output } : {}),
  };
}

/* ------------------------------------------------------------------ data-driven runs */

/** The rows of a data-driven run as a test file may give them in its header: a path, a dataset block or the records. */
export type FlowDataSpec = string | DatasetRecord[] | DatasetSource;

/** The `data:` of a test file's header (undefined when it has none). */
export function readFlowDataHeader(file: string): FlowDataSpec | undefined {
  let doc: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    doc = extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch {
    return undefined;
  }
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).data : undefined;
  if (typeof d === 'string' && d.trim()) return d.trim();
  if (Array.isArray(d)) return d.filter((r): r is DatasetRecord => !!r && typeof r === 'object' && !Array.isArray(r));
  if (d && typeof d === 'object') return d as DatasetSource;
  return undefined;
}

/**
 * Where a data file named in a flow or on the command line is: absolute; a database URL or `env:NAME` as it is; else
 * the first that exists of: next to the flow file, each of `roots` (the workspace, its tests/, the current folder).
 */
export function resolveDataPath(ref: string, o: { file?: string; roots?: string[] } = {}): string {
  if (dbKindOf(ref) || /^env:[A-Za-z_]\w*$/.test(ref) || isAbsolute(ref)) return ref;
  const candidates = [...(o.file ? [resolve(dirname(o.file), ref)] : []), ...(o.roots ?? []).map((r) => resolve(r, ref))];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new ApsError('ConfigurationError', `No such data file: ${ref}`, { why: `Looked in ${candidates.join(', ') || 'the current folder'}.` });
  return hit;
}

/** A dataset source from a spec (path, records or block): paths resolved, `query` / `limit` applied. */
export function flowDataSource(spec: FlowDataSpec, o: { file?: string; roots?: string[]; query?: string; limit?: number } = {}): DatasetSource {
  let src: DatasetSource;
  if (typeof spec === 'string') src = { path: resolveDataPath(spec, o) };
  else if (Array.isArray(spec)) src = { records: spec };
  else src = { ...spec, ...(spec.path ? { path: resolveDataPath(spec.path, o) } : {}) };
  if (o.query) src.query = o.query;
  if (o.limit !== undefined) src.limit = o.limit;
  return src;
}

/** A short label of where the rows came from (for lists and reports; database passwords hidden). */
export function dataLabel(src: DatasetSource): string {
  if (src.records) return `${src.records.length} inline rows`;
  const p = src.connectionEnv ? `env:${src.connectionEnv}` : (src.connection ?? src.path ?? src.url ?? '');
  const shown = dbKindOf(p) ? p.replace(/(\/\/[^:/@]+:)[^@]+@/, '$1***@') : p.replace(/\\/g, '/').split('/').slice(-2).join('/');
  return src.query ? `${shown} (${src.query.slice(0, 60)})` : shown;
}

/** One row of a data-driven run. */
export interface DataRowResult {
  index: number;
  status: FlowRunStatus;
  durationMs: number;
  startedAt: string;
  /** The row's values (secrets masked, long values cut). */
  values: Record<string, unknown>;
  failedStep?: string;
  failedStepName?: string;
  error?: string;
  /** Each step: id, status, ms. */
  steps: Array<{ id: string; status: string; ms: number }>;
  /** Whether the full step results were kept (every failing row, the first passing ones). */
  detail?: boolean;
}

export interface FlowDataRunResult {
  file: string;
  source: string;
  startedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  cancelled: number;
  /** Rows where nothing ran (every step skipped). A run whose rows all skipped did not pass. */
  skipped: number;
  /** Stopped at the first failing row (bail). */
  bailed: boolean;
  /** Cancelled by the caller. */
  stopped: boolean;
  /** More rows than the run reads (MAX_DATA_ROWS or the limit). */
  truncated: boolean;
  /** Reading the data failed part-way (the rows read before it ran). */
  dataError?: string;
  concurrency: number;
  columns: string[];
  steps: Array<{ id: string; name: string }>;
  /** The first failing rows (LISTED_FAILED_ROWS); every row went to `onRow` as it finished (the result never holds them all). */
  failedRows: DataRowResult[];
  /** The slowest row's time and the average. */
  slowestRowMs: number;
  averageRowMs: number;
}

export interface FlowDataRunOptions {
  /** The flow file (absolute). */
  file: string;
  /** The rows: a source (readDataset), or records. */
  data: DatasetSource;
  services: ExecServices;
  /** Rows run at once (1–32, default 1). */
  concurrency?: number;
  /** Steps of one row run at once (default 4, like a run). */
  stepConcurrency?: number;
  retries?: number;
  timeoutMs?: number;
  /** Stop at the first failing row (rows already running are cancelled). */
  bail?: boolean;
  signal?: AbortSignal;
  environment?: string;
  /** Each row as it finishes (in finishing order), with its full step results when they are kept (failing rows up to KEEP_FAILED_ROW_STEPS, the first KEEP_PASSED_ROW_STEPS passing ones). */
  onRow?(row: DataRowResult, steps?: TestResult[]): void;
  traceMode?: 'all' | 'failures' | 'none';
  onTrace?: Parameters<typeof runTests>[0]['onTrace'];
}

/** Run a flow file once per row of a dataset. */
export async function runFlowData(o: FlowDataRunOptions): Promise<FlowDataRunResult> {
  const tests = await loadFlowSteps(o.file);
  const output = readFlowOutput(o.file) ?? null;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (o.signal?.aborted) ctrl.abort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });
  const concurrency = Math.min(32, Math.max(1, Math.floor(o.concurrency ?? 1)));
  const max = Math.min(MAX_DATA_ROWS, o.data.limit ?? MAX_DATA_ROWS);
  const it = readDataset({ ...o.data, limit: max + 1 })[Symbol.asyncIterator]();
  const redactor = o.services.redactor;
  // bounded memory: counts, the first failing rows and the columns; every row goes to onRow
  const counts = { passed: 0, failed: 0, cancelled: 0, skipped: 0 };
  const failedRows: DataRowResult[] = [];
  let slowest = 0;
  let totalMs = 0;
  const columns = new Set<string>();
  let next = 0;
  let bailed = false;
  let truncated = false;
  let dataError: unknown;
  let keptFailed = 0;
  let keptPassed = 0;

  const worker = async () => {
    for (;;) {
      if (ctrl.signal.aborted) return;
      let n: IteratorResult<DatasetRecord>;
      try {
        n = await it.next();
      } catch (e) {
        dataError ??= e;
        ctrl.abort();
        return;
      }
      if (n.done) return;
      const index = next++;
      if (index >= max) {
        truncated = true;
        return;
      }
      const rec = n.value && typeof n.value === 'object' && !Array.isArray(n.value) ? n.value : { value: n.value };
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec).slice(0, 100)) {
        if (columns.size < 100) columns.add(k);
        values[k] = shownValue(k, v, redactor);
      }
      const started = new Date().toISOString();
      let r: FlowIterationResult;
      try {
        r = await runFlowOnce({
          file: o.file,
          tests,
          output,
          services: o.services,
          inputs: { ...rec, $row: rec, $index: index },

          signal: ctrl.signal,
          concurrency: o.stepConcurrency,
          retries: o.retries,
          timeoutMs: o.timeoutMs,
          name: `row ${index}`,
          environment: o.environment,
          traceMode: o.traceMode,
          onTrace: o.onTrace,
        });
      } catch (e) {
        const err = normalizeError(e);
        r = { status: 'failed', durationMs: 0, steps: [], error: `${err.kind}: ${err.message}`, extracted: {} };
      }
      const failedName = r.failedStep ? tests.find((t) => (t.id ?? t.name) === r.failedStep)?.name : undefined;
      const keep = r.status === 'failed' ? keptFailed++ < KEEP_FAILED_ROW_STEPS : r.status === 'passed' && keptPassed++ < KEEP_PASSED_ROW_STEPS;
      const row: DataRowResult = {
        index,
        status: r.status,
        durationMs: r.durationMs,
        startedAt: started,
        values,
        ...(r.failedStep ? { failedStep: r.failedStep, ...(failedName ? { failedStepName: failedName } : {}) } : {}),
        ...(r.error ? { error: r.error.slice(0, 500) } : {}),
        steps: r.steps.map((s) => ({ id: s.id, status: s.status, ms: Math.round(s.latencyMs ?? s.durationMs) })),
        ...(keep && r.steps.length ? { detail: true } : {}),
      };
      counts[row.status]++;
      slowest = Math.max(slowest, row.durationMs);
      totalMs += row.durationMs;
      if (row.status === 'failed' && failedRows.length < LISTED_FAILED_ROWS) failedRows.push(row);
      try {
        o.onRow?.(row, keep && r.steps.length ? r.steps : undefined);
      } catch {
        /* listeners must not break the run */
      }
      if (o.bail && r.status === 'failed' && !ctrl.signal.aborted) {
        bailed = true;
        ctrl.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    await it.return?.(undefined).catch(() => undefined);
  }
  const total = counts.passed + counts.failed + counts.cancelled + counts.skipped;
  if (dataError && !total)
    throw new ApsError('ConfigurationError', `Could not read the data (${dataLabel(o.data)}): ${normalizeError(dataError).message}`, {
      suggestions: ['Check the file: CSV with a header row, a JSON array of objects, or JSON lines; a database needs a SELECT query.'],
    });
  failedRows.sort((a, b) => a.index - b.index);
  return {
    file: o.file,
    source: dataLabel(o.data),
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    total,
    passed: counts.passed,
    failed: counts.failed,
    cancelled: counts.cancelled,
    skipped: counts.skipped,
    bailed,
    stopped: !!o.signal?.aborted,
    truncated,
    ...(dataError ? { dataError: normalizeError(dataError).message } : {}),
    concurrency,
    columns: [...columns],
    steps: tests.map((t) => ({ id: t.id ?? t.name, name: t.name })),
    failedRows,
    slowestRowMs: slowest,
    averageRowMs: total ? Math.round(totalMs / total) : 0,
  };
}
