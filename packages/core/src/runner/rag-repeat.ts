/**
 * Calling the RAG system more than once for the same question (`targetRepeats: n`, planning/rag-testing.md §4c "determinism
 * and noise"): a RAG system answers differently each time, so one call says little about a metric that is close to its mark.
 * The first call is scored as always; n − 1 more calls are made and scored with the same metrics, and each metric's result becomes
 * the MEAN of the n calls with the standard deviation, the lowest and the highest in its metadata. A metric passes when its mean
 * does; one without a score passes only when every call passed. The judge's own noise is `repeat` of the judge, not this.
 */
import type { CheckConfig, CheckResult } from '../model/types.js';
import type { CheckContext } from '../eval/checks.js';
import { getMetric, resolveMetric } from '../eval/rag/metric-registry.js';
import { scoreRagSample } from '../eval/rag/score.js';
import { mean, stdev as sd } from '../util/stats.js';
import { addUsage, noUsage, type Usage } from '../eval/rag/judged-kit.js';
import type { RagRunResult } from './rag-run.js';

export const MAX_TARGET_REPEATS = 10;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface RepeatOutcome {
  checks: CheckResult[];
  /** The answers of the extra calls (bounded), so a rescore and the drill-down can show how they differed. */
  repeats: Array<{ answer: string; latencyMs?: number; error?: string }>;
  /** How many of the n calls gave a different answer from the first. */
  differing: number;
}

/**
 * `call` makes one more call of the target and returns its check context (rag-run.ts); `first` is what the first call scored.
 * The extra contexts get the first call's services (judge host, signal) and judge setup.
 */
export async function scoreTargetRepeats(o: { n: number; configs: CheckConfig[]; first: { ctx: CheckContext; checks: CheckResult[] }; call: () => Promise<RagRunResult>; signal?: AbortSignal }): Promise<RepeatOutcome> {
  const n = Math.max(1, Math.min(MAX_TARGET_REPEATS, Math.floor(o.n)));
  const rounds: CheckResult[][] = [o.first.checks];
  const repeats: RepeatOutcome['repeats'] = [];
  let differing = 0;
  for (let i = 1; i < n; i++) {
    if (o.signal?.aborted) break;
    try {
      const r = await o.call();
      const ctx: CheckContext = { ...r.ctx, services: o.first.ctx.services, judge: o.first.ctx.judge, workspaceRoot: o.first.ctx.workspaceRoot ?? r.ctx.workspaceRoot };
      if (r.ctx.text !== o.first.ctx.text) differing++;
      repeats.push({ answer: (r.ctx.text ?? '').slice(0, 2000), ...(r.ctx.latencyMs !== undefined ? { latencyMs: r.ctx.latencyMs } : {}) });
      rounds.push((await scoreRagSample(o.configs, ctx)).checks);
    } catch (e) {
      // a call that fails is a failed call, not a missing one: it is counted against every metric
      repeats.push({ answer: '', error: (e as Error).message.slice(0, 300) });
      rounds.push(o.first.checks.map((c) => ({ ...c, passed: false, score: undefined, message: `call ${i + 1} of ${n} failed: ${(e as Error).message.slice(0, 160)}`, metadata: { na: undefined, failedCall: true } })));
    }
  }
  const checks = o.first.checks.map((c, j) => {
    const all = rounds.map((r) => r[j]).filter((x): x is CheckResult => !!x);
    const def = getMetric(resolveMetric(c.type)?.def.id ?? c.type);
    const lower = def?.direction === 'lower';
    const failedCall = (x: CheckResult) => !!(x.metadata as { failedCall?: boolean } | undefined)?.failedCall;
    // a call that failed is the worst score the metric can give
    const scores = all.filter((x) => failedCall(x) || (typeof x.score === 'number' && !(x.metadata as { na?: string } | undefined)?.na)).map((x) => (failedCall(x) ? (lower ? 1 : 0) : x.score!));
    const meta = { calls: all.length, passes: all.filter((x) => x.passed).length, failedCalls: all.filter((x) => (x.metadata as { failedCall?: boolean } | undefined)?.failedCall).length };
    if (all.length < 2) return c;
    if (!scores.length) return { ...c, passed: all.every((x) => x.passed), metadata: { ...(c.metadata ?? {}), targetRepeat: meta } };
    const m = mean(scores);
    const t = (c.metadata as { threshold?: number } | undefined)?.threshold ?? def?.threshold;
    const passed = t === undefined ? all.every((x) => x.passed) : lower ? m <= t : m >= t;
    const usageSum = all.reduce((a, x) => {
      const u = (x.metadata as { judgeUsage?: Usage } | undefined)?.judgeUsage;
      return u ? addUsage(a, u) : a;
    }, noUsage());
    const md = { ...(c.metadata ?? {}), targetRepeat: { ...meta, scores: scores.map(r3), mean: r3(m), sd: r3(sd(scores)), min: r3(Math.min(...scores)), max: r3(Math.max(...scores)) }, ...(usageSum.calls || (c.metadata as { judgeUsage?: unknown } | undefined)?.judgeUsage ? { judgeUsage: usageSum } : {}) };
    return { ...c, score: r3(m), passed, message: `${c.message} · mean of ${scores.length} calls ${r3(m)} ± ${r3(sd(scores))} (lowest ${r3(Math.min(...scores))}, highest ${r3(Math.max(...scores))})`, metadata: md };
  });
  return { checks, repeats, differing };
}
