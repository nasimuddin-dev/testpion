/**
 * Running a RAG evaluation as a whole, for every host (`testpion rag run`, the MCP `rag_run`, the app's Run): the metrics
 * and the judge are chosen, the target and the judge are checked before a question is sent, the estimate says what it will
 * cost, the run is recorded, and a "two-phase" run (collect the answers with the free metrics, then judge them) is a run
 * followed by a re-score of that run, so a judge can be changed or a metric added afterwards without calling the system
 * again.
 */
import type { RagJudgeSetup } from '@testpion/shared';
import { datasetFormatOf, previewDatasetRecords } from '@testpion/shared';
import type { CheckConfig, RunSummary, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { EngineContext } from '../engine.js';
import { findPreset, presetChecks } from '../eval/rag/catalogue-presets.js';
import { estimateRagRun, estimateRagRunExact, type RunEstimate } from '../eval/rag/estimate.js';
import { buildMetricMatrix, type MetricMatrix } from '../eval/rag/metric-matrix.js';
import { metricToCheck, resolveMetric } from '../eval/rag/metric-registry.js';
import { assertEvaluationRunnable } from '../eval/rag/preflight.js';
import { needsJudgeService } from '../eval/rag/metrics-judged.js';
import type { TrySample } from '../eval/rag/try-metric.js';
import type { ReportFormat } from '../report/reports.js';
import { shortId } from '../util/ids.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { recordRun } from './run-records.js';
import { runResults } from './run-results.js';
import { rescoreRun, storedSample } from './rag-rescore.js';
import { evaluationTests, judgeSetupOf, type SavedEvaluation } from './saved-evaluations.js';
import { runTests } from './runner.js';
import { join } from 'node:path';

/** What a caller may change about a saved evaluation for one run, without saving it. */
export interface RagRunChoices {
  /** Metric names (ids, aliases, Ragas names, `recall@5`) replacing the evaluation's evaluators. */
  metrics?: string[];
  /** A metric preset (catalogue-presets.ts), added to `metrics`. */
  preset?: string;
  target?: string;
  judge?: string | { provider?: string; model?: string };
  judges?: string[];
  aggregate?: RagJudgeSetup['aggregate'];
  swap?: boolean;
  repeat?: number;
  shortCircuit?: boolean;
  shareClaims?: boolean;
  maxJudgeCostUsd?: number;
  maxJudgeCalls?: number;
  limit?: number;
}

const refOf = (j: string): { provider: string; model?: string } => {
  const parts = j.split('/');
  return { provider: parts[0]!, ...(parts.length > 1 ? { model: parts.slice(1).join('/') } : {}) };
};

/** The evaluation with the run's choices applied (a copy; the saved one is never changed). */
export function chooseRagRun(d: SavedEvaluation, c: RagRunChoices): SavedEvaluation {
  const out: SavedEvaluation = { ...d, judge: { ...(d.judge ?? {}) } };
  let evaluators = d.evaluators;
  if (c.metrics?.length || c.preset) {
    const unknown = (c.metrics ?? []).filter((m) => !resolveMetric(m));
    if (unknown.length) throw new ApsError('ValidationError', `No RAG metric called ${unknown.map((u) => `"${u}"`).join(', ')}`, { suggestions: ['List them with `testpion rag metrics` (an id, an alias or a Ragas name works).'] });
    const preset = c.preset ? findPreset(c.preset) : undefined;
    if (c.preset && !preset) throw new ApsError('ValidationError', `No metric preset "${c.preset}"`, { suggestions: ['List them with `testpion rag presets`.'] });
    evaluators = [...(preset ? presetChecks(preset.metrics) : []), ...(c.metrics ?? []).map((m) => metricToCheck(m))];
  }
  out.evaluators = evaluators;
  if (c.target) out.target = c.target;
  if (c.limit) out.limit = c.limit;
  if (c.judge) out.judge = { ...out.judge, ...(typeof c.judge === 'string' ? refOf(c.judge) : c.judge) };
  if (c.judges?.length) out.judge = { ...out.judge, judges: c.judges.map(refOf) };
  for (const k of ['aggregate', 'swap', 'repeat', 'shortCircuit', 'shareClaims'] as const) if (c[k] !== undefined) (out.judge as Record<string, unknown>)[k] = c[k];
  if (c.maxJudgeCostUsd !== undefined) out.maxJudgeCostUsd = c.maxJudgeCostUsd;
  if (c.maxJudgeCalls !== undefined) out.maxJudgeCalls = c.maxJudgeCalls;
  return out;
}

/** Estimate a saved evaluation before it runs (nothing is sent to the judge; `probe` makes ONE call to the system for a typical sample). */
export async function estimateRagEvaluation(store: WorkspaceStore, ctx: EngineContext, d: SavedEvaluation, o: { probe?: (question: string) => Promise<TrySample> } = {}): Promise<RunEstimate> {
  const format = datasetFormatOf(d.dataset ?? '', d.datasetFormat ?? 'jsonl');
  const all = previewDatasetRecords(d.dataset ?? '', format, Number.MAX_SAFE_INTEGER);
  const samples = d.limit ? Math.min(d.limit, all.length) : all.length;
  const tok = (v: unknown) => Math.ceil(String(v ?? '').length / 4);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const rows = all.slice(0, Math.min(samples, 200));
  const shape: Record<string, number> = {};
  const q = mean(rows.map((r) => tok(r.question ?? r.query ?? r.input ?? r.user_input)));
  const ref = mean(rows.map((r) => tok(r.reference ?? r.expected ?? r.ground_truth ?? r.expected_output)));
  if (q) shape.questionTokens = q;
  if (ref) shape.referenceTokens = ref;
  let probed: TrySample | undefined;
  if (o.probe && rows.length) {
    probed = await o.probe(String(rows[0]!.question ?? rows[0]!.query ?? rows[0]!.input ?? rows[0]!.user_input ?? ''));
    shape.answerTokens = tok(probed.answer);
    shape.contextTokens = (probed.contexts ?? []).reduce((a, c) => a + tok(c.text), 0);
    shape.contexts = probed.contexts?.length ?? 0;
  }
  const est = estimateRagRun(ctx.services.ragJudge!, store, { evaluators: d.evaluators ?? [], samples, judge: judgeSetupOf(d), shape, shapeFrom: probed ? 'probe' : 'dataset', hasTarget: d.type === 'rag' && !!d.target });
  return est;
}

/** Estimate re-scoring a finished run: every judge prompt is built for the stored samples, so calls, tokens and cache hits are exact. */
export async function estimateRescore(store: WorkspaceStore, ctx: EngineContext, runId: string, evaluators: CheckConfig[], judge?: RagJudgeSetup): Promise<RunEstimate> {
  const stored: TrySample[] = [];
  for await (const r of runResults(store, runId)) {
    const s = storedSample(r);
    if (s) stored.push(s);
  }
  if (!stored.length) throw new ApsError('ValidationError', `The run ${runId} holds no stored RAG samples to re-score`, { suggestions: ['Only runs of a RAG evaluation with a target keep the answers they captured.'] });
  return estimateRagRunExact(ctx.services.ragJudge!, store, { evaluators, samples: stored.length, judge, stored });
}

export interface RagRunOptions {
  store: WorkspaceStore;
  /** A fresh engine context (the host's secrets, environment and surface); disposed here. */
  makeContext(): Pick<EngineContext, 'services' | 'dispose'>;
  evaluation: SavedEvaluation;
  concurrency?: number;
  retries?: number;
  twoPhase?: boolean;
  reports?: ReportFormat[];
  outDir?: string;
  environment?: string;
  signal?: AbortSignal;
  onResult?(r: TestResult): void;
  onPhase?(p: 'run' | 'collect' | 'judge'): void;
}

export interface RagRunOutcome {
  runId: string;
  summary: RunSummary;
  outDir: string;
  resultsFile: string;
  reports: Partial<Record<ReportFormat, string>>;
  /** Two-phase: the run that collected the answers. */
  collectRunId?: string;
  matrix: MetricMatrix;
}

export async function runRagEvaluation(o: RagRunOptions): Promise<RagRunOutcome> {
  const d = o.evaluation;
  const judge = judgeSetupOf(d);
  const ctx = o.makeContext();
  try {
    // never a silent judge, and never a question sent to a target that cannot be called
    assertEvaluationRunnable(o.store, ctx.services.ragJudge!, d);
    const free = (d.evaluators ?? []).filter((e) => !needsJudgeService(e.type, !!d.target));
    const phased = !!o.twoPhase && free.length < (d.evaluators ?? []).length;
    const phaseOne: SavedEvaluation = phased ? { ...d, evaluators: free.length ? free : [{ type: 'latency', max: 3_600_000, name: 'collected' }] } : d;
    const runId = shortId('run-');
    const outDir = phased ? o.store.runDir(runId) : (o.outDir ?? o.store.runDir(runId));
    const resultsFile = join(outDir, 'results.jsonl');
    o.onPhase?.(phased ? 'collect' : 'run');
    const summary = await runTests({
      name: d.name,
      runId,
      tests: evaluationTests(phaseOne, { store: o.store }),
      concurrency: o.concurrency ?? d.concurrency ?? 4,
      retries: o.retries ?? d.retries ?? 0,
      services: ctx.services,
      resultsFile,
      traceMode: 'none',
      environment: o.environment,
      signal: o.signal,
      onEvent: (e) => void (e.type === 'test-end' && o.onResult?.(e.result)),
    });
    if (!phased) {
      const reports = await recordRun(o.store, summary, outDir, { reports: o.reports });
      return { runId, summary, outDir, resultsFile, reports, matrix: await buildMetricMatrix(runResults({ runDir: () => outDir }, runId), { runId, limit: 1 }) };
    }
    await recordRun(o.store, summary, outDir);
    o.onPhase?.('judge');
    const second = await rescoreRun(o.store, { runId, evaluators: d.evaluators, judge, providers: ctx.services.providers, ragJudge: ctx.services.ragJudge!, signal: o.signal, reports: o.reports, name: d.name });
    const finalDir = o.store.runDir(second.runId);
    return { runId: second.runId, summary: second.summary, outDir: finalDir, resultsFile: join(finalDir, 'results.jsonl'), reports: second.reports, collectRunId: runId, matrix: await buildMetricMatrix(runResults(o.store, second.runId), { runId: second.runId, limit: 1 }) };
  } finally {
    await ctx.dispose();
  }
}
