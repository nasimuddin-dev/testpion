/**
 * Scoring one RAG sample with its metrics: the one function a run (execute.ts), a rescore of a stored run and "Try on
 * one sample" all use, so a score is the same wherever it is computed. It tells the checks which metrics run beside them
 * (the shared claim pass), applies `shortCircuit` (a free retrieval gate that failed spares the judged answer metrics),
 * and classifies the failure.
 */
import { createHash } from 'node:crypto';
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
const isAnswerJudged = (id: string) => {
  const d = getMetric(id);
  return !!d && d.kind === 'judged' && d.requires.includes('answer');
};
/** The free retrieval metrics that can fail the gate. */
const isGate = (id: string) => getMetric(id)?.group === 'retrieval-ir' || id === 'context-entity-recall';

/** A result that says why a metric was not computed (n/a: neither a pass nor a fail, not in a mean). */
const skipped = (c: CheckConfig, na: string, why: string, extra: Record<string, unknown> = {}): CheckResult => ({
  type: c.type,
  name: c.name ?? c.type,
  passed: true,
  source: 'ai-judge',
  message: `${canonicalMetricId(c.type)} is n/a: ${why}`,
  metadata: { na, metric: canonicalMetricId(c.type), ...extra },
});

/** A number in [0, 1) that is the same for the same sample, so the same samples are judged on every run of a monitor. */
function bucket(text: string): number {
  const h = createHash('sha1').update(text).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

export async function scoreRagSample(configs: CheckConfig[], ctx: CheckContext, o: { warnings?: string[] } = {}): Promise<ScoredSample> {
  const ids = configs.map((c) => canonicalMetricId(c.type));
  ctx.ragRun = { strict: true, metrics: ids };
  const byConfig = new Map<CheckConfig, CheckResult>();
  let live = configs;
  // a monitor judges a share of its samples (the free metrics always run): which ones is decided by the sample, not by chance
  const share = ctx.judge?.sampleShare;
  if (share !== undefined && share < 1 && bucket(`${ctx.question ?? ''}\n${ctx.text ?? ''}`) >= Math.max(0, share)) {
    for (const c of configs) if (needsJudgeService(c.type, true, c)) byConfig.set(c, skipped(c, 'sampled', `this sample is not in the judged share (${Math.round(share * 100)}%)`));
    live = configs.filter((c) => !byConfig.has(c));
  }
  const liveIds = live.map((c) => canonicalMetricId(c.type));
  if (ctx.judge?.shortCircuit === true) {
    const free = live.filter((c, i) => !isAnswerJudged(liveIds[i]!));
    const gated = live.filter((c, i) => isAnswerJudged(liveIds[i]!));
    const freeResults = await runChecks(free, ctx);
    const gateFailed = freeResults.find((r, i) => !r.passed && isGate(canonicalMetricId(free[i]!.type)));
    const rest = gateFailed ? gated.map((c) => skipped(c, 'short-circuit', `skipped because ${gateFailed.name} already failed (shortCircuit)`, { shortCircuit: gateFailed.name })) : await runChecks(gated, ctx);
    free.forEach((c, i) => byConfig.set(c, freeResults[i]!));
    gated.forEach((c, i) => byConfig.set(c, rest[i]!));
  } else {
    const results = await runChecks(live, ctx);
    live.forEach((c, i) => byConfig.set(c, results[i]!));
  }
  // back in the order the evaluation lists them
  const checks = configs.map((c) => byConfig.get(c)!);
  const failure = classifyFailure({ checks, answer: ctx.text ?? '', contexts: ctx.contexts?.length ?? 0, warnings: o.warnings, error: ctx.error });
  return { checks, ...(failure ? { failure } : {}) };
}

/** Whether any of these evaluators asks a judge through the judge service (a run needs a usable judge before it starts). */
export const evaluatorsNeedJudge = (configs: CheckConfig[], strictRun: boolean): string[] => [...new Set(configs.filter((c) => needsJudgeService(c.type, strictRun, c)).map((c) => canonicalMetricId(c.type)))];
