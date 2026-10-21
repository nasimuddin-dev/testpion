/**
 * The evidence of a failed run, gathered without a model (AI-2): its failures grouped deterministically — the same failed
 * check (or error kind), the same status and the same endpoint (host and path, ids as {id}) — so 500 failures from one
 * expired token become a few groups, each with up to two representatives that carry the evidence: the step and where it
 * comes from (refs), the request line, the response (status, headers, body from the trace or the result), the checks
 * that failed with expected and actual, the source's check configs that failed, unresolved variables, the error, and
 * the same test's last passing run — its response and what changed since (status, headers, body paths) — plus how often
 * its result flipped. A model sees the groups, never the 500 failures; the CLI's `--triage` and agents use the groups as
 * they are when no model is set up.
 */
import { join } from 'node:path';
import { checkSubject, diffResponses, toItemRef, type BodyChange, type ItemRef } from '@testpion/shared';
import type { CheckConfig, CheckResult, RunSummary, TestResult } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { readResultsFile } from '../runner/runner.js';
import { runResults } from '../runner/run-results.js';
import { finishedRun, latestFinishedRun, requestIdOfResult, resultSourceRefs, testsPathOf } from '../runner/result-source.js';
import { parseYaml } from '../util/lazy-yaml.js';
import { slugify } from '../util/ids.js';
import type { StoredResponse } from './verify.js';

/** What a group of failures probably is, said without a model (a model may say otherwise, with its reasons). */
export type TriageCause = 'api-regression' | 'stale-test' | 'auth' | 'environment' | 'test-data' | 'flaky' | 'timing' | 'unknown';
export const TRIAGE_CAUSES: readonly TriageCause[] = ['api-regression', 'stale-test', 'auth', 'environment', 'test-data', 'flaky', 'timing', 'unknown'];

/** Where a failing step is defined: a saved request (its checks and script) or a step of a test file. */
export type FailureSource =
  { key: string; kind: 'request'; collectionId: string; requestId: string; name: string; assertions: CheckConfig[]; testScript?: string } | { key: string; kind: 'test'; path: string; text: string };

export interface FailureEvidence {
  resultId: string;
  name: string;
  status: 'failed' | 'error';
  type: string;
  /** Where it is defined (a saved request, a test file at its step) and the result in the run. */
  refs: ItemRef[];
  source?: string;
  /** The step's id in its test file (a test-file source). */
  step?: string;
  request?: { method?: string; url?: string };
  response?: StoredResponse;
  /** The body was stored whole (a check can be evaluated against it). */
  complete: boolean;
  failedChecks: Array<{ type: string; name: string; message: string; expected?: unknown; actual?: unknown }>;
  /** The source's own checks that failed, by their place in its list. */
  failedAssertions: Array<{ index: number; check: CheckConfig }>;
  error?: { kind: string; message: string };
  unresolvedVariables?: string[];
  latencyMs?: number;
  attempts?: number;
}

interface LastPassing {
  runId: string;
  startedAt: string;
  response?: StoredResponse;
  complete: boolean;
  /** What changed from that response to the failing one. */
  changed?: {
    status?: { before?: number | string; after?: number | string };
    headers: Array<{ name: string; kind: string; before?: string; after?: string }>;
    body: BodyChange[];
    /** Headers were not compared: this run's result (usually the passing one) did not store them. */
    headersNotStored?: 'passing' | 'failing' | 'both';
    identical: boolean;
  };
}

export interface FailureGroup {
  id: string;
  key: string;
  /** For people: `equals $.status · 200 · GET 127.0.0.1:4010/health`. */
  signature: string;
  endpoint?: string;
  hint: TriageCause;
  count: number;
  /** The failing results (at most MAX_IDS). */
  resultIds: string[];
  samples: FailureEvidence[];
  /** The first sample's last passing run, when the test ever passed before this run. */
  lastPassing?: LastPassing;
  /** The first sample across the runs before: results (newest last) and how often it flipped. */
  history?: { recent: string[]; flips: number };
}

export interface RunEvidence {
  runId: string;
  run: { name: string; startedAt: string; environment?: string; total: number; passed: number; failed: number; errors: number; origin?: RunSummary['origin'] };
  failures: number;
  groups: FailureGroup[];
  /** Groups beyond MAX_GROUPS (and their failures): counted, not detailed. */
  omitted: { groups: number; failures: number };
  sources: Record<string, FailureSource>;
}

const MAX_GROUPS = 40;
const MAX_IDS = 2000;
const SAMPLES = 2;
const HISTORY_RUNS = 60;

/** A run by id, or 'last': the newest finished run that has failures (by `latestFinishedRun`'s rules: summarised, not cancelled). */
function failedRunSummary(store: WorkspaceStore, runId: string): RunSummary {
  if (runId === 'last') {
    const s = latestFinishedRun(store, (x) => x.failed + x.errors > 0);
    if (!s)
      throw new ApsError('ValidationError', store.meta.listRuns({ limit: 1 }).items.length ? 'No finished run has failures' : 'There are no runs yet', {
        suggestions: ['Run tests first (testpion test, testpion run-collection); the app\'s Runs list shows the runs.'],
      });
    return s;
  }
  return finishedRun(store, runId);
}

/** `GET 127.0.0.1:4010/orders/{id}`: method, host and path with ids, numbers and hashes as {id}; no query. */
export function endpointTemplate(method: string | undefined, url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)([^?#]*)/i.exec(url.trim());
  const host = m?.[1] ?? '';
  const path = (m?.[2] ?? '')
    .split('/')
    .map((s) => (/^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i.test(s) ? '{id}' : s))
    .join('/');
  return `${(method ?? '').toUpperCase()} ${host}${path || '/'}`.trim();
}

/** A check result's name as its config makes it (runChecks): `equals $.status`, or the config's own name. */
const checkNameOf = (c: CheckConfig): string => (typeof c.name === 'string' && c.name ? c.name : [c.type, checkSubject(c)].filter(Boolean).join(' '));

const TRUNCATED = /… \[\d+ more chars\]$/;

/** The response a result stored: from its trace (status, headers, a body up to 16 KB) or its summary (a body up to 4 KB). */
export function responseOfResult(store: WorkspaceStore, r: TestResult): { response?: StoredResponse; complete: boolean } {
  const meta = (r.metadata ?? {}) as { status?: unknown };
  let status = typeof meta.status === 'number' ? meta.status : undefined;
  let headers: Array<[string, string]> | undefined;
  let body = typeof r.output === 'string' ? r.output : undefined;
  if (r.traceId)
    try {
      const t = store.loadTrace(r.traceId);
      for (const s of t?.spans ?? []) {
        const o = s.output as { status?: unknown; headers?: unknown; body?: unknown } | undefined;
        if (o && typeof o === 'object' && typeof o.status === 'number' && 'body' in o) {
          status = o.status;
          if (Array.isArray(o.headers)) headers = (o.headers as unknown[]).filter((h): h is [string, string] => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)]);
          if (typeof o.body === 'string') body = o.body;
          break;
        }
      }
    } catch {
      /* a trace that is gone: the result's own summary */
    }
  if (status === undefined && body === undefined) return { complete: false };
  const complete = body !== undefined && !TRUNCATED.test(body);
  return { response: { status, headers, body: complete ? body : undefined, latencyMs: r.latencyMs }, complete };
}

/** `POST https://…` from a result's input. */
export function requestOfResult(r: TestResult): FailureEvidence['request'] {
  const meta = (r.metadata ?? {}) as { method?: unknown; url?: unknown };
  if (typeof meta.url === 'string') return { method: typeof meta.method === 'string' ? meta.method : undefined, url: meta.url };
  const m = /^([A-Z]+)\s+(\S+)/.exec(r.input ?? '');
  return m ? { method: m[1], url: m[2] } : undefined;
}

/** The deterministic guess (see TriageCause). */
function hintOf(e: FailureEvidence, flips: number): TriageCause {
  const st = e.response?.status;
  if (e.error && /Authentication|Authorization/.test(e.error.kind)) return 'auth';
  if (st === 401 || st === 403) return 'auth';
  if (e.unresolvedVariables?.length) return 'environment';
  if (e.error && /Network|Timeout|Tls|Dns|Connection/i.test(e.error.kind)) return 'environment';
  if (st === 502 || st === 503 || st === 504) return 'environment';
  if (flips >= 2) return 'flaky';
  if (e.failedChecks.some((c) => /latency|response-time|duration/i.test(c.type))) return 'timing';
  if (typeof st === 'number' && st >= 500) return 'api-regression';
  return 'unknown';
}

/** The source of a result (a saved request of a collection run, or a test file), read once per run. */
export function sourceOfResult(store: WorkspaceStore, r: TestResult, origin: RunSummary['origin'], cache: Record<string, FailureSource | null> = {}): FailureSource | undefined {
  if (origin?.kind === 'collection') {
    const requestId = requestIdOfResult(r.id);
    const key = `request:${origin.collectionId}:${requestId}`;
    if (!(key in cache)) {
      cache[key] = null;
      try {
        const c = store.getCollection(origin.collectionId);
        const find = (items: typeof c.items): (typeof c.items)[number] | undefined => {
          for (const n of items) {
            if (n.id === requestId) return n;
            if (n.kind === 'folder') {
              const f = find(n.items);
              if (f) return f;
            }
          }
          return undefined;
        };
        const n = find(c.items);
        if (n && n.kind !== 'folder') cache[key] = { key, kind: 'request', collectionId: c.id, requestId, name: n.name, assertions: n.assertions ?? [], testScript: n.testScript };
      } catch {
        /* a collection that is gone */
      }
    }
    return cache[key] ?? undefined;
  }
  const path = testsPathOf(store, r.file);
  if (!path) return undefined;
  const key = `test:${path}`;
  if (!(key in cache)) {
    cache[key] = null;
    try {
      cache[key] = { key, kind: 'test', path, text: store.readTestFile(path) };
    } catch {
      /* a file that is gone */
    }
  }
  return cache[key] ?? undefined;
}

/** A step of a test file: its id or name as the result names it (an explicit id, or <file>:<name> as the loader makes it). */
export function stepOfResult(text: string, path: string, r: { id: string; name: string }): { ref: string; step: Record<string, unknown> } | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return undefined;
  }
  const steps = (Array.isArray(doc) ? doc : Array.isArray((doc as { tests?: unknown })?.tests) ? (doc as { tests: unknown[] }).tests : doc && typeof doc === 'object' ? [doc] : []) as Array<
    Record<string, unknown>
  >;
  const fileSlug = slugify(
    path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, ''),
  );
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name ?? '');
    const id = s.id !== undefined ? String(s.id) : `${fileSlug}:${slugify(name)}`;
    if (id === r.id || name === r.name) return { ref: s.id !== undefined ? String(s.id) : name, step: s };
  }
  return undefined;
}

/** The source's checks that failed: matched to the failed results by type and the name runChecks gives them. */
function failedAssertionsOf(configs: CheckConfig[], failed: CheckResult[]): Array<{ index: number; check: CheckConfig }> {
  const out: Array<{ index: number; check: CheckConfig }> = [];
  const used = new Set<number>();
  for (const f of failed) {
    const i = configs.findIndex((c, k) => !used.has(k) && c && typeof c === 'object' && (c.type === f.type || (c.type === 'http-status' && f.type === 'status')) && checkNameOf(c) === f.name);
    if (i >= 0) {
      used.add(i);
      out.push({ index: i, check: configs[i]! });
    }
  }
  return out;
}

export function evidenceOf(store: WorkspaceStore, runId: string, r: TestResult, origin: RunSummary['origin'], cache: Record<string, FailureSource | null>): FailureEvidence {
  const { response, complete } = responseOfResult(store, r);
  const failed = (r.checks ?? []).filter((c) => !c.passed);
  const src = sourceOfResult(store, r, origin, cache);
  let configs: CheckConfig[] = [];
  let step: string | undefined;
  if (src?.kind === 'request') configs = src.assertions;
  else if (src?.kind === 'test') {
    const s = stepOfResult(src.text, src.path, r);
    if (s) {
      step = s.ref;
      configs = (Array.isArray(s.step.assertions) ? s.step.assertions : Array.isArray(s.step.checks) ? s.step.checks : []) as CheckConfig[];
    }
  }
  const meta = (r.metadata ?? {}) as { unresolvedVariables?: unknown };
  return {
    resultId: r.id,
    name: r.name,
    status: r.status === 'error' ? 'error' : 'failed',
    type: r.type,
    refs: [{ kind: 'run', runId, resultId: r.id }, ...resultSourceRefs(store, r, origin)],
    ...(src ? { source: src.key } : {}),
    ...(step ? { step } : {}),
    request: requestOfResult(r),
    ...(response ? { response } : {}),
    complete,
    failedChecks: failed
      .slice(0, 8)
      .map((c) => ({ type: c.type, name: c.name, message: c.message, ...(c.expected !== undefined ? { expected: c.expected } : {}), ...(c.actual !== undefined ? { actual: c.actual } : {}) })),
    failedAssertions: failedAssertionsOf(configs, failed),
    ...(r.error ? { error: { kind: r.error.kind, message: r.error.message } } : {}),
    ...(Array.isArray(meta.unresolvedVariables) && meta.unresolvedVariables.length ? { unresolvedVariables: meta.unresolvedVariables.map(String).slice(0, 20) } : {}),
    ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
    ...(r.attempts > 1 ? { attempts: r.attempts } : {}),
  };
}

/** The grouping key and its words (see the module comment). */
function keyOf(r: TestResult): { key: string; signature: string; endpoint?: string } {
  const req = requestOfResult(r);
  const endpoint = endpointTemplate(req?.method, req?.url);
  const status = (r.metadata as { status?: unknown } | undefined)?.status;
  if (r.status === 'error' || (r.error && !(r.checks ?? []).some((c) => !c.passed))) {
    const kind = r.error?.kind ?? 'Error';
    return { key: `error|${kind}|${endpoint ?? r.type}`, signature: [kind, endpoint].filter(Boolean).join(' · '), endpoint };
  }
  const c = (r.checks ?? []).find((x) => !x.passed);
  const check = c ? `${c.type}|${c.name}` : 'failed';
  return { key: `check|${check}|${status ?? ''}|${endpoint ?? r.type}`, signature: [c ? c.name : 'failed', status, endpoint].filter((x) => x !== undefined && x !== '').join(' · '), endpoint };
}

/**
 * One pass over the runs before `before` (newest first): for each wanted test, its results (newest last, for flips) and
 * its last passing result with the response it stored.
 */
async function earlierResults(store: WorkspaceStore, ids: Set<string>, before: { runId: string; startedAt: string }) {
  const statuses = new Map<string, string[]>();
  const passing = new Map<string, { runId: string; startedAt: string; result: TestResult }>();
  if (!ids.size) return { statuses, passing };
  const runs = store.meta.listRuns({ limit: HISTORY_RUNS + 1 }).items.filter((x) => x.id !== before.runId && x.startedAt <= before.startedAt);
  for (const run of runs) {
    const seen = new Set<string>();
    for await (const r of await readResultsFile(join(store.runDir(run.id), 'results.jsonl'))) {
      if (!ids.has(r.id) || seen.has(r.id) || r.status === 'skipped') continue;
      seen.add(r.id);
      const list = statuses.get(r.id) ?? [];
      if (list.length < 20) list.unshift(r.status === 'passed' ? 'passed' : 'failed');
      statuses.set(r.id, list);
      if (r.status === 'passed' && !passing.has(r.id)) passing.set(r.id, { runId: run.id, startedAt: run.startedAt, result: r });
    }
    if (passing.size === ids.size && [...statuses.values()].every((l) => l.length >= 20)) break;
  }
  return { statuses, passing };
}

/** Gather a failed run's evidence (see the module comment). Nothing is sent anywhere. */
export async function runEvidence(store: WorkspaceStore, runId: string): Promise<RunEvidence> {
  const summary = failedRunSummary(store, runId);
  const id = summary.runId;
  const origin = summary.origin;
  const groups = new Map<string, FailureGroup & { first: TestResult[] }>();
  let failures = 0;
  for await (const r of runResults(store, id)) {
    if (r.status !== 'failed' && r.status !== 'error') continue;
    failures++;
    const k = keyOf(r);
    let g = groups.get(k.key);
    if (!g) groups.set(k.key, (g = { id: '', key: k.key, signature: k.signature, endpoint: k.endpoint, hint: 'unknown', count: 0, resultIds: [], samples: [], first: [] }));
    g.count++;
    if (g.resultIds.length < MAX_IDS) g.resultIds.push(r.id);
    // representatives: the first, then one from another test (a different step or request)
    if (g.first.length < SAMPLES && !g.first.some((x) => requestIdOfResult(x.id) === requestIdOfResult(r.id))) g.first.push(r);
  }
  if (!failures) throw new ApsError('ValidationError', `Run ${id} has no failures to triage`, { suggestions: ['Pick a run with failed or errored results (the app\'s Runs list shows them; --run last picks the newest).'] });
  const ordered = [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const shown = ordered.slice(0, MAX_GROUPS);
  const cache: Record<string, FailureSource | null> = {};
  for (const g of shown) g.samples = g.first.map((r) => evidenceOf(store, id, r, origin, cache));
  // the representatives' earlier results: one pass over the runs before this one
  const wanted = new Set(shown.flatMap((g) => g.samples.map((s) => s.resultId)));
  const { statuses, passing } = await earlierResults(store, wanted, { runId: id, startedAt: summary.startedAt });
  const out: FailureGroup[] = shown.map((g, i) => {
    const s = g.samples[0]!;
    const recent = [...(statuses.get(s.resultId) ?? []), 'failed'];
    let flips = 0;
    for (let k = 1; k < recent.length; k++) if (recent[k] !== recent[k - 1]) flips++;
    const p = passing.get(s.resultId);
    let lastPassing: LastPassing | undefined;
    if (p) {
      const before = responseOfResult(store, p.result);
      // only what both results stored is compared: a passing result usually keeps no headers (its trace is not
      // kept), and a missing side would make every header (or body field) look "added since the last pass"
      const a = before.response;
      const b = s.response;
      const headersNotStored = a && b && (!a.headers || !b.headers) ? (!a.headers && !b.headers ? 'both' : !a.headers ? 'passing' : 'failing') : undefined;
      const bodies = a?.body !== undefined && b?.body !== undefined;
      const statuses = a?.status !== undefined && b?.status !== undefined;
      const comparable = (r: StoredResponse) => ({ status: statuses ? r.status : undefined, headers: headersNotStored ? [] : r.headers, body: bodies ? r.body : undefined });
      const d = a && b ? diffResponses(comparable(a), comparable(b), { maxChanges: 12, maxLines: 12 }) : undefined;
      lastPassing = {
        runId: p.runId,
        startedAt: p.startedAt,
        ...(before.response ? { response: before.response } : {}),
        complete: before.complete,
        ...(d
          ? {
              changed: {
                ...(d.status.changed ? { status: { before: d.status.before, after: d.status.after } } : {}),
                headers: d.headers
                  .filter((h) => !h.volatile)
                  .slice(0, 6)
                  .map((h) => ({ name: h.name, kind: h.kind, before: h.before, after: h.after })),
                body: d.body.changes.slice(0, 12),
                ...(headersNotStored ? { headersNotStored } : {}),
                identical: !d.status.changed && d.body.identical && !d.headers.some((h) => !h.volatile),
              },
            }
          : {}),
      };
    }
    const { first: _first, ...rest } = g;
    return { ...rest, id: `g${i + 1}`, hint: hintOf(s, flips), ...(lastPassing ? { lastPassing } : {}), history: { recent: recent.slice(-20), flips } };
  });
  const omitted = ordered.slice(MAX_GROUPS);
  return {
    runId: id,
    run: {
      name: summary.name,
      startedAt: summary.startedAt,
      environment: summary.environment,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      ...(origin ? { origin } : {}),
    },
    failures,
    groups: out,
    omitted: { groups: omitted.length, failures: omitted.reduce((n, g) => n + g.count, 0) },
    sources: Object.fromEntries(Object.entries(cache).filter((e): e is [string, FailureSource] => !!e[1])),
  };
}

/** The run a ref names (run:<id> or run:last), for the task's `prepare`. */
export function runIdOfRef(item: ItemRef | unknown): string {
  const r = toItemRef(item) as ItemRef | undefined;
  if (r?.kind !== 'run') throw new ApsError('ValidationError', 'Triage works on a run: pass run:<runId> (or run:last)');
  return r.runId;
}
