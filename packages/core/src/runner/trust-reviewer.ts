/**
 * Trust the AI reviewer (AU-23): grade ten answers of a finished run yourself, then see how often the AI reviewer agreed. A
 * thin layer over judge calibration (runner/rag-calibrate.ts, eval/rag/calibrate): the answers to grade are picked here (a mix
 * of the ones the reviewer passed and the ones it failed, in a fixed order, WITHOUT showing its verdict so it cannot lean on
 * you), your verdicts are the same labels `testpion rag label` writes, and the agreement is the same report (Cohen's kappa,
 * the confusion counts), said in a sentence. One function for the window (`eval.trust`), `testpion eval trust` and the MCP
 * tool `eval_trust_reviewer`.
 */
import { ApsError } from '../errors.js';
import { sha256Hex } from '../util/hash.js';
import { finishedRun } from './result-source.js';
import type { CheckResult, TestResult } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { clearLabel, readLabels, recordOfResult } from '../eval/rag/calibrate/labels.js';
import type { MetricCalibration } from '../eval/rag/calibrate/report.js';
import { isReviewerCheck } from '../eval/llm-estimate.js';
import { readRunSummary } from './run-records.js';
import { runResults } from './run-results.js';
import { calibrateRun, defaultLabelsName, labelResult } from './rag-calibrate.js';

export const TRUST_SAMPLE = 10;

/** A check that an AI reviewer graded: a reviewer check type, or a result that records the model that judged it. */
export const gradedByReviewer = (c: CheckResult): boolean => isReviewerCheck(c.type) || !!(c.metadata as { judge?: unknown } | undefined)?.judge;
const keyOf = (c: CheckResult) => c.name || c.type;

export interface TrustCase {
  resultId: string;
  /** What was asked (the case) and what the model answered. */
  input?: string;
  reply?: string;
  /** The rule the AI reviewer graded by, when the check has it. */
  rule?: string;
  /** Your verdict, when you gave one. The reviewer's is not shown until you have graded them all. */
  yours?: 'pass' | 'fail';
}

export interface TrustState {
  run: string;
  evaluation?: string;
  /** The checks an AI reviewer graded in this run, and the one the sample is about. */
  metrics: string[];
  metric?: string;
  /** How many answers to grade, and how many you have. */
  target: number;
  graded: number;
  cases: TrustCase[];
  /** Said once enough are graded; before that, what to do next. */
  summary: string;
  done: boolean;
  /** Present once you have graded enough to compare. */
  agreement?: { n: number; agreed: number; percent: number; kappa?: number; verdict: MetricCalibration['verdict']; tooLenient: number; tooStrict: number; advice: string };
  /** The full calibration report of the check (disagreements, best pass mark …), only when done. */
  report?: MetricCalibration;
}

const stable = (id: string) => sha256Hex(id);

/** Up to `n` results: half the ones the reviewer passed, half the ones it failed (the rest when one side runs out), in a fixed order. */
function pick(results: Array<{ r: TestResult; c: CheckResult }>, n: number): Array<{ r: TestResult; c: CheckResult }> {
  const order = (xs: typeof results) => [...xs].sort((a, b) => stable(a.r.id).localeCompare(stable(b.r.id)));
  const passed = order(results.filter((x) => x.c.passed));
  const failed = order(results.filter((x) => !x.c.passed));
  const out: typeof results = [];
  for (let i = 0; out.length < n && (i < passed.length || i < failed.length); i++) {
    if (i < failed.length) out.push(failed[i]!);
    if (out.length < n && i < passed.length) out.push(passed[i]!);
  }
  // a fixed shuffle, so the verdicts do not alternate and give the reviewer's verdict away
  return order(out);
}

const percent = (a: number, n: number) => (n ? Math.round((a / n) * 100) : 0);

export async function trustReviewer(
  store: WorkspaceStore,
  i: { run: string; metric?: string; count?: number; /** Record your verdict on one answer first. */ label?: { result: string; verdict: 'pass' | 'fail' | null } },
): Promise<TrustState> {
  // "last" is the newest finished run, as everywhere
  if (i.run === 'last') i = { ...i, run: finishedRun(store, 'last').runId };
  const meta = readRunSummary(store, i.run);
  if (!meta) throw new ApsError('ValidationError', `No finished run ${i.run}`, { suggestions: ['Run the evaluation first (testpion eval run), then grade its answers.', '`testpion history list` shows the runs.'] });
  const target = Math.max(3, Math.min(50, Math.floor(i.count ?? TRUST_SAMPLE)));
  const all: Array<{ r: TestResult; c: CheckResult }> = [];
  const names = new Set<string>();
  for await (const r of runResults(store, i.run))
    for (const c of r.checks)
      if (gradedByReviewer(c) && !(c.metadata as { na?: unknown } | undefined)?.na) {
        names.add(keyOf(c));
        all.push({ r, c });
      }
  const metrics = [...names];
  const base = { run: i.run, evaluation: meta.name, metrics, target };
  if (!metrics.length)
    return { ...base, graded: 0, cases: [], summary: 'This run has no check that an AI reviewer graded, so there is nothing to compare with. Add a check “Graded by an AI reviewer” and run again.', done: false };
  const metric = i.metric && names.has(i.metric) ? i.metric : metrics[0]!;
  if (i.metric && !names.has(i.metric)) throw new ApsError('ValidationError', `This run has no AI reviewer check "${i.metric}"`, { suggestions: [`Its AI reviewer checks: ${metrics.join(', ')}`] });
  const labels = defaultLabelsName(store, i.run);
  if (i.label) {
    if (i.label.verdict === null) {
      clearLabel(store, labels, recordOfResult(i.label.result), metric);
    } else await labelResult(store, { run: i.run, result: i.label.result, metric, label: i.label.verdict });
  }
  let mine = new Map<string, 'pass' | 'fail'>();
  try {
    mine = new Map(readLabels(store, labels).labels.filter((l) => l.metric === metric).map((l) => [l.record, l.label]));
  } catch {
    /* no labels yet */
  }
  const chosen = pick(all.filter((x) => keyOf(x.c) === metric), target);
  const cases: TrustCase[] = chosen.map(({ r, c }) => ({
    resultId: r.id,
    ...(r.input ? { input: r.input } : {}),
    ...(r.output ? { reply: r.output } : {}),
    ...(typeof (c.metadata as { criteria?: unknown } | undefined)?.criteria === 'string' ? { rule: (c.metadata as { criteria: string }).criteria } : {}),
    ...(mine.has(recordOfResult(r.id)) ? { yours: mine.get(recordOfResult(r.id)) } : {}),
  }));
  const graded = cases.filter((c) => c.yours).length;
  const need = Math.min(target, cases.length);
  if (graded < need) {
    const left = need - graded;
    return { ...base, metric, graded, cases, done: false, summary: graded ? `${graded} of ${need} graded. Grade ${left} more to see how often the AI reviewer agrees with you.` : `Read each answer and say whether it is good (pass) or bad (fail). The AI reviewer’s verdict is hidden until you have graded ${need}.` };
  }
  const report = await calibrateRun(store, { run: i.run, labels, metrics: [metric], tune: true });
  const m = report.metrics.find((x) => x.metric === metric);
  if (!m) return { ...base, metric, graded, cases, done: true, summary: 'Your verdicts could not be compared with the AI reviewer’s (the answers changed since you graded them). Grade them again.' };
  const a = m.agreement;
  const agreed = a.confusion.tp + a.confusion.tn;
  const pct = percent(agreed, a.n);
  const summary = `The AI reviewer agreed with you on ${agreed} of ${a.n} answers (${pct} %).${a.confusion.fp ? ` It passed ${a.confusion.fp} that you failed (too lenient).` : ''}${a.confusion.fn ? ` It failed ${a.confusion.fn} that you passed (too strict).` : ''}`;
  return {
    ...base,
    metric,
    graded,
    cases,
    done: true,
    summary,
    agreement: { n: a.n, agreed, percent: pct, ...(a.kappa !== undefined ? { kappa: a.kappa } : {}), verdict: m.verdict, tooLenient: a.confusion.fp, tooStrict: a.confusion.fn, advice: m.advice },
    report: m,
  };
}
