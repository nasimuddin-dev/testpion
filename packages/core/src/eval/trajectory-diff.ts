/**
 * The golden trajectory (A-2): the tools an agent used in a run you trust (the baseline), against the tools it uses now. Per case:
 * the same tools in the same order, a tool dropped or added, the same tools in another order, or the same call with other
 * arguments. Pure over two trajectories, so the app, `testpion eval trajectory` and the MCP tool say the same words.
 */
import { ApsError } from '../errors.js';
import type { SavedEvaluation } from '../runner/saved-evaluations.js';
import { EVALUATIONS_LIBRARY, findSavedEvaluation } from '../runner/saved-evaluations.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Trajectory } from './trajectory.js';

export type TrajectoryChangeKind = 'same' | 'tools-changed' | 'reordered' | 'arguments-differ';

export interface TrajectoryChange {
  kind: TrajectoryChangeKind;
  /** The tools of the baseline and of this run, in the order they were called. */
  baseline: string[];
  now: string[];
  /** Tools this run called that the baseline did not (by count), and the other way round. */
  added: string[];
  dropped: string[];
  /** The same call (by position) with other arguments. */
  argumentsDiffer: Array<{ tool: string; baseline: Record<string, unknown>; now: Record<string, unknown> }>;
  /** One sentence: "Same tools in the same order." */
  text: string;
}

const calls = (t: Trajectory) => t.items.filter((i) => i.kind === 'tool' && i.tool).map((i) => i.tool!);
const count = (names: string[]) => names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>());
const minus = (a: string[], b: string[]) => {
  const left = count(b);
  const out: string[] = [];
  for (const n of a) {
    if ((left.get(n) ?? 0) > 0) left.set(n, left.get(n)! - 1);
    else out.push(n);
  }
  return out;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 70 ? `${s.slice(0, 69)}…` : s;
};
const path = (n: string[]) => (n.length ? n.join(' → ') : 'no tool');

/** How the tools of a run differ from the tools of the baseline's run, for one case. */
export function diffTrajectory(base: Trajectory, now: Trajectory): TrajectoryChange {
  const b = calls(base);
  const n = calls(now);
  const bn = b.map((c) => c.name);
  const nn = n.map((c) => c.name);
  const added = minus(nn, bn);
  const dropped = minus(bn, nn);
  const out = { baseline: bn, now: nn, added, dropped, argumentsDiffer: [] as TrajectoryChange['argumentsDiffer'] };
  if (added.length || dropped.length) {
    const parts = [dropped.length ? `Dropped ${[...new Set(dropped)].join(', ')}` : '', added.length ? `added ${[...new Set(added)].join(', ')}` : ''].filter(Boolean).join('; ');
    return { kind: 'tools-changed', ...out, text: `${parts}. Baseline: ${path(bn)}. Now: ${path(nn)}.` };
  }
  if (!same(bn, nn)) return { kind: 'reordered', ...out, text: `Same tools in another order. Baseline: ${path(bn)}. Now: ${path(nn)}.` };
  n.forEach((c, i) => {
    if (!same(c.arguments, b[i]!.arguments)) out.argumentsDiffer.push({ tool: c.name, baseline: b[i]!.arguments, now: c.arguments });
  });
  if (out.argumentsDiffer.length) {
    const first = out.argumentsDiffer[0]!;
    return { kind: 'arguments-differ', ...out, text: `Same tools in the same order, but ${first.tool} was called with other arguments: ${short(first.baseline)} → ${short(first.now)}${out.argumentsDiffer.length > 1 ? ` (and ${out.argumentsDiffer.length - 1} more)` : ''}.` };
  }
  return { kind: 'same', ...out, text: nn.length ? 'Same tools in the same order, with the same arguments.' : 'No tool was called, as in the baseline.' };
}

/** The baseline run of the evaluation a run belongs to, when it has one that is not this run. */
export function baselineOf(store: WorkspaceStore, runName: string, runId: string): string | undefined {
  try {
    const it = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY).items.find((i) => i.name === runName);
    const id = it?.data.baselineRun;
    return id && id !== runId ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Mark a run as the golden run of its saved evaluation (an agent evaluation), or clear it (`run: null`, by the evaluation's name or id). */
export function setEvaluationBaseline(store: WorkspaceStore, o: { run?: string; evaluation?: string; clear?: boolean }): { evaluation: string; baselineRun?: string } {
  let name = o.evaluation;
  let runId: string | undefined;
  if (!o.clear) {
    if (!o.run) throw new ApsError('ValidationError', 'Name the run to mark as the baseline (its id, "last" or an evaluation name)');
    const ref = resolveRunRef(store, o.run);
    const summary = readRunSummary(store, ref.runId);
    if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished: it cannot be the baseline yet`);
    runId = ref.runId;
    name ??= summary.name;
  }
  if (!name) throw new ApsError('ValidationError', 'Name the evaluation whose baseline to clear');
  const saved = findSavedEvaluation(store, name);
  if (saved.type !== 'agent') throw new ApsError('ValidationError', `"${saved.name}" is not an agent evaluation: only an agent has a trajectory to compare`, { suggestions: ['A baseline of tools is for evaluations of type agent.'] });
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  store.saveLibrary(EVALUATIONS_LIBRARY, {
    folders: lib.folders,
    items: lib.items.map((i) => {
      if (i.id !== saved.id) return i;
      const { baselineRun: _old, ...rest } = i.data;
      return { ...i, data: runId ? { ...rest, baselineRun: runId } : rest, updatedAt: new Date().toISOString() };
    }),
  });
  return { evaluation: saved.name, ...(runId ? { baselineRun: runId } : {}) };
}

