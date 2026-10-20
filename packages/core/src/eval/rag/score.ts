/**
 * Scoring one RAG sample with its metrics: the one function a run (execute.ts), a rescore of a stored run and "Try on
 * one sample" all use, so a score is the same wherever it is computed. It tells the checks which metrics run beside them
 * (the shared claim pass), applies `shortCircuit` (a free retrieval gate that failed spares the judged answer metrics),
 * and classifies the failure.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { runChecks, type CheckContext } from '../checks.js';
import { classifyFailure, type RagFailure } from './failure.js';
import { canonicalMetricId, getMetric } from './metric-registry.js';
import { needsJudgeService } from './metrics-judged.js';

export interface ScoredSample {
  checks: CheckResult[];
  failure?: RagFailure;
}

/** The judged metrics that read the answer (the ones `shortCircuit` skips after a failed retrieval gate). */
const ANSWER_JUDGED = new Set(['faithfulness', 'answer-relevance']);
/** The free retrieval metrics that can fail the gate. */
const isGate = (id: string) => getMetric(id)?.group === 'retrieval-ir' || id === 'context-entity-recall';

export async function scoreRagSample(configs: CheckConfig[], ctx: CheckContext, o: { warnings?: string[] } = {}): Promise<ScoredSample> {
  const ids = configs.map((c) => canonicalMetricId(c.type));
  ctx.ragRun = { strict: true, metrics: ids };
  const short = ctx.judge?.shortCircuit === true;
  let checks: CheckResult[];
  if (short) {
    const free = configs.filter((c, i) => !ANSWER_JUDGED.has(ids[i]!));
    const gated = configs.filter((c, i) => ANSWER_JUDGED.has(ids[i]!));
    const freeResults = await runChecks(free, ctx);
    const gateFailed = freeResults.find((r, i) => !r.passed && isGate(canonicalMetricId(free[i]!.type)));
    const rest = gateFailed
      ? gated.map(
          (c): CheckResult => ({
            type: c.type,
            name: c.name ?? c.type,
            passed: true,
            source: 'ai-judge',
            message: `${canonicalMetricId(c.type)} is n/a: skipped because ${gateFailed.name} already failed (shortCircuit)`,
            metadata: { na: 'short-circuit', metric: canonicalMetricId(c.type), shortCircuit: gateFailed.name },
          }),
        )
      : await runChecks(gated, ctx);
    // back in the order the evaluation lists them
    const byConfig = new Map<CheckConfig, CheckResult>();
    free.forEach((c, i) => byConfig.set(c, freeResults[i]!));
    gated.forEach((c, i) => byConfig.set(c, rest[i]!));
    checks = configs.map((c) => byConfig.get(c)!);
  } else checks = await runChecks(configs, ctx);
  const failure = classifyFailure({ checks, answer: ctx.text ?? '', contexts: ctx.contexts?.length ?? 0, warnings: o.warnings, error: ctx.error });
  return { checks, ...(failure ? { failure } : {}) };
}

/** Whether any of these evaluators asks a judge through the judge service (a run needs a usable judge before it starts). */
export const evaluatorsNeedJudge = (configs: Array<Pick<CheckConfig, 'type'>>, strictRun: boolean): string[] => [...new Set(configs.filter((c) => needsJudgeService(c.type, strictRun)).map((c) => canonicalMetricId(c.type)))];
