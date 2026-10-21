/**
 * Metrics whose verifier is a model that is not a chat judge (planning/rag-testing.md §2.3): `faithfulness-hhem` (the claims
 * come from the judge, entailment from a classifier endpoint, Ragas FaithfulnesswithHHEM) and `reward-score` (a reward model's
 * rating of the answer, NVIDIA Nemotron reward models). See endpoint.ts for the rules every call obeys.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck } from '../checks.js';
import { answerClaims, envOf } from './claim-passes.js';
import { classifierOf, classify, parseRatings, rewardCall } from './endpoint.js';
import { assertJudgeUsable, contextsInput, guarded, meets, na, needContexts, needsField, panelOf, round3 } from './judged-kit.js';
import { num, result } from './metric-util.js';

const M = { id: 'faithfulness-hhem', version: 'faithfulness-hhem-v1' };

registerCheck('faithfulness-hhem', async (cfg, ctx) => {
  if (!ctx.text.trim()) return na(cfg, M, 'the answer is empty');
  if (!ctx.contexts?.length) return needContexts(cfg, M.id);
  const c = classifierOf(cfg.classifier);
  if (typeof c === 'string') return result(cfg, false, `faithfulness-hhem: ${c}`, { source: 'ai-judge', explanation: c });
  return guarded(cfg, ctx, M, async (host) => {
    const t = num(cfg.threshold, 0.8);
    const entail = num(cfg.entailment, 0.5);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    // the claims come from the judge (the shared claims pass); whether each follows from the documents, from the classifier
    const claims = await answerClaims(envOf(cfg, ctx, host, t, 'higher', M.id));
    if (!claims.texts.length) return na(cfg, M, 'the answer makes no factual claims');
    const premise = ctx.contexts!.map((d) => d.text).join('\n\n');
    const scores: number[] = [];
    // four at a time: the classifier is usually one local process
    for (let i = 0; i < claims.texts.length; i += 4) scores.push(...(await Promise.all(claims.texts.slice(i, i + 4).map((claim) => classify(host, c, premise, claim, ctx.services?.signal)))));
    const supported = scores.filter((s) => s > entail).length;
    const score = round3(supported / claims.texts.length);
    const items = claims.texts.map((text, i) => ({ text, ok: scores[i]! > entail, evidence: `entailment ${round3(scores[i]!)}` }));
    return result(cfg, meets(score, t, 'higher'), `faithfulness-hhem ${score}: ${supported} of ${claims.texts.length} claims entailed by the documents (classifier score above ${entail}; threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: claims.reasoning,
      metadata: {
        metric: M.id,
        promptVersion: M.version,
        threshold: t,
        items,
        itemLabels: ['entailed', 'not entailed'],
        classifier: { host: new URL(c.url).host, calls: claims.texts.length, entailment: entail },
        judge: { ...claims.judge, cached: claims.usage.cached },
        judgeUsage: { calls: claims.usage.calls, inputTokens: claims.usage.inputTokens, outputTokens: claims.usage.outputTokens, costUsd: claims.usage.costUsd, cached: claims.usage.cached },
        contexts: contextsInput(ctx).length,
      },
    });
  });
});

/* ------------------------------------------------------------------ reward-score */

const R = { id: 'reward-score', version: 'reward-score-v1' };

registerCheck('reward-score', async (cfg: CheckConfig, ctx): Promise<CheckResult> => {
  if (!ctx.question?.trim()) return needsField(cfg, R.id, 'the question', 'the dataset needs a "question" column.');
  if (!ctx.text.trim()) return na(cfg, R, 'the answer is empty');
  const provider = typeof cfg.provider === 'string' ? cfg.provider.trim() : '';
  if (!provider) return result(cfg, false, 'reward-score needs "provider": the workspace provider that serves the reward model (an OpenAI-compatible endpoint, e.g. a Nemotron reward model on NIM or vLLM).', { source: 'ai-judge', explanation: 'No reward-model provider.' });
  const host = ctx.services?.ragJudge;
  if (!host) return result(cfg, false, 'reward-score needs the AI services of an evaluation run.', { source: 'ai-judge' });
  const kind = ['attributes', 'scalar', 'genrm'].includes(String(cfg.kind)) ? String(cfg.kind) : 'attributes';
  try {
    const r = await rewardCall(host, { provider, model: typeof cfg.model === 'string' ? cfg.model : undefined, question: ctx.question, answer: ctx.text, signal: ctx.services?.signal });
    const ratings = parseRatings(r.text);
    const attribute = String(cfg.attribute ?? 'helpfulness').toLowerCase();
    let score: number;
    let detail: string;
    if (kind === 'attributes') {
      const v = ratings[attribute];
      if (v === undefined) return result(cfg, false, `reward-score: the reward model's reply has no "${attribute}" rating (it gave ${Object.keys(ratings).join(', ') || 'nothing readable'})`, { source: 'ai-judge', metadata: { reply: r.text.slice(0, 200) } });
      const [lo, hi] = Array.isArray(cfg.scale) && cfg.scale.length === 2 ? (cfg.scale as number[]) : [0, 4];
      score = Math.max(0, Math.min(1, (v - lo!) / (hi! - lo!)));
      detail = `${attribute} ${v} on ${lo}–${hi}`;
    } else if (kind === 'genrm') {
      const v = ratings.helpfulness ?? ratings.score ?? ratings.reward ?? Object.values(ratings)[0];
      if (v === undefined) return result(cfg, false, 'reward-score: the GenRM reply has no rating', { source: 'ai-judge', metadata: { reply: r.text.slice(0, 200) } });
      score = Math.max(0, Math.min(1, (v - 1) / 4));
      detail = `helpfulness ${v} on 1–5`;
    } else {
      // a scalar reward is comparable only between answers to the SAME prompt: it is reported as it is, not scaled
      const v = ratings.reward ?? Object.values(ratings)[0];
      if (v === undefined) return result(cfg, false, 'reward-score: the reward model gave no number', { source: 'ai-judge', metadata: { reply: r.text.slice(0, 200) } });
      score = v;
      detail = `scalar reward ${v} (comparable only between answers to the same question)`;
    }
    const t = num(cfg.threshold, kind === 'scalar' ? 0 : 0.6);
    score = round3(score);
    return result(cfg, meets(score, t, 'higher'), `reward-score ${score}: ${detail} (threshold ${t})`, { source: 'ai-judge', score, metadata: { metric: R.id, promptVersion: R.version, kind, ratings, threshold: t, judge: { provider: r.provider, model: r.model, metric: R.id, promptVersion: R.version } } });
  } catch (e) {
    return result(cfg, false, `reward-score failed: ${(e as Error).message}`, { source: 'ai-judge', explanation: (e as Error).message });
  }
});
