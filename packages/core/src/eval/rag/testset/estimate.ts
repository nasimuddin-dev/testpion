/**
 * What generating a test set will cost, before anything is sent (the same RunEstimate the evaluation estimate uses, so the
 * window shows it with the one shared estimate view): how many model calls write the questions, how many judge calls check
 * the references, the tokens, a cost range from the price table and the daily caps it would break. The passage sizes are
 * exact (the same selection the run makes); the answers are sized from a typical sample.
 */
import { estimateCost } from '../../../ai/index.js';
import { aiUsageSummary } from '../../../storage/ai-usage.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import { assertJudgeUsable, type JudgeRef, type RagJudgeHost } from '../judge.js';
import type { MetricLine, RunEstimate } from '../estimate.js';
import { DEFAULT_SHAPE } from '../estimate.js';
import { TESTSET_INSTRUCTION } from './prompts.js';
import { planBatch, batchesOf } from './sample.js';
import { BATCH_SAMPLES, type Corpus, type TestsetType } from './types.js';

const OUT_PER_SAMPLE = 140;
const VERDICT_OUT = 250;
const JUDGE_PROMPT = 330;
const tok = (s: string) => Math.ceil(s.length / 4);

export function estimateTestset(host: RagJudgeHost, store: WorkspaceStore | undefined, corpus: Corpus, o: { count: number; types: TestsetType[]; seed: string; judge?: JudgeRef; verify?: boolean; personas?: string[]; styles?: string[]; dedupe?: string }): RunEstimate {
  const batches = batchesOf(o.count);
  const instruction = tok(TESTSET_INSTRUCTION) + 80;
  let genIn = 0;
  let answerable = 0;
  let judgeIn = 0;
  for (let b = 0; b < batches; b++) {
    const plan = planBatch(corpus.chunks, { seed: o.seed, batch: b, count: o.count, types: o.types, personas: o.personas, styles: o.styles });
    const passages = plan.chunks.reduce((n, c) => n + tok(c.text) + 25, 0);
    genIn += instruction + passages + plan.slots.length * 15 + plan.slots.reduce((n, s) => n + tok(`${s.persona ?? ''} ${s.style ?? ''}`), 0);
    for (const s of plan.slots) {
      if (s.type === 'unanswerable') continue;
      answerable++;
      const sources = s.chunks.reduce((n, id) => n + tok(corpus.chunks.find((c) => c.id === id)?.text ?? ''), 0);
      judgeIn += JUDGE_PROMPT + sources + 60;
    }
  }
  const genOut = o.count * OUT_PER_SAMPLE + batches * 30;
  const judgeCalls = o.verify === false ? 0 : answerable;
  const notes: string[] = [];
  const metrics: MetricLine[] = [
    { evaluator: 0, id: 'write-questions', name: 'Write the questions', kind: 'generation', llmCalls: batches, embedCalls: 0, inputTokens: Math.round(genIn / batches), outputTokens: Math.round(genOut / batches), note: `${batches} call${batches === 1 ? '' : 's'} of at most ${BATCH_SAMPLES} questions` },
    ...(judgeCalls
      ? [{ evaluator: 1, id: 'reference-support', name: 'Check each reference against its chunks', kind: 'judged', llmCalls: 1, embedCalls: 0, inputTokens: Math.round(judgeIn / judgeCalls), outputTokens: VERDICT_OUT, note: `${judgeCalls} judge calls (unanswerable questions are checked without a model)` }]
      : []),
    // each new question is embedded once (its vector is kept for the comparisons that follow)
    ...(o.dedupe === 'embedding'
      ? [{ evaluator: 2, id: 'dedupe-embedding', name: 'Compare the questions by meaning', kind: 'embedding', llmCalls: 0, embedCalls: o.count, inputTokens: 20, outputTokens: 0, note: `${o.count} short embedding calls (about 20 tokens each); without a model that embeds the words are compared instead` }]
      : []),
  ];
  const embeds = o.dedupe === 'embedding' ? o.count : 0;
  const total = { llmCalls: batches + judgeCalls, embedCalls: embeds, inputTokens: genIn + judgeIn + embeds * 20, outputTokens: genOut + judgeCalls * VERDICT_OUT };
  let judge: RunEstimate['judge'];
  let judgeProblem: string | undefined;
  let expected: number | undefined;
  try {
    const g = assertJudgeUsable(host, undefined);
    const gr = host.deps.providers.resolveModel({ provider: g.provider, name: g.model });
    const j = assertJudgeUsable(host, o.judge);
    const jr = host.deps.providers.resolveModel({ provider: j.provider, name: j.model });
    const price = (r: typeof gr, inputTokens: number, outputTokens: number) => estimateCost(host.deps.settings.pricing ?? [], r.provider.config, r.model, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }).cost;
    const a = price(gr, genIn, genOut);
    const b = judgeCalls ? price(jr, judgeIn, judgeCalls * VERDICT_OUT) : 0;
    expected = a === undefined || b === undefined ? undefined : a + b;
    const local = (c: { kind?: string; baseUrl?: string }) => c.kind === 'ollama' || c.kind === 'mock' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(c.baseUrl ?? '');
    judge = { ...j, local: local(gr.provider.config) && local(jr.provider.config), priceKnown: expected !== undefined };
    if (judgeCalls && (g.provider !== j.provider || g.model !== j.model)) notes.push(`The questions are written by ${g.provider}/${g.model}; the references are checked by ${j.provider}/${j.model}.`);
  } catch (e) {
    judgeProblem = (e as Error).message;
  }
  const caps: RunEstimate['caps'] = { exceeds: [] };
  if (store) {
    const u = aiUsageSummary(store, { days: 1, settings: host.deps.settings.ai });
    if (u.caps.tokensLeftToday !== undefined) caps.dailyTokensLeft = u.caps.tokensLeftToday;
    if (u.caps.budgetLeftToday !== undefined) caps.dailyBudgetLeftUsd = u.caps.budgetLeftToday;
  }
  if (o.judge?.maxCalls !== undefined) caps.maxJudgeCalls = o.judge.maxCalls;
  if (o.judge?.maxCostUsd !== undefined) caps.maxJudgeCostUsd = o.judge.maxCostUsd;
  if (caps.dailyTokensLeft !== undefined && total.inputTokens + total.outputTokens > caps.dailyTokensLeft) caps.exceeds.push(`the daily token cap (${caps.dailyTokensLeft.toLocaleString()} left today)`);
  if (caps.maxJudgeCalls !== undefined && judgeCalls > caps.maxJudgeCalls) caps.exceeds.push(`the judge call limit (${caps.maxJudgeCalls}): the references beyond it are not checked`);
  const costUsd = expected === undefined ? undefined : { low: Math.round(expected * 0.7 * 1e6) / 1e6, high: Math.round(expected * 1.6 * 1e6) / 1e6 };
  if (costUsd && caps.dailyBudgetLeftUsd !== undefined && costUsd.high > caps.dailyBudgetLeftUsd) caps.exceeds.push(`the daily budget ($${caps.dailyBudgetLeftUsd} left today; the estimate may reach $${costUsd.high})`);
  if (costUsd && caps.maxJudgeCostUsd !== undefined && costUsd.high > caps.maxJudgeCostUsd) caps.exceeds.push(`the cost limit ($${caps.maxJudgeCostUsd}; the estimate may reach $${costUsd.high})`);
  notes.push(`${corpus.chunks.length} passages from ${corpus.docs.length} document${corpus.docs.length === 1 ? '' : 's'}; ${o.count} question${o.count === 1 ? '' : 's'} asked for.`);
  return {
    samples: o.count,
    basis: 'default',
    shape: DEFAULT_SHAPE,
    metrics,
    ...(judge ? { judge } : {}),
    ...(judgeProblem ? { judgeProblem } : {}),
    total,
    ...(costUsd ? { costUsd } : {}),
    cache: { hits: 0, of: total.llmCalls, exact: false },
    caps,
    notes,
    unknown: [],
  };
}
