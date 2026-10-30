/** The trajectory of one case of a run, with how its tools differ from the baseline's (A-1, A-2). */
import { ApsError } from '../errors.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { evalCaseKey, findEvalResult } from './report.js';
import { trajectoryOf, type Trajectory } from './trajectory.js';
import { baselineOf, diffTrajectory, type TrajectoryChange } from './trajectory-diff.js';

export interface TrajectoryWithBaseline extends Trajectory {
  /** Against the baseline run of the evaluation (or `against`): the same case there, and how its tools differ. Absent when there is no baseline or it has no such case. */
  vsBaseline?: TrajectoryChange & { baselineRun: string };
}

/** The trajectory of one case of a run: the run (its id, "last" or an evaluation name) and the case (its result id, key or name). */
export async function evalTrajectory(store: WorkspaceStore, o: { run: string; case: string; against?: string }): Promise<TrajectoryWithBaseline> {
  const ref = resolveRunRef(store, o.run);
  const r = await findEvalResult(store, ref.runId, o.case);
  const t = trajectoryOf(r);
  if (!t) throw new ApsError('ValidationError', `Case ${o.case} is not an agent case: only an agent keeps the steps it took`, { suggestions: ['Take a case of an agent evaluation (testpion eval summary <run> --json lists the failed cases).'] });
  const against = o.against ? resolveRunRef(store, o.against).runId : baselineOf(store, readRunSummary(store, ref.runId)?.name ?? '', ref.runId);
  if (!against || against === ref.runId) return t;
  try {
    const base = trajectoryOf(await findEvalResult(store, against, evalCaseKey(r.id)));
    return base ? { ...t, vsBaseline: { ...diffTrajectory(base, t), baselineRun: against } } : t;
  } catch {
    // the baseline has no such case (a case added since): nothing to compare
    return t;
  }
}
