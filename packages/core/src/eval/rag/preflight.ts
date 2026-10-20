/**
 * Before a RAG evaluation starts (planning/rag-testing.md §4c, "no silent judge"): everything that would make it fail on
 * the first sample is found now, once, with what to configure — the target, and a usable judge when any metric needs one.
 */
import { ApsError } from '../../errors.js';
import type { SavedEvaluation } from '../../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { assertJudgeUsable, type RagJudgeHost } from './judge.js';
import { JUDGED_CHECK_TYPES } from './metrics.js';
import { targetProblems } from './run-target.js';
import { findRagTarget } from './targets.js';

export interface EvaluationPlan {
  /** The judged metrics among the evaluators. */
  judged: string[];
  /** The judge they will use (undefined when no metric needs one). */
  judge?: { provider: string; model: string };
  target?: { name: string; protocol: string };
}

/** Throws the setup error (a missing target or judge) before a run is started; otherwise says what the run will use. */
export function assertEvaluationRunnable(store: WorkspaceStore, host: RagJudgeHost, d: SavedEvaluation): EvaluationPlan {
  const plan: EvaluationPlan = { judged: [...new Set((d.evaluators ?? []).map((e) => e.type).filter((t) => JUDGED_CHECK_TYPES.has(t)))] };
  if (d.type === 'rag' && d.target) {
    const t = findRagTarget(store, d.target);
    const problems = targetProblems(t);
    if (problems.length) throw new ApsError('ConfigurationError', `The RAG target "${t.name}" cannot be called: ${problems[0]}`, { suggestions: problems.slice(1).concat(['Fix it in AI Lab ▸ RAG.']) });
    plan.target = { name: t.name, protocol: t.protocol };
  } else if (plan.judged.length) {
    throw new ApsError('ConfigurationError', `${plan.judged.join(', ')} judge the answer against the retrieved contexts of a RAG target, and this evaluation has no target`, { suggestions: ['Choose a RAG target for the evaluation (Evaluations ▸ RAG target), or remove the judged metrics.'] });
  }
  if (plan.judged.length) plan.judge = assertJudgeUsable(host, { provider: d.judge?.provider, model: d.judge?.model });
  return plan;
}
