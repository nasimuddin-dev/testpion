/**
 * Before a RAG evaluation starts (planning/rag-testing.md §4c, "no silent judge"): everything that would make it fail on
 * the first sample is found now, once, with what to configure — the target, and a usable judge when any metric needs one.
 */
import { ApsError } from '../../errors.js';
import type { SavedEvaluation } from '../../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { assertJudgeUsable, type RagJudgeHost } from './judge.js';
import { evaluatorsNeedJudge } from './score.js';
import { targetProblems } from './run-target.js';
import { findRagTarget } from './targets.js';
import { routeProblems } from './route.js';
import { assertSqlProduction } from './metrics-sql.js';
import { resolveMetric } from './metric-registry.js';

export interface EvaluationPlan {
  /** The judged metrics among the evaluators. */
  judged: string[];
  /** The judge they will use (undefined when no metric needs one). */
  judge?: { provider: string; model: string };
  target?: { name: string; protocol: string };
}

/** Throws the setup error (a missing target or judge) before a run is started; otherwise says what the run will use. */
export function assertEvaluationRunnable(store: WorkspaceStore, host: RagJudgeHost, d: SavedEvaluation): EvaluationPlan {
  // the branches of a decision tree (`when` / `unless`) must be readable and not circular, before anything is asked
  const route = routeProblems(d.evaluators ?? []);
  if (route.length) throw new ApsError('ValidationError', `The metrics of this evaluation have a problem in their conditions: ${route[0]}`, { suggestions: route.slice(1).concat(['Write a condition as "faithfulness < 0.8", "faithfulness passes" or "faithfulness fails"; a metric it names must be in the evaluation.']) });
  // a production database: asked once, before the first question, like a run against a production environment
  if (d.database?.production === true && (d.evaluators ?? []).some((e) => ['datacompy-score', 'sql-equivalence'].includes(resolveMetric(e.type)?.def.id ?? e.type))) assertSqlProduction(d.database, `Run ${d.name}: the SQL the system writes runs against it`);
  const plan: EvaluationPlan = { judged: evaluatorsNeedJudge(d.evaluators ?? [], d.type === 'rag' && !!d.target) };
  if (d.type === 'rag' && d.target) {
    const t = findRagTarget(store, d.target);
    const problems = targetProblems(t);
    if (problems.length) throw new ApsError('ConfigurationError', `The RAG target "${t.name}" cannot be called: ${problems[0]}`, { suggestions: problems.slice(1).concat(['Fix it in AI Lab ▸ RAG.']) });
    plan.target = { name: t.name, protocol: t.protocol };
  } else if (plan.judged.length) {
    throw new ApsError('ConfigurationError', `${plan.judged.join(', ')} judge the answer against the retrieved contexts of a RAG target, and this evaluation has no target`, { suggestions: ['Choose a RAG target for the evaluation (Evaluations ▸ RAG target), or remove the judged metrics.'] });
  }
  if (plan.judged.length) {
    plan.judge = assertJudgeUsable(host, { provider: d.judge?.provider, model: d.judge?.model });
    // a jury is checked judge by judge, now, rather than at the first sample
    for (const j of d.judge?.judges ?? []) assertJudgeUsable(host, j);
  }
  return plan;
}
