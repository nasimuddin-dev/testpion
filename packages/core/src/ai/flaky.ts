/**
 * AI-5 · Flaky-test analysis: "Why is this flaky?". TestPion reads the test's results across runs (it passes and fails
 * without a change: test-history.ts finds such tests) and gathers the signals without a model — pass rate, flips,
 * retries, the environments it failed in, the latency of passes against failures, the statuses and checks of the
 * failures, the hours they happened — plus a failing and a passing response. The model names the pattern (timing,
 * ordering, shared state, a time-dependent value, an external dependency, a rate limit, a data collision) with
 * evidence and proposes a fix that makes the test stable without hiding a failure: a wait (`until:`), a stable check,
 * isolated data, a timeout; a retry only as a last resort (verified with a caution); never skip or quarantine (refused).
 * "Attempt to fix" (flaky-run.ts) applies it and runs the test again N times for a stability verdict.
 */
import { join } from 'node:path';
import { checkLabel, diffResponses, toItemRef, type ItemRef } from '@testpion/shared';
import type { TestResult } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { readResultsFile } from '../runner/runner.js';
import { readRunSummary } from '../runner/run-records.js';
import { flakyTests } from '../runner/test-history.js';
import { requestIdOfResult } from '../runner/result-source.js';
import { parseYaml } from '../util/lazy-yaml.js';
import { slugify } from '../util/ids.js';
import type { AiPrivacy } from './ai-settings.js';
import type { ProposalFinding, ProposalItem } from './proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { evidenceOf, responseOfResult, sourceOfResult, type FailureEvidence, type FailureSource } from './run-evidence.js';
import { fixItems, type FixSpec, type FixTarget } from './fix-items.js';
import type { StoredResponse } from './verify.js';

const FLAKY_PATTERNS = ['timing', 'ordering', 'shared-state', 'time-dependent', 'external-dependency', 'rate-limit', 'data-collision', 'unknown'] as const;
type FlakyPattern = (typeof FLAKY_PATTERNS)[number];

export const FLAKY_SCHEMA = {
  type: 'object',
  required: ['pattern', 'title', 'explanation', 'confidence', 'fix'],
  properties: {
    pattern: { type: 'string', enum: [...FLAKY_PATTERNS] },
    title: { type: 'string' },
    explanation: { type: 'string', description: 'Why, citing which runs failed and how' },
    confidence: { type: 'number', description: '0 to 1' },
    evidence: { type: 'array', items: { type: 'string' } },
    fix: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['step', 'check', 'edit', 'retry', 'none'] },
        set: { type: 'object', description: 'step: keys for the test file step (until, timeout …)' },
        check: { type: 'object' },
        newCheck: { type: 'object' },
        checkIndex: { type: 'number', description: "check: the flaky check's checkIndex from failingChecksAsWritten" },
        replacement: { type: 'object', description: 'check: the whole stable check to use instead' },
        find: { type: 'string' },
        replace: { type: 'string' },
        retries: { type: 'number' },
        note: { type: 'string' },
      },
    },
  },
};

/** One run of the test (newest last). */
interface FlakyRun {
  runId: string;
  startedAt: string;
  environment?: string;
  status: 'passed' | 'failed';
  latencyMs?: number;
  attempts?: number;
  httpStatus?: number;
  failures?: string[];
}

export interface FlakyEvidence {
  testId: string;
  name: string;
  source?: FailureSource;
  step?: string;
  runs: FlakyRun[];
  signals: {
    runs: number;
    passed: number;
    failed: number;
    flips: number;
    retried: number;
    failedIn: Record<string, number>;
    passedIn: Record<string, number>;
    medianPassMs?: number;
    medianFailMs?: number;
    failStatuses: Record<string, number>;
    failHoursUtc: number[];
    commonFailures: Array<{ failure: string; count: number }>;
    /** How the failing response differs from a passing one, in words ("$.status: \"done\" when it passes, \"running\" when it fails"). */
    signature?: string;
    /** TestPion's guess from the signals (the model may say otherwise, with its reasons). */
    likely: FlakyPattern;
  };
  failing?: FailureEvidence;
  passing?: { runId: string; response?: StoredResponse; complete: boolean };
  /** How to run the test again (Attempt to fix): its file, or its collection request. */
  rerun?: FlakyRerun;
}

export type FlakyRerun = { kind: 'tests'; path: string; testId: string; environment?: string } | { kind: 'collection'; collectionId: string; requestId: string; environment?: string };

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]!) : undefined;
};

/** A test file's step ids as the loader makes them (explicit id, or <file>:<name>). */
function stepIds(text: string, path: string): Array<{ id: string; ref: string }> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const steps = (Array.isArray(doc) ? doc : Array.isArray((doc as { tests?: unknown })?.tests) ? (doc as { tests: unknown[] }).tests : doc && typeof doc === 'object' ? [doc] : []) as Array<
    Record<string, unknown>
  >;
  const file = slugify(
    path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, ''),
  );
  return steps.filter((s) => s && typeof s === 'object').map((s) => ({ id: s.id !== undefined ? String(s.id) : `${file}:${slugify(String(s.name ?? ''))}`, ref: String(s.id ?? s.name ?? '') }));
}

/** The test an item names: test-case:<id>, or test:<path>[:<step>] (without a step: its flaky step, or its only one). */
export async function flakyTestId(store: WorkspaceStore, item: unknown): Promise<string> {
  const ref = (typeof item === 'string' ? undefined : toItemRef(item)) as ItemRef | undefined;
  if (ref?.kind === 'test-case') return ref.testId;
  if (ref?.kind === 'test' || ref?.kind === 'flow') {
    const path = ref.path.replace(/^tests[\\/]/, '');
    const ids = stepIds(store.readTestFile(path), path);
    if (ref.step) {
      const s = ids.find((x) => x.ref === ref.step || x.id === ref.step);
      if (!s) throw new ApsError('ValidationError', `No step "${ref.step}" in tests/${path}`, { suggestions: [`Its steps: ${ids.map((x) => x.ref).join(', ')}`] });
      return s.id;
    }
    const flaky = new Set((await flakyTests(store)).map((t) => t.id));
    const hit = ids.find((x) => flaky.has(x.id)) ?? (ids.length === 1 ? ids[0] : undefined);
    if (!hit)
      throw new ApsError('ValidationError', `tests/${path} has no flaky step${ids.length ? '; name one' : ''}`, {
        suggestions: ids.length ? [`test:${path}:<step> — its steps: ${ids.map((x) => x.ref).join(', ')}`] : ['testpion history flaky (MCP flaky_tests) lists the flaky tests.'],
      });
    return hit.id;
  }
  throw new ApsError('ValidationError', 'Flaky analysis works on a test: test-case:<testId> (as flaky_tests names it) or test:<path>[:<step>]');
}

/** Gather a test's history and signals (see the module comment). Nothing is sent anywhere. */
export async function flakyEvidence(store: WorkspaceStore, testId: string, o: { runs?: number } = {}): Promise<FlakyEvidence> {
  const runs = store.meta.listRuns({ limit: Math.min(Math.max(o.runs ?? 60, 2), 300) }).items;
  const found: Array<{ run: (typeof runs)[number]; r: TestResult }> = [];
  const match = (id: string) => id === testId || requestIdOfResult(id) === testId;
  for (const run of runs) {
    if (found.length >= 30) break;
    for await (const r of await readResultsFile(join(store.runDir(run.id), 'results.jsonl'))) {
      if (!match(r.id) || r.status === 'skipped') continue;
      found.push({ run, r });
      break;
    }
  }
  if (!found.length) throw new ApsError('ValidationError', `No run has a result of "${testId}"`, { suggestions: ['testpion history flaky (MCP flaky_tests) names the flaky tests by id.'] });
  const ordered = [...found].reverse();
  const list: FlakyRun[] = ordered.map(({ run, r }) => {
    const st = (r.metadata as { status?: unknown } | undefined)?.status;
    return {
      runId: run.id,
      startedAt: run.startedAt,
      ...(run.environment ? { environment: run.environment } : {}),
      status: r.status === 'passed' ? 'passed' : 'failed',
      ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
      ...(r.attempts > 1 ? { attempts: r.attempts } : {}),
      ...(typeof st === 'number' ? { httpStatus: st } : {}),
      ...(r.status !== 'passed'
        ? {
            failures: r.error
              ? [`${r.error.kind}: ${r.error.message}`.slice(0, 200)]
              : r.checks
                  .filter((c) => !c.passed)
                  .slice(0, 3)
                  .map((c) => c.name),
          }
        : {}),
    };
  });
  let flips = 0;
  for (let i = 1; i < list.length; i++) if (list[i]!.status !== list[i - 1]!.status) flips++;
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  const fails = list.filter((x) => x.status === 'failed');
  const passes = list.filter((x) => x.status === 'passed');
  const common = count(fails.flatMap((f) => f.failures ?? []));
  const lastFail = found.find((x) => x.r.status !== 'passed');
  const lastPass = found.find((x) => x.r.status === 'passed');
  // the definition and the evidence come from the latest failing run (the latest run when none failed in the window)
  const base = lastFail ?? found[0]!;
  const origin = readRunSummary(store, base.run.id)?.origin;
  const cache: Record<string, FailureSource | null> = {};
  const failing = lastFail ? evidenceOf(store, lastFail.run.id, lastFail.r, origin, cache) : undefined;
  const source = sourceOfResult(store, base.r, origin, cache);
  const name = base.r.name;
  const rerun: FlakyRerun | undefined =
    source?.kind === 'test'
      ? { kind: 'tests', path: source.path, testId: base.r.id, ...(base.run.environment ? { environment: base.run.environment } : {}) }
      : source?.kind === 'request'
        ? { kind: 'collection', collectionId: source.collectionId, requestId: source.requestId, ...(base.run.environment ? { environment: base.run.environment } : {}) }
        : undefined;
  const passing = lastPass ? { runId: lastPass.run.id, ...responseOfResult(store, lastPass.r) } : undefined;
  const sig = signatureOf(failing, passing, fails, passes);
  return {
    testId,
    name,
    ...(source ? { source } : {}),
    ...(failing?.step ? { step: failing.step } : {}),
    runs: list,
    signals: {
      runs: list.length,
      passed: passes.length,
      failed: fails.length,
      flips,
      retried: list.filter((x) => x.status === 'passed' && (x.attempts ?? 1) > 1).length,
      failedIn: count(fails.map((x) => x.environment ?? '(none)')),
      passedIn: count(passes.map((x) => x.environment ?? '(none)')),
      medianPassMs: median(passes.map((x) => x.latencyMs ?? NaN)),
      medianFailMs: median(fails.map((x) => x.latencyMs ?? NaN)),
      failStatuses: count(fails.map((x) => String(x.httpStatus ?? 'none'))),
      failHoursUtc: fails.map((x) => new Date(x.startedAt).getUTCHours()),
      commonFailures: Object.entries(common)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([failure, n]) => ({ failure, count: n })),
      ...sig,
    },
    ...(failing ? { failing } : {}),
    ...(passing ? { passing } : {}),
    ...(rerun ? { rerun } : {}),
  };
}

/** Values of a field that say "not done yet": a failure that sees one read too early. */
const INTERMEDIATE = /^(running|pending|queued|processing|in[ _-]?progress|started|starting|waiting|created|accepted|scheduled|not[ _-]?ready|initiali[sz]ing)$/i;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{10,13}$/;

/** A field that says where a thing is: status, state, phase, ready, done … */
const STATE_FIELD = /^(status|state|phase|stage|ready|done|complete|completed|finished|result|outcome|progress)$/i;
/** A field whose value changes on every call: ids, times, tokens, counters. */
const VOLATILE_FIELD = /(^id$|_id$|[a-z]Id$|uuid|guid|time|date|timestamp|_at$|[a-z]At$|token|nonce|etag|counter|^count$|^seq|sequence|version|^rev$)/i;
const VOLATILE_VALUE = /^(\d{4}-\d{2}-\d{2}|\d{10,13}$|[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{16,}$|[A-Za-z0-9_-]{24,}$)/i;

/** The JSONPaths the failing checks read (`equals $.status` → $.status). */
function assertedPaths(failing: FailureEvidence | undefined): string[] {
  const out = new Set<string>();
  for (const a of failing?.failedAssertions ?? []) if (typeof a.check.path === 'string') out.add(a.check.path);
  for (const c of failing?.failedChecks ?? []) for (const m of c.name.matchAll(/\$[\w.[\]'"-]*/g)) out.add(m[0]);
  return [...out];
}

/**
 * The changed fields worth naming, most telling first: the fields the failing checks assert, then state-like ones
 * (status, phase, ready …), then the rest. A value that changes on every call (an id, a time, a token, a counter) is
 * left out unless a check asserts it — `$.id "job-6" vs "job-5"` says nothing about why the test fails.
 */
function rankedFields<T extends { path: string; after?: unknown }>(changed: T[], asserted: string[]): T[] {
  const last = (p: string) => /([^.[\]'"]+)['"\]]*$/.exec(p)?.[1] ?? p;
  const isAsserted = (p: string) => asserted.some((a) => p === a || p.startsWith(`${a}.`) || p.startsWith(`${a}[`) || a.startsWith(`${p}.`));
  const rank = (c: T) => (isAsserted(c.path) ? 0 : STATE_FIELD.test(last(c.path)) ? 1 : 2);
  return changed
    .filter((c) => isAsserted(c.path) || !(VOLATILE_FIELD.test(last(c.path)) || (typeof c.after === 'string' && VOLATILE_VALUE.test(c.after))))
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i)
    .map((x) => x.c);
}

/**
 * The deterministic signature of a flaky test (see the module comment): how a failing response differs from a passing
 * one (the status, the first changed fields with both values), and the pattern it points to — an intermediate state
 * (running, pending … or 404 / 202 for what passes with 200) is timing; 429 a rate limit; 409 a data collision; changed
 * dates time-dependent; 5xx, timeouts or failures much slower than passes an external dependency.
 */
function signatureOf(
  failing: FailureEvidence | undefined,
  passing: { response?: StoredResponse; complete: boolean } | undefined,
  fails: FlakyRun[],
  passes: FlakyRun[],
): { signature?: string; likely: FlakyPattern } {
  const statuses = fails.map((f) => f.httpStatus);
  const parts: string[] = [];
  let state = false;
  let dates = false;
  const pass = passing?.response;
  const fail = failing?.response;
  if (pass?.status !== undefined && fail?.status !== undefined && pass.status !== fail.status) {
    parts.push(`status ${pass.status} when it passes, ${fail.status} when it fails`);
    if ([404, 202, 204].includes(fail.status) && pass.status >= 200 && pass.status < 300) state = true;
  }
  if (pass?.body !== undefined && fail?.body !== undefined && failing?.complete && passing?.complete) {
    const d = diffResponses({ status: pass.status, body: pass.body }, { status: fail.status, body: fail.body }, { maxChanges: 12 });
    const changed = d.body.changes.filter((c) => c.kind === 'changed' || c.kind === 'type');
    const named = rankedFields(changed, assertedPaths(failing));
    for (const c of named.slice(0, 3)) parts.push(`${c.path}: ${JSON.stringify(c.before)} when it passes, ${JSON.stringify(c.after)} when it fails`);
    const other = d.body.changes.length - Math.min(3, named.length);
    if (other > 0) parts.push(`${other} more field${other === 1 ? '' : 's'} differ`);
    state ||= changed.some((c) => typeof c.after === 'string' && INTERMEDIATE.test(c.after)) || d.body.changes.some((c) => c.kind === 'removed' && /result|data|items/i.test(c.path));
    dates = changed.length > 0 && changed.every((c) => typeof c.after === 'string' && DATE_LIKE.test(c.after));
  }
  const signature = parts.length ? `Failing responses differ from passing ones in: ${parts.join('; ')}` : undefined;
  const failMs = fails.map((f) => f.latencyMs ?? 0);
  const passMs = passes.map((f) => f.latencyMs ?? 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const likely: FlakyPattern = statuses.includes(429)
    ? 'rate-limit'
    : statuses.includes(409)
      ? 'data-collision'
      : state
        ? 'timing'
        : dates
          ? 'time-dependent'
          : statuses.some((x) => typeof x === 'number' && x >= 500) || fails.some((f) => f.failures?.some((m) => /Timeout|Network/i.test(m))) || (avg(passMs) > 0 && avg(failMs) > 3 * avg(passMs))
            ? 'external-dependency'
            : 'unknown';
  return { ...(signature ? { signature } : {}), likely };
}

/** What the model is sent (budgets and redaction come after). */
function flakyContext(ev: FlakyEvidence, privacy: AiPrivacy): Record<string, unknown> {
  const values = privacy === 'full';
  const f = ev.failing;
  return {
    test: {
      id: ev.testId,
      name: ev.name,
      where: ev.source?.kind === 'request' ? `request "${ev.source.name}"` : ev.source?.kind === 'test' ? `tests/${ev.source.path}${ev.step ? ` step ${ev.step}` : ''}` : undefined,
    },
    // the signature quotes body values: at metadata it is left out (the pattern guess stays)
    signals: values ? ev.signals : { ...ev.signals, signature: undefined },
    history: ev.runs.map((r) => ({ ...r, failures: values ? r.failures : r.failures?.map((x) => x.split(':')[0]) })),
    samples: {
      ...(f
        ? {
            failing: {
              run: f.refs[0],
              status: f.response?.status,
              failed: f.failedChecks.map((c) => (values ? c : { type: c.type, check: c.name })),
              failingChecksAsWritten: f.failedAssertions.map((a) => ({ checkIndex: a.index, check: a.check })),
              ...(f.response?.body !== undefined ? { body: f.response.body } : {}),
              ...(f.latencyMs !== undefined ? { latencyMs: f.latencyMs } : {}),
            },
          }
        : {}),
      ...(ev.passing
        ? {
            passing: {
              run: ev.passing.runId,
              status: ev.passing.response?.status,
              ...(ev.passing.response?.body !== undefined ? { body: ev.passing.response.body } : {}),
              latencyMs: ev.passing.response?.latencyMs,
            },
          }
        : {}),
    },
    ...(values && ev.source ? { definition: ev.source.kind === 'test' ? ev.source.text.slice(0, 6000) : { checks: ev.source.assertions, testScript: ev.source.testScript } } : {}),
  };
}

interface FlakyLocal {
  evidence: FlakyEvidence;
}

/** Evidence a caller gathered already (`analyzeFlaky`), so the task does not read the runs twice. */
const gathered = new WeakMap<WorkspaceStore, Map<string, FlakyEvidence>>();

export async function withFlakyEvidence<T>(store: WorkspaceStore, ev: FlakyEvidence, fn: () => Promise<T>): Promise<T> {
  let m = gathered.get(store);
  if (!m) gathered.set(store, (m = new Map()));
  m.set(ev.testId, ev);
  try {
    return await fn();
  } finally {
    m.delete(ev.testId);
  }
}

/** The task's `prepare`: the evidence of a flaky test. */
export async function prepareFlaky(store: WorkspaceStore, item: ItemRef, o: { privacy: AiPrivacy }): Promise<PreparedItem> {
  const id = await flakyTestId(store, item);
  const ev = gathered.get(store)?.get(id) ?? (await flakyEvidence(store, id));
  return { label: ev.name, context: flakyContext(ev, o.privacy), local: { evidence: ev } satisfies FlakyLocal };
}

/** Keys a flaky fix may never set: they hide the test instead of fixing it. */
const HIDING = /^(skip|disabled?|quarantine|tags|if|when)$/i;

/** The task's `propose`: the fix as verified items; skip / quarantine is never offered. */
export function proposeFlaky(answer: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems: string[] } {
  const { evidence: ev } = input.local as FlakyLocal;
  const v = (answer.value ?? {}) as { title?: unknown; fix?: Partial<FixSpec> & { type?: unknown; retries?: unknown } };
  const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim().slice(0, 120) : `Make "${ev.name}" stable`;
  // the model's fix as it came (retry is the flaky analysis' own type; the rest are fix-items' FixSpec)
  const fix = (v.fix ?? { type: 'none' }) as Omit<FixSpec, 'type'> & { type: string; retries?: unknown };
  if (!ev.source) return { items: [], notes: ['The test is defined nowhere TestPion can change (its file or request is gone).'], problems: [] };
  // a fix that could not be made goes back to the model (a repair turn), with how to write it
  const refs = (ev.failing?.failedAssertions ?? []).map((a) => `checkIndex ${a.index} (${checkLabel(a.check)})`).join('; ');
  const retry = (r: { items: DraftItem[]; notes: string[] }) =>
    r.items.length
      ? []
      : [
          `The fix could not be made — ${r.notes.join(' ') || 'it is incomplete'} Use {"type": "step", "set": {…}} for keys of the step (until, timeout), {"type": "check", "checkIndex": N, "replacement": {the whole new check}} for a check${refs ? ` (the failing checks: ${refs})` : ''}, or an edit whose find is copied exactly from the definition.`,
        ];
  const target: FixTarget = {
    source: ev.source,
    ...(ev.step ? { step: ev.step } : {}),
    resultIds: [ev.testId],
    failedAssertions: ev.failing?.failedAssertions ?? [],
    // a fix must hold on the failing response and on a passing one
    verifyOn: [
      {
        resultId: ev.testId,
        ...(ev.failing?.response && ev.failing.complete ? { failing: ev.failing.response } : {}),
        ...(ev.passing?.response && ev.passing.complete ? { lastPassing: ev.passing.response } : {}),
      },
    ],
    unresolvedVariables: ev.failing?.unresolvedVariables ?? [],
    request: ev.failing?.request,
  };
  const notes: string[] = [];
  if (fix.type === 'retry') {
    const n = Math.min(2, Math.max(1, Number(fix.retries) || 1));
    const r = fixItems({ type: 'step', set: { retries: n } }, [target], { finding: 'f1', title, caution: 'a retry: the failure can still come back, and a real one is retried too (last resort)' });
    return { items: r.items, notes: [...notes, ...r.notes], problems: [] };
  }
  if (fix.type === 'step' && fix.set && typeof fix.set === 'object') {
    const hiding = Object.keys(fix.set).filter((k) => HIDING.test(k));
    if (hiding.length) notes.push(`Not offered: ${hiding.join(', ')} would hide the test's failures instead of fixing them.`);
    const set = Object.fromEntries(Object.entries(fix.set).filter(([k]) => !HIDING.test(k)));
    if (!Object.keys(set).length) return { items: [], notes, problems: [] };
    const r = fixItems({ type: 'step', set }, [target], { finding: 'f1', title });
    return { items: r.items, notes: [...notes, ...r.notes], problems: retry(r) };
  }
  if (fix.type === 'check' || fix.type === 'edit') {
    if (fix.type === 'edit' && typeof fix.replace === 'string' && /\b(skip|quarantine)\s*:\s*true\b/i.test(fix.replace))
      return { items: [], notes: ['Not offered: the edit would skip the test, hiding its failures.'], problems: [] };
    const r = fixItems({ ...fix, type: fix.type }, [target], { finding: 'f1', title });
    return { items: r.items, notes: [...notes, ...r.notes], problems: retry(r) };
  }
  if (typeof fix.note === 'string' && fix.note.trim())
    return { items: [{ kind: 'text', finding: 'f1', title: `What to do: ${title}`, after: fix.note.trim(), language: 'markdown' }], notes, problems: [] };
  return {
    items: [],
    notes: [...notes, ...(['skip', 'quarantine', 'disable'].includes(String(fix.type)) ? ['Not offered: skipping or quarantining the test hides its failures.'] : [])],
    problems: [],
  };
}

/** Deterministic evidence lines (each linking a run when it can). */
function signalFacts(ev: FlakyEvidence): ProposalFinding['evidence'] {
  const s = ev.signals;
  const out: ProposalFinding['evidence'] = [{ text: `Passed ${s.passed} of ${s.runs} runs; its result changed ${s.flips} times${s.retried ? `; ${s.retried} passed only after a retry` : ''}` }];
  if (s.signature) out.push({ text: s.signature.slice(0, 300) });
  const envs = Object.keys(s.failedIn);
  if (envs.length === 1 && !s.passedIn[envs[0]!] && Object.keys(s.passedIn).length) out.push({ text: `Failed only in ${envs[0]} (passed in ${Object.keys(s.passedIn).join(', ')})` });
  if (s.medianPassMs !== undefined && s.medianFailMs !== undefined) out.push({ text: `Median time: ${s.medianPassMs} ms when it passes, ${s.medianFailMs} ms when it fails` });
  const statuses = Object.entries(s.failStatuses).filter(([k]) => k !== 'none');
  if (statuses.length) out.push({ text: `Statuses when it failed: ${statuses.map(([k, n]) => `${k} ×${n}`).join(', ')}` });
  for (const c of s.commonFailures.slice(0, 2)) out.push({ text: `${c.count} × ${c.failure}` });
  const lastFail = [...ev.runs].reverse().find((r) => r.status === 'failed');
  if (lastFail)
    out.push({
      text: `Latest failure: run ${lastFail.runId} (${lastFail.startedAt.slice(0, 16).replace('T', ' ')})`,
      ref: { kind: 'run', runId: lastFail.runId, ...(ev.failing ? { resultId: ev.failing.resultId } : {}) },
    });
  return out;
}

/** The task's `describe`: one finding — the pattern with its evidence — and how to run the test again. */
export function describeFlaky(value: unknown, items: ProposalItem[], input: AiTaskInput): { summary?: string; findings: ProposalFinding[] } {
  const { evidence: ev } = input.local as FlakyLocal;
  const v = (value ?? {}) as { pattern?: unknown; title?: unknown; explanation?: unknown; confidence?: unknown; evidence?: unknown };
  const said = Array.isArray(v.evidence)
    ? v.evidence
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .slice(0, 6)
        .map((text) => ({ text: text.slice(0, 300) }))
    : [];
  void items;
  return {
    findings: [
      {
        id: 'f1',
        title: typeof v.title === 'string' && v.title.trim() ? v.title.trim().slice(0, 120) : `Why "${ev.name}" is flaky`,
        kind: FLAKY_PATTERNS.includes(v.pattern as FlakyPattern) ? String(v.pattern) : 'unknown',
        ...(typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 ? { confidence: v.confidence } : {}),
        ...(typeof v.explanation === 'string' ? { explanation: v.explanation.slice(0, 2000) } : {}),
        evidence: [...said, ...signalFacts(ev)],
        count: ev.signals.failed,
        resultIds: [ev.testId],
      },
    ],
  };
}

/** The finding without a model: the signals, said as they are. */
export function deterministicFlakyFinding(ev: FlakyEvidence): ProposalFinding {
  const s = ev.signals;
  const kind: FlakyPattern =
    s.likely !== 'unknown' ? s.likely : Object.keys(s.failedIn).length === 1 && Object.keys(s.passedIn).length > 0 && !s.passedIn[Object.keys(s.failedIn)[0]!] ? 'external-dependency' : 'unknown';
  return { id: 'f1', title: `"${ev.name}" is flaky`, kind, evidence: signalFacts(ev), count: s.failed, resultIds: [ev.testId] };
}
