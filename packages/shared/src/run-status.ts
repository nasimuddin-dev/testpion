/**
 * How a run of a flow went, the same everywhere (the engine, the CLI, the MCP tools and the app's window): failed (a
 * step failed or errored), cancelled, skipped (nothing ran: every step was skipped, e.g. it depends on a step in
 * another file), else passed. A run where nothing ran is never reported as passed.
 */
export type FlowRunStatus = 'passed' | 'failed' | 'cancelled' | 'skipped';

/** The status of one run of a flow from its steps' results. */
export function flowRunStatus(steps: ReadonlyArray<{ status: string }>, cancelled?: boolean): FlowRunStatus {
  if (cancelled) return 'cancelled';
  if (steps.some((s) => s.status === 'failed' || s.status === 'error')) return 'failed';
  return steps.some((s) => s.status === 'passed') ? 'passed' : 'skipped';
}

/**
 * The status of a data run (rows) or an environment matrix (environments) from its counts: skipped when no row /
 * environment passed or failed and some skipped.
 */
export function scaleRunStatus(r: { kind: 'data' | 'matrix'; passed: number; failed: number; skipped?: number; cancelled?: number; stopped?: boolean; bailed?: boolean }): FlowRunStatus {
  const nothingRan = !r.passed && !r.failed && (r.skipped ?? 0) > 0;
  if (r.kind === 'data') return r.stopped ? 'cancelled' : r.failed ? 'failed' : r.cancelled && !r.bailed ? 'cancelled' : nothingRan ? 'skipped' : 'passed';
  return r.failed ? 'failed' : nothingRan ? 'skipped' : 'passed';
}
