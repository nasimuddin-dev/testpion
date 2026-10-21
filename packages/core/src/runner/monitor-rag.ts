/**
 * A RAG evaluation as a monitor (a nightly check of a system in production): the saved evaluation judged on a sample of its
 * records, within a per-run and a per-day judge budget, then its gates and its regression gate against an earlier run. The
 * run is recorded like any other; what the alert and the monitor's result say about it (`MonitorRagInfo`) is built here.
 *
 *  - ROTATING SAMPLE: `rotate` scores `limit` records chosen by the UTC date, so a month of nightly runs covers the dataset and a
 *    night can be reproduced from its date (eval/rag/trend/rotate.ts).
 *  - BUDGETS: a run stops judging at `maxCostUsd`, and for the day at `judgeBudgetUsdPerDay`; what the judge did not get to is
 *    n/a ("budget"), never a failed gate, and the result says how many scores that was.
 *  - REGRESSION GATE: `baseline` (`previous`, `best` or a run id) with `maxDrop` (default 0.05) goes through the paired
 *    comparison of `testpion rag compare`, so one unlucky sample does not wake anyone but a real drop does.
 */
import type { SavedEvaluation } from './saved-evaluations.js';
import type { Monitor } from './monitors.js';
import type { RunEvent } from './runner.js';
import type { RunSummary } from '../model/types.js';
import type { ExecServices } from './execute.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { aiUsageSummary } from '../storage/ai-usage.js';
import { parseRagDatasetText, stringifyRagRecords } from '../eval/rag/dataset-formats.js';
import { buildMetricMatrix, checkGates } from '../eval/rag/metric-matrix.js';
import { compareMetricRuns } from '../eval/rag/metric-compare.js';
import { regressionLines, regressionMarkdown } from '../eval/rag/trend/markdown.js';
import { rotatingIndexes, utcDay } from '../eval/rag/trend/rotate.js';
import { ApsError } from '../errors.js';
import { chooseRagRun, runRagEvaluation } from './rag-evaluation.js';
import { runResults } from './run-results.js';
import { findSavedEvaluation } from './saved-evaluations.js';
import { MONITOR_RUN_PREFIX } from './result-source.js';
import { ragTrend } from './rag-trend.js';

/** What a RAG monitor run says beyond pass or fail (kept with the monitor's result; the alert quotes it). */
export interface MonitorRagInfo {
  /** The sample of a rotating run: "day 20746: 40 of 400 records". */
  sample?: string;
  /** The judge stopped at a budget: how many scores are n/a for that reason, and which budget. */
  budget?: string;
  /** What the judging of this run cost (USD). */
  judgeCostUsd?: number;
  /** The run it was compared with. */
  baseline?: string;
  /** One line per metric that regressed against it. */
  regressions?: string[];
  /** The metric means, one line each, for an alert. */
  means: string[];
  /** The regression table as Markdown (the pull-request comment's). */
  table?: string;
}

export interface RagMonitorOutcome {
  summary: RunSummary;
  runId: string;
  gateReasons: string[];
  rag: MonitorRagInfo;
}

/** The evaluation with its dataset cut to today's rotating sample (positional ids are kept: a record keeps its id on every night). */
export function rotateEvaluation(d: SavedEvaluation, n: number | undefined, day: number): { evaluation: SavedEvaluation; note: string } {
  const records = parseRagDatasetText(d.dataset ?? '', d.datasetFormat === 'json' || d.datasetFormat === 'csv' ? d.datasetFormat : 'jsonl');
  const take = Math.max(1, Math.min(n ?? 50, records.length || 1));
  const picked = rotatingIndexes(records.length, take, day).map((i) => ({ id: String(i + 1), ...records[i]! }));
  const { limit: _limit, ...rest } = d;
  return { evaluation: { ...rest, dataset: stringifyRagRecords(picked), datasetFormat: 'jsonl' }, note: `day ${day}: ${picked.length} of ${records.length} records` };
}

/** The run to compare with: the last earlier run of this monitor, the best of the recent ones, or a run named by id. */
async function baselineRun(store: WorkspaceStore, monitor: Monitor, current: string): Promise<string | undefined> {
  const b = monitor.baseline;
  if (!b) return undefined;
  const name = `${MONITOR_RUN_PREFIX}${monitor.name}`;
  if (b !== 'previous' && b !== 'best') return b;
  if (b === 'previous') return store.meta.listRuns({ limit: 100 }).items.find((r) => r.name === name && r.id !== current)?.id;
  const t = await ragTrend(store, { runIds: store.meta.listRuns({ limit: 100 }).items.filter((r) => r.name === name && r.id !== current).slice(0, 30).map((r) => r.id) });
  const score = (p: (typeof t.points)[number]) => {
    const ms = Object.values(p.metrics).flatMap((m) => (m.mean === undefined ? [] : [m.mean]));
    return ms.length ? ms.reduce((s, x) => s + x, 0) / ms.length : -1;
  };
  return [...t.points].sort((x, y) => score(y) - score(x))[0]?.runId;
}

export async function runMonitorEvaluation(o: { store: WorkspaceStore; monitor: Monitor; signal?: AbortSignal; context: (c: { environment?: string }) => { services: ExecServices; dispose(): Promise<void> }; onEvent?: (e: RunEvent) => void; now?: Date }): Promise<RagMonitorOutcome> {
  const { store, monitor } = o;
  const saved = findSavedEvaluation(store, monitor.evaluation!);
  // what the judge may still spend today: the budget less what the ledger holds for the judge in the last day
  const spent = monitor.judgeBudgetUsdPerDay !== undefined ? (aiUsageSummary(store, { days: 1 }).byTask.find((t) => t.task === 'rag-judge')?.costUsd ?? 0) : 0;
  const left = monitor.judgeBudgetUsdPerDay !== undefined ? Math.max(0, monitor.judgeBudgetUsdPerDay - spent) : undefined;
  const cap = left === undefined ? monitor.maxCostUsd : monitor.maxCostUsd === undefined ? left : Math.min(left, monitor.maxCostUsd);
  const day = utcDay(o.now ?? new Date());
  const rotated = monitor.rotate ? rotateEvaluation(saved, monitor.limit, day) : undefined;
  const base = { ...(rotated?.evaluation ?? saved), name: `${MONITOR_RUN_PREFIX}${monitor.name}` };
  const d = chooseRagRun(base, { ...(rotated ? {} : { limit: monitor.limit }), ...(cap !== undefined ? (cap > 0 ? { maxJudgeCostUsd: cap } : { maxJudgeCalls: 0 }) : {}) });
  if (monitor.judgeSample !== undefined) d.judge = { ...(d.judge ?? {}), sampleShare: monitor.judgeSample };
  const out = await runRagEvaluation({ store, makeContext: () => o.context({ environment: monitor.environment }), evaluation: d, environment: monitor.environment, signal: o.signal, reports: ['json', 'html'], onResult: (r) => o.onEvent?.({ type: 'test-end', result: r } as RunEvent) });
  const matrix = await buildMetricMatrix(runResults(store, out.runId), { runId: out.runId, limit: 1 });
  const gateReasons = checkGates(matrix, monitor.gates ?? {}).filter((g) => !g.passed).map((g) => g.why);

  let budgetNa = 0;
  for await (const r of runResults(store, out.runId)) for (const c of r.checks ?? []) if ((c.metadata as { na?: string } | undefined)?.na === 'budget') budgetNa++;
  const judgeCostUsd = out.summary.judgeCostUsd;
  const rag: MonitorRagInfo = {
    ...(rotated ? { sample: rotated.note } : {}),
    ...(budgetNa ? { budget: `the judge stopped at its budget: ${budgetNa} score${budgetNa === 1 ? ' is' : 's are'} n/a (not counted as a failure)` } : {}),
    ...(judgeCostUsd ? { judgeCostUsd } : {}),
    means: matrix.aggregates.filter((a) => a.mean !== undefined).map((a) => `${a.key} ${a.mean} (n ${a.n}${a.naCount ? `, ${a.naCount} n/a` : ''})`),
  };
  const baseId = await baselineRun(store, monitor, out.runId);
  if (monitor.baseline && !baseId) rag.baseline = 'none yet (this is the first run to compare with)';
  if (baseId) {
    try {
      const cmp = await compareMetricRuns(runResults(store, out.runId), runResults(store, baseId), { minDelta: monitor.maxDrop ?? 0.05 });
      rag.baseline = baseId;
      rag.regressions = regressionLines(cmp);
      rag.table = regressionMarkdown(cmp, { baseline: baseId, judge: d.judge?.provider ? `${d.judge.provider}/${d.judge.model ?? ''}` : undefined, costUsd: judgeCostUsd, maxDrop: monitor.maxDrop ?? 0.05 });
      for (const l of rag.regressions) gateReasons.push(`regressed against ${baseId}: ${l}`);
    } catch (e) {
      if (!(e instanceof ApsError)) throw e;
      rag.baseline = `${baseId} (could not compare: ${e.message})`;
    }
  }
  // the trend is cached from the run on, so Needs attention can say "faithfulness dropped over 3 nights" without scanning results
  await ragTrend(store, { evaluation: monitor.evaluation, runs: 5 }).catch(() => undefined);
  return { summary: out.summary, runId: out.runId, gateReasons, rag };
}
