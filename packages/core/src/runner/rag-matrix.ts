/**
 * The metrics matrix of a finished run for a host that cuts it many times (the window pages, sorts, filters and edits pass
 * marks; every cut used to read results.jsonl again and rebuild every column, interval and tag mean: 1.2 to 1.5 s at 5,000
 * samples × 84 metrics each time). The expensive part (eval/rag/metric-matrix.ts `buildMatrixBase`) is kept per run and per
 * state of its results file, a few runs at a time; a cut is then milliseconds.
 */
import { existsSync, statSync } from 'node:fs';
import type { WorkspaceStore } from '../storage/workspace.js';
import { buildMatrixBase, buildMetricMatrix, cutMatrix, matrixIntervals, type MatrixBase, type MatrixQuery, type MetricMatrix } from '../eval/rag/metric-matrix.js';
import { runResults, runResultsFile } from './run-results.js';

const KEEP = 4;
const bases = new Map<string, { stamp: string; base: Promise<MatrixBase> }>();

/** The base of a run (built once while its results file stays as it is). */
export function ragMatrixBase(store: Pick<WorkspaceStore, 'runDir'>, runId: string): Promise<MatrixBase> {
  const file = runResultsFile(store, runId);
  if (!existsSync(file)) return buildMatrixBase(runResults(store, runId));
  const st = statSync(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = bases.get(file);
  if (hit && hit.stamp === stamp) {
    // most recently used last
    bases.delete(file);
    bases.set(file, hit);
    return hit.base;
  }
  const base = buildMatrixBase(runResults(store, runId));
  bases.set(file, { stamp, base });
  // a failed build is not kept
  base.catch(() => bases.get(file)?.base === base && bases.delete(file));
  while (bases.size > KEEP) bases.delete(bases.keys().next().value!);
  return base;
}

/** The matrix of a run cut by `q`; the intervals are left out with `ci: false` (ask for the visible columns' with `ragMatrixIntervals`). */
export async function ragMatrix(store: Pick<WorkspaceStore, 'runDir'>, runId: string, q: MatrixQuery = {}): Promise<MetricMatrix> {
  // scores of another tool are laid beside this run's columns: that is a different matrix, not a cut of the kept one
  if (q.external) return buildMetricMatrix(runResults(store, runId), { ...q, runId });
  return cutMatrix(await ragMatrixBase(store, runId), { ...q, runId });
}

/** The 95% intervals of some columns of a run's matrix (computed once each, then kept with the base). */
export async function ragMatrixIntervals(store: Pick<WorkspaceStore, 'runDir'>, runId: string, keys: string[]): Promise<Record<string, [number, number]>> {
  return matrixIntervals(await ragMatrixBase(store, runId), keys.slice(0, 200));
}
