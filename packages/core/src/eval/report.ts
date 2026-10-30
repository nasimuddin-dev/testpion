/**
 * The report card of an evaluation run (AU-14) and the answer of one case against the run before (AU-22): one function the
 * app (`eval.summary`, `eval.caseDiff`), `testpion eval summary|diff` and the `eval_summary` / `eval_case_diff` MCP tools all
 * call, so the sentence a person reads in the window is word for word what a pipeline or an agent reads.
 *
 * Host-agnostic: it reads a run's summary.json and results.jsonl through the workspace store and keeps nothing.
 */
import { diffResponses, type ResponseDiff } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { CheckResult, RunSummary, TestResult } from '../model/types.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import { runResults, runReviews } from '../runner/run-results.js';
import { EVALUATIONS_LIBRARY, type SavedEvaluation } from '../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { formatEstimateUsd } from './llm-estimate.js';

type Store = Pick<WorkspaceStore, 'root' | 'runDir' | 'meta'> & Partial<Pick<WorkspaceStore, 'getLibrary'>>;

/** How many failures one report lists (the rest are counted): the matrix and `run_results` hold every case. */
const MAX_FAILURES = 100;
const MAX_FLIPPED = 50;
/** The runs of the trend: this one and the ones before it. */
const TREND_RUNS = 12;

export interface EvalReportCheck {
  /** The check as the run names it ("matches expected", "valid JSON"). */
  name: string;
  type: string;
  passed: number;
  total: number;
  /** An AI reviewer grades it: its grades are the model's opinion. */
  aiReviewer: boolean;
}

export interface EvalReportFailure {
  resultId: string;
  /** The case: its id without the evaluation's name. */
  key: string;
  name: string;
  status: 'failed' | 'error';
  /** The prompt of the case, as sent. */
  input?: string;
  /** The reply. */
  got?: string;
  /** The answer that was expected, when a check holds one. */
  expected?: string;
  failedChecks: Array<{ name: string; type: string; message: string; aiReviewer: boolean; reason?: string }>;
  /** The AI reviewer's own words about this case, when it graded it: the answer to "why did this fail?" without another model call. */
  reason?: string;
  error?: string;
}

export interface EvalReportFlip {
  resultId: string;
  /** The case: its id without the evaluation's name. */
  key: string;
  name: string;
  from: 'passed' | 'failed';
  to: 'passed' | 'failed';
}

export interface EvalReportTrendPoint {
  runId: string;
  startedAt: string;
  passed: number;
  total: number;
  /** 0 to 1. */
  passRate: number;
}

export interface EvalReport {
  run: { id: string; name: string; startedAt: string; environment?: string };
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  total: number;
  /** 0 to 1. */
  passRate: number;
  /** "17 of 20 passed". */
  headline: string;
  costUsd: number;
  /** What this evaluation costs over time (A-8): this run, the run before, and this calendar month's runs of this name. */
  cost: { usd: number; lastUsd?: number; monthUsd: number; monthRuns: number };
  /** Mean and slowest time of a case, ms. */
  avgMs?: number;
  slowestMs?: number;
  durationMs: number;
  /** The answers came from the offline demo model, which answers by rules. */
  offline: boolean;
  /** Per check: how many cases passed it. */
  byCheck: EvalReportCheck[];
  /** The cases that failed, in the order they ran (at most 100). */
  failures: EvalReportFailure[];
  failuresShown: number;
  /** The pass line of the saved evaluation of this name, when it has one. */
  passLine?: { percent: number; met: boolean; text: string };
  /** The run before this one (same name, finished earlier). */
  previous?: { runId: string; startedAt: string; passed: number; total: number };
  /** Against that run, case by case. */
  vsLast?: { passedDelta: number; gotWorse: number; gotBetter: number; text: string };
  /** The cases whose verdict changed since that run (A-3), the ones that got worse first; at most 50. */
  flipped?: EvalReportFlip[];
  /** Pass rates of the last runs of this name, oldest first, this one last. */
  trend: EvalReportTrendPoint[];
  /** The whole report as words: what the CLI prints and the MCP tool returns beside the numbers. */
  text: string;
}

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** A duration the way a person reads it: 850 ms, 2.1 s. */
export function evalMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** The case a result is of: its id without the evaluation's slug ("slug:record" → "record"). */
export const evalCaseKey = (id: string): string => {
  const i = id.indexOf(':');
  return i > 0 && i < id.length - 1 ? id.slice(i + 1) : id;
};

const isReviewer = (c: Pick<CheckResult, 'source'>) => c.source === 'ai-judge';
const asText = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

/** The saved evaluation a run of this name belongs to, if the workspace still has it. */
function savedEvaluationNamed(store: Store, name: string): (SavedEvaluation & { id: string }) | undefined {
  try {
    const it = store.getLibrary?.call(store, EVALUATIONS_LIBRARY).items.find((i) => i.name === name);
    return it ? { ...(it.data as SavedEvaluation), name: it.name, id: it.id } : undefined;
  } catch {
    return undefined;
  }
}

/** A failed result as the report lists it. */
export function failureOf(r: TestResult): EvalReportFailure {
  const failed = r.checks.filter((c) => !c.passed);
  const withExpected = failed.find((c) => c.expected !== undefined) ?? r.checks.find((c) => c.expected !== undefined);
  const reviewer = failed.filter((c) => isReviewer(c) && c.explanation);
  return {
    resultId: r.id,
    key: evalCaseKey(r.id),
    name: r.name,
    status: r.status === 'error' ? 'error' : 'failed',
    ...(r.input ? { input: r.input } : {}),
    ...(r.output ? { got: r.output } : {}),
    ...(withExpected ? { expected: asText(withExpected.expected) } : {}),
    failedChecks: failed.map((c) => ({ name: c.name || c.type, type: c.type, message: c.message, aiReviewer: isReviewer(c), ...(c.explanation ? { reason: c.explanation } : {}) })),
    ...(reviewer.length ? { reason: reviewer.map((c) => c.explanation).join(' ') } : {}),
    ...(r.error ? { error: r.error.message } : {}),
  };
}

/** The finished run of the same name just before this one, with its summary. */
export function previousRunOf(store: Store, run: { runId: string; name: string; startedAt: string }): { runId: string; summary: RunSummary } | undefined {
  for (const m of store.meta.listRuns({ query: run.name, limit: 200 }).items) {
    if (m.id === run.runId || m.name !== run.name || m.startedAt >= run.startedAt) continue;
    const s = readRunSummary(store, m.id);
    if (s && !s.cancelled) return { runId: m.id, summary: s };
  }
  return undefined;
}

/** The report card of a run: its id, "last" or a name (as every eval command takes them). */
export async function evalReport(store: Store, o: { run: string; /** Compare with this run instead of the one before. */ against?: string }): Promise<EvalReport> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished: it has no summary yet`);
  const byCheck = new Map<string, EvalReportCheck>();
  const failures: EvalReportFailure[] = [];
  const status = new Map<string, string>();
  const cases = new Map<string, { id: string; name: string }>();
  let failedCount = 0;
  let slowest = 0;
  let offline = false;
  for await (const r of runResults(store, ref.runId)) {
    status.set(evalCaseKey(r.id), r.status);
    cases.set(evalCaseKey(r.id), { id: r.id, name: r.name });
    if ((r.latencyMs ?? r.durationMs) > slowest) slowest = r.latencyMs ?? r.durationMs;
    if ((r.metadata?.reproducibility as { provider?: string } | undefined)?.provider === 'mock') offline = true;
    for (const c of r.checks ?? []) {
      const k = c.name || c.type;
      const e = byCheck.get(k) ?? { name: k, type: c.type, passed: 0, total: 0, aiReviewer: isReviewer(c) };
      e.total++;
      if (c.passed) e.passed++;
      byCheck.set(k, e);
    }
    if (r.status === 'failed' || r.status === 'error') {
      failedCount++;
      if (failures.length < MAX_FAILURES) failures.push(failureOf(r));
    }
  }
  const ran = summary.total - summary.skipped;
  const headline = `${summary.passed} of ${ran} passed`;
  const saved = savedEvaluationNamed(store, summary.name);
  const passRate = ran ? summary.passed / ran : 0;
  const line = saved?.passLine;
  const passLine = typeof line === 'number' && line > 0 && line <= 100 ? { percent: line, met: passRate * 100 >= line, text: `Pass line ${line}%: ${passRate * 100 >= line ? 'met' : 'not met'}` } : undefined;

  // the run before (or the one asked for), case by case
  let previous: EvalReport['previous'];
  let vsLast: EvalReport['vsLast'];
  let flipped: EvalReportFlip[] | undefined;
  const before = o.against ? (() => { const a = resolveRunRef(store, o.against!); const s = readRunSummary(store, a.runId); return s ? { runId: a.runId, summary: s } : undefined; })() : previousRunOf(store, { runId: ref.runId, name: summary.name, startedAt: summary.startedAt });
  if (before) {
    previous = { runId: before.runId, startedAt: before.summary.startedAt, passed: before.summary.passed, total: before.summary.total - before.summary.skipped };
    let worse = 0;
    let better = 0;
    const flips: EvalReportFlip[] = [];
    for await (const r of runResults(store, before.runId)) {
      const key = evalCaseKey(r.id);
      const now = status.get(key);
      if (now === undefined) continue;
      const was = r.status === 'passed';
      const is = now === 'passed';
      if (was === is) continue;
      if (was && !is) worse++;
      else better++;
      const c = cases.get(key)!;
      flips.push({ resultId: c.id, key, name: c.name, from: was ? 'passed' : 'failed', to: is ? 'passed' : 'failed' });
    }
    // the ones that got worse first, each side in the order they ran
    flipped = [...flips.filter((f) => f.to === 'failed'), ...flips.filter((f) => f.to === 'passed')].slice(0, MAX_FLIPPED);
    const delta = summary.passed - before.summary.passed;
    const same = delta === 0 && worse === 0 && better === 0;
    const parts = [delta === 0 ? 'the same number passed' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} passed`];
    if (worse || better) parts.push(`${better} got better, ${worse} got worse`);
    vsLast = { passedDelta: delta, gotWorse: worse, gotBetter: better, text: same ? 'Same as the last run' : `Against the last run: ${parts.join(', ')}` };
  }

  // the trend: this run and the ones before it of the same name
  const trend: EvalReportTrendPoint[] = store.meta
    .listRuns({ query: summary.name, limit: 200 })
    .items.filter((m) => m.name === summary.name && m.startedAt <= summary.startedAt && m.total - m.skipped > 0)
    .slice(0, TREND_RUNS)
    .reverse()
    .map((m) => ({ runId: m.id, startedAt: m.startedAt, passed: m.passed, total: m.total - m.skipped, passRate: m.passed / (m.total - m.skipped) }));

  // this month's spend on this evaluation: the summaries of its runs started this calendar month (the newest 60)
  const month = summary.startedAt.slice(0, 7);
  let monthUsd = 0;
  let monthRuns = 0;
  for (const m of store.meta.listRuns({ query: summary.name, limit: 200 }).items.filter((x) => x.name === summary.name && x.startedAt.slice(0, 7) === month).slice(0, 60)) {
    const s = m.id === ref.runId ? summary : readRunSummary(store, m.id);
    if (!s) continue;
    monthRuns++;
    monthUsd += s.costUsd ?? 0;
  }
  const cost: EvalReport['cost'] = { usd: summary.costUsd ?? 0, ...(before ? { lastUsd: before.summary.costUsd ?? 0 } : {}), monthUsd, monthRuns };
  const costWords = summary.costUsd
    ? `Cost ${formatEstimateUsd(summary.costUsd)}${before ? ` (last run ${formatEstimateUsd(before.summary.costUsd ?? 0)})` : ''}${monthRuns > 1 ? `; this month ${formatEstimateUsd(monthUsd)} over ${monthRuns} runs` : ''}`
    : '';

  const checks = [...byCheck.values()];
  const failedChecks = checks.filter((c) => c.passed < c.total);
  const timing = summary.latency.count ? `average ${evalMs(summary.latency.mean)}, slowest ${evalMs(slowest || summary.latency.max)}` : `${evalMs(summary.durationMs)} in all`;
  const words = [
    `${headline} (${percent(passRate)}).`,
    costWords ? `${costWords}, ${timing}.` : `${timing[0]!.toUpperCase()}${timing.slice(1)}.`,
    failedChecks.length ? `Failed: ${failedChecks.map((c) => `${c.name} ${c.total - c.passed} of ${c.total}`).join(', ')}.` : failedCount ? '' : 'Every check passed.',
    passLine ? `${passLine.text}.` : '',
    vsLast ? `${vsLast.text}.` : '',
    flipped?.length ? `Got worse: ${flipped.filter((f) => f.to === 'failed').map((f) => f.name).join(', ') || 'none'}. Got better: ${flipped.filter((f) => f.to === 'passed').map((f) => f.name).join(', ') || 'none'}.` : '',
    offline ? 'Offline demo model: its answers come from rules, not from a real model.' : '',
  ].filter(Boolean);
  return {
    run: { id: ref.runId, name: summary.name, startedAt: summary.startedAt, ...(summary.environment ? { environment: summary.environment } : {}) },
    passed: summary.passed,
    failed: summary.failed,
    errors: summary.errors,
    skipped: summary.skipped,
    total: ran,
    passRate: Math.round(passRate * 10_000) / 10_000,
    headline,
    costUsd: summary.costUsd,
    cost,
    ...(summary.latency.count ? { avgMs: Math.round(summary.latency.mean), slowestMs: Math.round(slowest || summary.latency.max) } : {}),
    durationMs: summary.durationMs,
    offline,
    byCheck: checks,
    failures,
    failuresShown: failures.length,
    ...(passLine ? { passLine } : {}),
    ...(previous ? { previous } : {}),
    ...(vsLast ? { vsLast } : {}),
    ...(flipped?.length ? { flipped } : {}),
    trend,
    text: words.join(' '),
  };
}

/* ------------------------------------------------------------------ one case */

/** One result of a run by its id, its case key ("record-7") or its name. */
export async function findEvalResult(store: Store, runId: string, ref: string): Promise<TestResult> {
  const want = String(ref ?? '').trim();
  if (!want) throw new ApsError('ValidationError', 'Name the case: its result id, its key (the id without the evaluation’s name) or its name');
  let byName: TestResult | undefined;
  for await (const r of runResults(store, runId)) {
    if (r.id === want || evalCaseKey(r.id) === want) {
      const review = runReviews(store, runId)[r.id];
      return review ? { ...r, review } : r;
    }
    if (!byName && r.name === want) byName = r;
  }
  if (byName) return byName;
  throw new ApsError('ValidationError', `Run ${runId} has no case "${want}"`, { suggestions: ['Take a case from `testpion eval summary <run> --json` (failures[].key or resultId).'] });
}

export interface EvalCaseDiff {
  key: string;
  name: string;
  run: { id: string; name: string; startedAt: string };
  against?: { id: string; name: string; startedAt: string };
  /** The case's result in each run. */
  now: { status: string; answer: string };
  before?: { status: string; answer: string };
  /** The answers are the same word for word. */
  same: boolean;
  /** Passed before and fails now, the other way, or no change. */
  change?: 'got worse' | 'got better' | 'same result';
  /** The answers as a structured diff (the one the response view uses). */
  diff?: ResponseDiff;
  /** One sentence. */
  text: string;
}

/** The answer of one case against the same case in the run before it (or in `against`): which cases flipped and how the text changed. */
export async function evalCaseDiff(store: Store, o: { run: string; case: string; against?: string }): Promise<EvalCaseDiff> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished`);
  const now = await findEvalResult(store, ref.runId, o.case);
  const key = evalCaseKey(now.id);
  const base = { key, name: now.name, run: { id: ref.runId, name: summary.name, startedAt: summary.startedAt }, now: { status: now.status, answer: now.output ?? '' } };
  const before = o.against ? { runId: resolveRunRef(store, o.against).runId } : previousRunOf(store, { runId: ref.runId, name: summary.name, startedAt: summary.startedAt });
  if (!before) return { ...base, same: false, text: 'There is no earlier run of this evaluation to compare with. Run it again to see what changed.' };
  const beforeSummary = readRunSummary(store, before.runId)!;
  let was: TestResult | undefined;
  for await (const r of runResults(store, before.runId)) if (evalCaseKey(r.id) === key) was = r;
  const against = { id: before.runId, name: beforeSummary.name, startedAt: beforeSummary.startedAt };
  if (!was) return { ...base, against, same: false, text: `This case is not in the earlier run (${against.id}): it is new.` };
  const answerBefore = was.output ?? '';
  const answerNow = now.output ?? '';
  const same = answerBefore === answerNow;
  const change = was.status === now.status ? 'same result' : was.status === 'passed' ? 'got worse' : now.status === 'passed' ? 'got better' : 'same result';
  const diff = diffResponses({ status: was.status, durationMs: was.latencyMs ?? was.durationMs, body: answerBefore }, { status: now.status, durationMs: now.latencyMs ?? now.durationMs, body: answerNow });
  const text = same ? `The answer is the same as in the last run${change === 'same result' ? '' : `, but the case ${change}: a check changed`}.` : `The answer changed since the last run${change === 'same result' ? '' : ` and the case ${change}`}: ${diff.body.format === 'json' ? `${diff.body.changes.length} field${diff.body.changes.length === 1 ? '' : 's'} differ` : 'the text differs'}.`;
  return { ...base, against, before: { status: was.status, answer: answerBefore }, same, change, diff, text };
}
