/** Evaluator scores run by run: is the model, prompt or pipeline getting better or worse? */
import type { WorkspaceStore } from '../storage/workspace.js';
import { readRunSummary } from './run-records.js';

export interface ScoreTrendPoint {
  runId: string;
  name: string;
  startedAt: string;
  /** Mean score (0 to 1) per evaluator (check type) in the run. */
  scores: Record<string, number>;
}

/**
 * The mean score of each evaluator in the latest runs that have scores, oldest first. `runIds` limits it to those runs;
 * `name` to runs whose name contains it.
 */
export function scoreTrend(store: WorkspaceStore, opts: { runIds?: string[]; name?: string; limit?: number } = {}): ScoreTrendPoint[] {
  const wanted = opts.runIds ? new Set(opts.runIds) : undefined;
  const runs = store.meta.listRuns({ limit: Math.min(Math.max(opts.limit ?? 40, 1), 300) * (wanted ? 1 : 3) }).items;
  const out: ScoreTrendPoint[] = [];
  for (const r of runs) {
    if (wanted && !wanted.has(r.id)) continue;
    if (opts.name && !r.name.toLowerCase().includes(opts.name.toLowerCase())) continue;
    try {
      const s = readRunSummary(store, r.id);
      if (!s) continue;
      const scores = Object.fromEntries(Object.entries(s.scores ?? {}).map(([k, v]) => [k, Math.round(v.mean * 1000) / 1000]));
      if (Object.keys(scores).length) out.push({ runId: r.id, name: r.name, startedAt: r.startedAt, scores });
    } catch {
      /* a run being written */
    }
    if (out.length >= (opts.limit ?? 40)) break;
  }
  return out.reverse();
}
