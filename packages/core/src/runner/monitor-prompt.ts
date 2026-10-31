/**
 * A prompt or agent evaluation as a monitor: the saved evaluation run on a schedule, to notice when the model behind it, a prompt
 * edit or a provider change makes it worse (a hosted model can change without a word). The run is recorded like any other; the monitor
 * fails when a case fails, and, with `baseline: previous`, when the pass rate fell more than `maxDrop` (default 0.1) against the
 * monitor's run before.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Monitor } from './monitors.js';
import type { RunEvent } from './runner.js';
import { runTests } from './runner.js';
import type { RunSummary } from '../model/types.js';
import type { ExecServices } from './execute.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';
import { readRunSummary, recordRun } from './run-records.js';
import { evaluationTests, findSavedEvaluation } from './saved-evaluations.js';
import { MONITOR_RUN_PREFIX } from './result-source.js';

export interface PromptMonitorOutcome {
  summary: RunSummary;
  runId: string;
  /** Why the run fails though its cases passed: "pass rate 70% fell 20 points against run-x (90%)". */
  gateReasons: string[];
}

const passRate = (s: Pick<RunSummary, 'passed' | 'total' | 'skipped'>) => (s.total - s.skipped > 0 ? s.passed / (s.total - s.skipped) : undefined);

/** The pass rate of the monitor's run before this one (a finished run of the same name with cases). */
function previousRate(store: WorkspaceStore, name: string, current: string): { runId: string; rate: number } | undefined {
  for (const m of store.meta.listRuns({ query: name, limit: 20 }).items) {
    if (m.name !== name || m.id === current) continue;
    const s = readRunSummary(store, m.id);
    const rate = s && !s.cancelled ? passRate(s) : undefined;
    if (rate !== undefined) return { runId: m.id, rate };
  }
  return undefined;
}

export async function runMonitorPromptEvaluation(o: {
  store: WorkspaceStore;
  monitor: Monitor;
  signal?: AbortSignal;
  context: (c: { environment?: string }) => { services: ExecServices; dispose(): Promise<void> };
  onEvent?: (e: RunEvent) => void;
  onTrace?: (t: Parameters<WorkspaceStore['saveTrace']>[0], runId: string) => void;
}): Promise<PromptMonitorOutcome> {
  const { store, monitor } = o;
  const saved = findSavedEvaluation(store, monitor.evaluation!);
  const runId = shortId('run-');
  const name = `${MONITOR_RUN_PREFIX}${monitor.name}`;
  const dir = store.runDir(runId);
  mkdirSync(dir, { recursive: true });
  const ctx = o.context({ environment: monitor.environment });
  let summary: RunSummary;
  try {
    summary = await runTests({
      name,
      runId,
      tests: evaluationTests({ ...saved, name, ...(monitor.limit ? { limit: monitor.limit } : {}) }, { store }),
      concurrency: saved.concurrency ?? 4,
      retries: saved.retries ?? 0,
      services: ctx.services,
      signal: o.signal,
      resultsFile: join(dir, 'results.jsonl'),
      traceMode: 'failures',
      ...(o.onTrace ? { onTrace: (t: Parameters<WorkspaceStore['saveTrace']>[0]) => o.onTrace!(t, runId) } : { onTraceBatch: (batch: Array<{ trace: Parameters<WorkspaceStore['saveTrace']>[0] }>) => store.saveTraces(batch.map((b) => ({ trace: b.trace, kind: 'test', runId }))) }),
      environment: monitor.environment,
      onEvent: o.onEvent,
    });
  } finally {
    await ctx.dispose();
  }
  await recordRun(store, summary, dir, { reports: ['json', 'html'] });
  const gateReasons: string[] = [];
  if (monitor.baseline === 'previous') {
    const now = passRate(summary);
    const before = previousRate(store, name, runId);
    const allowed = monitor.maxDrop ?? 0.1;
    if (now !== undefined && before && before.rate - now > allowed) {
      gateReasons.push(`pass rate ${Math.round(now * 100)}% fell ${Math.round((before.rate - now) * 100)} points against ${before.runId} (${Math.round(before.rate * 100)}%)`);
    }
  }
  return { summary, runId, gateReasons };
}
