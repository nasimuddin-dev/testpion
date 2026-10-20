/**
 * The estimate of a RAG evaluation BEFORE it runs (planning/rag-testing.md §4c): how many judge calls, how many tokens, what
 * it may cost (a range, from the price table), how many verdicts the cache already holds, and whether it would break a cap.
 * Nothing is sent. Without stored answers the numbers come from the metrics' formulas over a typical sample (from a probe
 * or the dataset's own sizes); with stored samples (a rescore) every judge prompt is built for real, so the call count, the
 * input tokens and the cache hits are exact.
 */
import type { RagJudgeSetup } from '@testpion/shared';
import type { CheckConfig } from '../../model/types.js';
import { estimateCost } from '../../ai/index.js';
import { aiUsageSummary } from '../../storage/ai-usage.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { assertJudgeUsable, dryHost, type RagJudgeHost } from './judge.js';
import { resolveMetric, type MetricEstimate, type SampleShape } from './metric-registry.js';
import { contextOfSample, type TrySample } from './try-metric.js';
import { scoreRagSample } from './score.js';

export const DEFAULT_SHAPE: SampleShape = { questionTokens: 20, answerTokens: 120, contextTokens: 900, contexts: 5, referenceTokens: 60 };

export interface MetricLine {
  id: string;
  name: string;
  kind: string;
  /** Judge calls per sample (all judges, orders and repeats), embedding calls per sample, and tokens per sample. */
  llmCalls: number;
  embedCalls: number;
  inputTokens: number;
  outputTokens: number;
  note?: string;
}

export interface RunEstimate {
  samples: number;
  /** Where the sample size comes from: stored answers (exact), a probe, the dataset, or the defaults. */
  basis: 'stored' | 'probe' | 'dataset' | 'default';
  shape: SampleShape;
  metrics: MetricLine[];
  judge?: { provider: string; model: string; local: boolean; priceKnown: boolean };
  /** Why no judge could be chosen (the setup message), when a metric needs one. */
  judgeProblem?: string;
  total: { llmCalls: number; embedCalls: number; inputTokens: number; outputTokens: number };
  /** The cost range in USD (undefined without a price for the judge model). */
  costUsd?: { low: number; high: number };
  cache: { hits: number; of: number; exact: boolean };
  caps: { dailyBudgetLeftUsd?: number; dailyTokensLeft?: number; maxJudgeCostUsd?: number; maxJudgeCalls?: number; exceeds: string[] };
  /** What the run asks of the system under test. */
  target?: { calls: number; repeats: number };
  notes: string[];
  /** The metrics that were named but are not in the catalogue. */
  unknown: string[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The mean size of stored samples, in tokens. */
export function sampleShapeOf(samples: TrySample[]): SampleShape {
  if (!samples.length) return DEFAULT_SHAPE;
  const t = (s?: string) => Math.ceil((s?.length ?? 0) / 4);
  const m = (f: (s: TrySample) => number) => Math.round(sum(samples.map(f)) / samples.length);
  return {
    questionTokens: Math.max(1, m((s) => t(s.question))),
    answerTokens: Math.max(1, m((s) => t(s.answer))),
    contextTokens: m((s) => sum((s.contexts ?? []).map((d) => t(d.text)))),
    contexts: m((s) => s.contexts?.length ?? 0),
    referenceTokens: m((s) => t(s.reference)),
  };
}

/** How many times a panel multiplies a metric's calls: judges × orders × repeats. */
const panelFactor = (needsContexts: boolean, j?: RagJudgeSetup) => Math.max(1, j?.judges?.length ?? 1) * (j?.swap && needsContexts ? 2 : 1) * Math.max(1, Math.floor(j?.repeat ?? 1));

export function estimateRagRun(
  host: RagJudgeHost,
  store: WorkspaceStore | undefined,
  i: { evaluators: CheckConfig[]; samples: number; judge?: RagJudgeSetup; shape?: Partial<SampleShape>; shapeFrom?: 'probe' | 'dataset'; stored?: TrySample[]; targetRepeats?: number; hasTarget?: boolean },
): RunEstimate {
  const notes: string[] = [];
  const unknown: string[] = [];
  const stored = i.stored?.length ? i.stored : undefined;
  const shape: SampleShape = stored ? sampleShapeOf(stored) : { ...DEFAULT_SHAPE, ...(i.shape ?? {}) };
  const basis: RunEstimate['basis'] = stored ? 'stored' : i.shape ? (i.shapeFrom ?? 'dataset') : 'default';
  const lines: MetricLine[] = [];
  let needsJudge = false;
  for (const e of i.evaluators) {
    const r = resolveMetric(e.type);
    if (!r) {
      unknown.push(e.type);
      continue;
    }
    const opts = { ...r.options, ...e };
    const est: MetricEstimate = r.def.estimate?.(shape, opts) ?? { llmCalls: 0, embedCalls: 0, inputTokens: 0, outputTokens: 0 };
    const judged = est.llmCalls > 0 && (r.def.judge === 'service' || !!e.judge);
    // a legacy judged check without a judge is its heuristic: free
    const f = judged ? panelFactor(r.def.requires.includes('contexts'), i.judge) : 1;
    if (judged) needsJudge = true;
    lines.push({
      id: r.def.id,
      name: r.def.name,
      kind: r.def.kind,
      llmCalls: judged ? est.llmCalls * f : 0,
      embedCalls: est.embedCalls,
      inputTokens: judged ? est.inputTokens * f : est.embedCalls ? est.inputTokens : 0,
      outputTokens: judged ? est.outputTokens * f : 0,
      ...(judged && f > 1 ? { note: `${f}× for ${[i.judge?.judges?.length ? `${i.judge.judges.length} judges` : '', i.judge?.swap ? 'swap' : '', (i.judge?.repeat ?? 1) > 1 ? `repeat ${i.judge!.repeat}` : ''].filter(Boolean).join(', ')}` } : {}),
    });
  }
  // two readers of the answer's claims: the estimate says what sharing would change
  const ids = lines.map((l) => l.id);
  if (ids.includes('faithfulness') && ids.includes('answer-relevance') && i.judge?.shareClaims) notes.push('The claims of the answer are split once and shared by faithfulness and answer-relevance (+1 call, shorter prompts).');

  let judge: RunEstimate['judge'];
  let judgeProblem: string | undefined;
  let pricing: { cost: (u: { inputTokens: number; outputTokens: number }) => number | undefined } | undefined;
  if (needsJudge) {
    try {
      const j = assertJudgeUsable(host, { provider: i.judge?.provider, model: i.judge?.model });
      const resolved = host.deps.providers.resolveModel({ provider: j.provider, name: j.model });
      const price = (u: { inputTokens: number; outputTokens: number }) => estimateCost(host.deps.settings.pricing ?? [], resolved.provider.config, resolved.model, { ...u, totalTokens: u.inputTokens + u.outputTokens }).cost;
      pricing = { cost: price };
      judge = { ...j, local: isLocal(resolved.provider.config), priceKnown: price({ inputTokens: 1000, outputTokens: 1000 }) !== undefined };
    } catch (e) {
      judgeProblem = (e as Error).message;
    }
  }

  const total = { llmCalls: sum(lines.map((l) => l.llmCalls)) * i.samples, embedCalls: sum(lines.map((l) => l.embedCalls)) * i.samples, inputTokens: sum(lines.map((l) => l.inputTokens)) * i.samples, outputTokens: sum(lines.map((l) => l.outputTokens)) * i.samples };
  const cache = { hits: 0, of: total.llmCalls, exact: false };

  const caps = capsOf(store, host, i.judge, total);
  const price = pricing?.cost;
  const expected = price ? price({ inputTokens: total.inputTokens, outputTokens: total.outputTokens }) : undefined;
  return finish({ samples: i.samples, basis, shape, metrics: lines, judge, judgeProblem, total, cache, caps, notes, unknown }, expected, i);
}

function isLocal(c: { kind?: string; baseUrl?: string }): boolean {
  return c.kind === 'ollama' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(c.baseUrl ?? '') || c.kind === 'mock';
}

function capsOf(store: WorkspaceStore | undefined, host: RagJudgeHost, j: RagJudgeSetup | undefined, total: RunEstimate['total'], cost?: number): RunEstimate['caps'] {
  const out: RunEstimate['caps'] = { ...(j?.maxCostUsd ? { maxJudgeCostUsd: j.maxCostUsd } : {}), ...(j?.maxCalls ? { maxJudgeCalls: j.maxCalls } : {}), exceeds: [] };
  if (store) {
    const u = aiUsageSummary(store, { days: 1, settings: host.deps.settings.ai });
    if (u.caps.tokensLeftToday !== undefined) out.dailyTokensLeft = u.caps.tokensLeftToday;
    if (u.caps.budgetLeftToday !== undefined) out.dailyBudgetLeftUsd = u.caps.budgetLeftToday;
  }
  if (out.dailyTokensLeft !== undefined && total.inputTokens + total.outputTokens > out.dailyTokensLeft) out.exceeds.push(`the daily token cap (${out.dailyTokensLeft.toLocaleString()} left today)`);
  if (cost !== undefined && out.dailyBudgetLeftUsd !== undefined && cost > out.dailyBudgetLeftUsd) out.exceeds.push(`the daily budget ($${out.dailyBudgetLeftUsd} left today)`);
  if (cost !== undefined && j?.maxCostUsd !== undefined && cost > j.maxCostUsd) out.exceeds.push(`the run’s judge cost limit ($${j.maxCostUsd})`);
  if (j?.maxCalls !== undefined && total.llmCalls > j.maxCalls) out.exceeds.push(`the run’s judge call limit (${j.maxCalls}); the rest would be n/a`);
  return out;
}

function finish(e: Omit<RunEstimate, 'costUsd' | 'target'>, expected: number | undefined, i: { evaluators: CheckConfig[]; samples: number; judge?: RagJudgeSetup; targetRepeats?: number; hasTarget?: boolean }): RunEstimate {
  // a range, not a promise: outputs run shorter or longer than the formula, and a malformed verdict is asked again
  const costUsd = expected === undefined ? undefined : { low: round6(expected * 0.7), high: round6(expected * 1.6) };
  const caps = costUsd ? capsFix(e.caps, costUsd.high, i.judge) : e.caps;
  return { ...e, caps, ...(costUsd ? { costUsd } : {}), ...(i.hasTarget ? { target: { calls: i.samples * Math.max(1, i.targetRepeats ?? 1), repeats: Math.max(1, i.targetRepeats ?? 1) } } : {}) };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function capsFix(caps: RunEstimate['caps'], high: number, j?: RagJudgeSetup): RunEstimate['caps'] {
  const exceeds = [...caps.exceeds];
  if (caps.dailyBudgetLeftUsd !== undefined && high > caps.dailyBudgetLeftUsd) exceeds.push(`the daily budget ($${caps.dailyBudgetLeftUsd} left today; the estimate may reach $${high})`);
  if (j?.maxCostUsd !== undefined && high > j.maxCostUsd) exceeds.push(`the run’s judge cost limit ($${j.maxCostUsd}; the estimate may reach $${high}): judging stops there and the rest is n/a`);
  return { ...caps, exceeds };
}

async function exactEstimateImpl(
  dry: ReturnType<typeof dryHost>,
  configs: CheckConfig[],
  stored: TrySample[],
  i: { samples: number; judge?: RagJudgeSetup; targetRepeats?: number; hasTarget?: boolean; evaluators: CheckConfig[] },
  base: { notes: string[]; unknown: string[]; shape: SampleShape; basis: RunEstimate['basis']; lines: MetricLine[]; judge: RunEstimate['judge']; judgeProblem?: string; pricing?: { cost: (u: { inputTokens: number; outputTokens: number }) => number | undefined }; store?: WorkspaceStore },
  host: RagJudgeHost,
): Promise<RunEstimate> {
  for (const s of stored) await scoreRagSample(configs, contextOfSample(s, { judge: i.judge, providers: host.deps.providers, ragJudge: dry }));
  const calls = dry.dry;
  const inputTokens = sum(calls.map((c) => c.preview.estimate.inputTokens));
  // a verdict is about 250 tokens: the dry run has no answer to count
  const outputTokens = calls.length * 250;
  const total = { llmCalls: calls.length, embedCalls: 0, inputTokens, outputTokens };
  const fresh = calls.filter((c) => !c.cached);
  const freshIn = sum(fresh.map((c) => c.preview.estimate.inputTokens));
  const expected = base.pricing ? base.pricing.cost({ inputTokens: freshIn, outputTokens: fresh.length * 250 }) : undefined;
  const caps = capsOf(base.store, host, i.judge, { ...total, llmCalls: fresh.length }, expected);
  return finish({ samples: stored.length, basis: 'stored', shape: base.shape, metrics: base.lines, judge: base.judge, total, cache: { hits: calls.length - fresh.length, of: calls.length, exact: true }, caps, notes: base.notes, unknown: base.unknown }, expected, i);
}

/** Same as `estimateRagRun`, but with stored samples it builds every prompt for real (async). */
export async function estimateRagRunExact(host: RagJudgeHost, store: WorkspaceStore | undefined, i: Parameters<typeof estimateRagRun>[2]): Promise<RunEstimate> {
  if (!i.stored?.length) return estimateRagRun(host, store, i);
  const base = estimateRagRun(host, store, { ...i, stored: undefined, samples: i.stored.length, shape: sampleShapeOf(i.stored) });
  if (!base.judge) return { ...base, basis: 'stored' };
  const dry = dryHost(host);
  const pricing = host.deps.providers.resolveModel({ provider: base.judge.provider, name: base.judge.model });
  const price = (u: { inputTokens: number; outputTokens: number }) => estimateCost(host.deps.settings.pricing ?? [], pricing.provider.config, pricing.model, { ...u, totalTokens: u.inputTokens + u.outputTokens }).cost;
  return exactEstimateImpl(dry, i.evaluators, i.stored, i as never, { notes: base.notes, unknown: base.unknown, shape: base.shape, basis: 'stored', lines: base.metrics, judge: base.judge, pricing: { cost: price }, store }, host);
}

