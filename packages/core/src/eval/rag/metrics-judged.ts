/**
 * The judged metrics of the RAG triad, as checks that go through the judge service (judge.ts) and the judge panel
 * (judge-panel.ts, so juries, swap and repeat apply to every one of them):
 *
 *  - `faithfulness`: the share of the answer's claims the documents support;
 *  - `answer-relevance`: the share of the answer's statements that address the question, or Ragas' `reverse-questions`;
 *  - `context-relevance`: how much of the retrieved text is relevant, in the modes nvidia (default), statements, chunks,
 *    sentences.
 *
 * `faithfulness` and `answer-relevance` read the answer's CLAIMS; when both run on the same sample they share one
 * `claims-v1` pass (the claims are split once and each metric only judges them), otherwise each makes its one call.
 * Inside a RAG target run (or a rescore) they are strict: no judge, no score. Outside one (a `rag` test with static
 * contexts) the older heuristic-or-`judge:` implementations in checks.ts still answer to the same names.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { cosine } from '../text.js';
import { checkFn, registerCheck, type CheckContext } from '../checks.js';
import { ANSWER_RELEVANCE, FAITHFULNESS, type JudgedMetric } from './judge-prompts.js';
import { ANSWER_RELEVANCE_ON_CLAIMS, CLAIMS, CONTEXT_RELEVANCE_CHUNKS, CONTEXT_RELEVANCE_NVIDIA, CONTEXT_RELEVANCE_SENTENCES, CONTEXT_RELEVANCE_STATEMENTS, FAITHFULNESS_ON_CLAIMS, REVERSE_QUESTIONS } from './judge-prompts-more.js';
import { assertJudgeUsable, contextsInput, describe, guarded, judgeMeta, judgePanel, na, needContexts, panelOf, round3, strictOver, type PanelOptions, type PanelResult } from './judged-kit.js';
import { resolveMetric } from './metric-registry.js';
import { num, result } from './metric-util.js';

/** The metrics that read the answer's claims (more join in later releases: claim precision, noise sensitivity …). */
const CLAIM_READERS = new Set(['faithfulness', 'answer-relevance']);

/**
 * Whether the claims of this sample are split once for the metrics that read them. Splitting costs one call and saves
 * one splitting per reader, so with two readers it costs more than it saves: it is on by default from three readers, and
 * `shareClaims` on the judge turns it on or off.
 */
const sharesClaims = (ctx: CheckContext, cfg: CheckConfig) => {
  const ids = ctx.ragRun?.metrics ?? [];
  if (String(cfg.mode ?? 'statements') === 'reverse-questions' || !ids.includes('faithfulness') || !ids.includes('answer-relevance')) return false;
  return ctx.judge?.shareClaims ?? ids.filter((i) => CLAIM_READERS.has(i)).length >= 3;
};

/** The shared pass: the answer's claims (asked once; a second metric of the same sample finds them cached). */
async function claimsOf(host: NonNullable<NonNullable<CheckContext['services']>['ragJudge']>, ctx: CheckContext, panel: PanelOptions): Promise<{ claims: string[]; usage: PanelResult['usage'] }> {
  const r = await judgePanel(host, CLAIMS, { answer: ctx.text }, { ...panel, judges: panel.judges?.slice(0, 1), swap: false, repeat: 1 });
  return { claims: r.items.map((i) => i.text), usage: r.usage };
}

/* ------------------------------------------------------------------ faithfulness */

const faithfulness = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, FAITHFULNESS, async (host) => {
    const docs = contextsInput(ctx);
    if (!docs.length) return needContexts(cfg, FAITHFULNESS.id);
    if (!ctx.text.trim()) return na(cfg, FAITHFULNESS, 'the answer is empty');
    const t = num(cfg.threshold, 0.8);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    let m = FAITHFULNESS;
    let input: Record<string, unknown> = { answer: ctx.text, contexts: docs };
    let shared: { claims: number; usage: PanelResult['usage'] } | undefined;
    if (sharesClaims(ctx, cfg)) {
      const c = await claimsOf(host, ctx, panel);
      if (c.claims.length) {
        m = FAITHFULNESS_ON_CLAIMS;
        input = { claims: c.claims, contexts: docs };
        shared = { claims: c.claims.length, usage: c.usage };
      }
    }
    const r = await judgePanel(host, m, input, panel);
    if (r.score === undefined) return na(cfg, m, 'the answer makes no factual claims', { explanation: r.reasoning, metadata: judgeMeta(m, r, t) });
    const usage = shared ? { ...r.usage, calls: r.usage.calls + shared.usage.calls, inputTokens: r.usage.inputTokens + shared.usage.inputTokens, outputTokens: r.usage.outputTokens + shared.usage.outputTokens, costUsd: r.usage.costUsd + shared.usage.costUsd, cached: r.usage.cached && shared.usage.cached } : r.usage;
    return result(cfg, r.passed, describe(m, r.score, r, t, 'faithfulness'), {
      source: 'ai-judge',
      score: r.score,
      explanation: r.reasoning,
      metadata: judgeMeta(m, { ...r, usage }, t, { promptVersion: m.version, ...(shared ? { shared: 'claims-v1', claims: shared.claims } : {}) }),
    });
  });

/* ------------------------------------------------------------------ answer relevance */

async function reverseQuestions(host: NonNullable<NonNullable<CheckContext['services']>['ragJudge']>, cfg: CheckConfig, ctx: CheckContext, panel: PanelOptions, t: number): Promise<CheckResult> {
  const m = REVERSE_QUESTIONS;
  const r = await judgePanel(host, m, { answer: ctx.text }, { ...panel, judges: panel.judges?.slice(0, 1), swap: false });
  if (!r.items.length) return na(cfg, m, 'the judge wrote no question from the answer', { metadata: judgeMeta(m, r, t) });
  const asked = ctx.question ?? '';
  // Ragas: a noncommittal answer ("I don't know") scores 0 whatever the questions look like
  if (r.items.every((i) => !i.ok)) return result(cfg, 0 >= t, `answer-relevance 0: the answer is noncommittal (threshold ${t})`, { source: 'ai-judge', score: 0, explanation: r.reasoning, metadata: judgeMeta(m, r, t, { mode: 'reverse-questions', promptVersion: m.version }) });
  const emb = cfg.embedder as { provider?: string; model?: string } | string | undefined;
  const slash = typeof emb === 'string' ? emb.split('/') : undefined;
  const route = typeof emb === 'string' ? { provider: slash![0], model: slash!.slice(1).join('/') || undefined } : emb;
  const provider = host.deps.providers.get(route?.provider ?? r.judge.provider);
  if (!provider.embed) throw new Error(`the provider ${provider.config.name} cannot embed text: name another with "embedder: provider/model", or use mode: statements`);
  const vectors = await provider.embed([asked, ...r.items.map((i) => i.text)], route?.model, ctx.services?.signal);
  const sims = vectors.slice(1).map((v) => cosine(vectors[0]!, v));
  const score = round3(sims.reduce((a, b) => a + b, 0) / sims.length);
  return result(cfg, score >= t, `answer-relevance ${score}: mean similarity of ${sims.length} questions generated from the answer to the real question (threshold ${t})`, {
    source: 'ai-judge',
    score,
    explanation: r.reasoning,
    metadata: judgeMeta(m, r, t, { mode: 'reverse-questions', promptVersion: m.version, similarities: sims.map(round3), itemLabels: ['generated', 'noncommittal'], embedder: `${provider.config.name}${route?.model ? `/${route.model}` : ''}` }),
  });
}

const answerRelevance = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, ANSWER_RELEVANCE, async (host) => {
    if (!ctx.question) return result(cfg, false, 'answer-relevance needs the question.', { source: 'ai-judge' });
    const t = num(cfg.threshold, 0.7);
    if (!ctx.text.trim()) return result(cfg, false, `answer-relevance 0: the answer is empty`, { source: 'ai-judge', score: 0, metadata: { items: [], promptVersion: ANSWER_RELEVANCE.version, metric: 'answer-relevance' } });
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    if (String(cfg.mode ?? 'statements') === 'reverse-questions') return reverseQuestions(host, cfg, ctx, panel, t);
    let m = ANSWER_RELEVANCE;
    let input: Record<string, unknown> = { question: ctx.question, answer: ctx.text };
    let shared: { claims: number; usage: PanelResult['usage'] } | undefined;
    if (sharesClaims(ctx, cfg)) {
      const c = await claimsOf(host, ctx, panel);
      // an answer with no claims (a refusal) is judged by the standalone prompt, which scores it 0
      if (c.claims.length) {
        m = ANSWER_RELEVANCE_ON_CLAIMS;
        input = { question: ctx.question, claims: c.claims };
        shared = { claims: c.claims.length, usage: c.usage };
      }
    }
    const r = await judgePanel(host, m, input, panel);
    if (r.score === undefined) return na(cfg, m, 'the judge found nothing to judge in the answer', { explanation: r.reasoning, metadata: judgeMeta(m, r, t) });
    const usage = shared ? { ...r.usage, calls: r.usage.calls + shared.usage.calls, inputTokens: r.usage.inputTokens + shared.usage.inputTokens, outputTokens: r.usage.outputTokens + shared.usage.outputTokens, costUsd: r.usage.costUsd + shared.usage.costUsd, cached: r.usage.cached && shared.usage.cached } : r.usage;
    return result(cfg, r.passed, describe(m, r.score, r, t, 'answer-relevance'), {
      source: 'ai-judge',
      score: r.score,
      explanation: r.reasoning,
      metadata: judgeMeta(m, { ...r, usage }, t, { promptVersion: m.version, mode: 'statements', ...(shared ? { shared: 'claims-v1', claims: shared.claims } : {}) }),
    });
  });

/* ------------------------------------------------------------------ context relevance */

const contextRelevance = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, CONTEXT_RELEVANCE_STATEMENTS, async (host) => {
    const mode = String(cfg.mode ?? 'nvidia');
    if (!['nvidia', 'statements', 'chunks', 'sentences'].includes(mode)) return result(cfg, false, `context-relevance mode must be nvidia, statements, chunks or sentences (got ${mode})`, { source: 'ai-judge' });
    if (!ctx.question) return result(cfg, false, 'context-relevance needs the question.', { source: 'ai-judge' });
    const t = num(cfg.threshold, 0.5);
    const docs = contextsInput(ctx);
    const all = docs.map((d) => d.text).join('\n').trim();
    const q = ctx.question.trim();
    // NVIDIA's own pre-check, for every mode: no context, or a context that is the question itself, is irrelevant without asking anyone
    if (!all || all === q || q.includes(all))
      return result(cfg, 0 >= t, `context-relevance 0: ${all ? 'the context is only the question' : 'nothing was retrieved'} (threshold ${t})`, { source: 'ai-judge', score: 0, explanation: all ? 'The context is contained in the question.' : 'No retrieved contexts.', metadata: { metric: 'context-relevance', mode, noCall: true, items: [], threshold: t } });
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    const input = { question: ctx.question, contexts: docs };
    const metrics = mode === 'nvidia' ? CONTEXT_RELEVANCE_NVIDIA : [mode === 'statements' ? CONTEXT_RELEVANCE_STATEMENTS : mode === 'chunks' ? CONTEXT_RELEVANCE_CHUNKS : CONTEXT_RELEVANCE_SENTENCES];
    const rs = await Promise.all(metrics.map((m) => judgePanel(host, m, input, panel)));
    const scored = rs.filter((r) => r.score !== undefined);
    const m = metrics[0]!;
    const first = rs[0]!;
    if (!scored.length) return na(cfg, m, 'the judge found nothing to judge in the retrieved text', { explanation: first.reasoning, metadata: judgeMeta(m, first, t, { mode }) });
    const score = round3(scored.reduce((a, r) => a + r.score!, 0) / scored.length);
    const usage = rs.reduce((a, r) => ({ calls: a.calls + r.usage.calls, inputTokens: a.inputTokens + r.usage.inputTokens, outputTokens: a.outputTokens + r.usage.outputTokens, costUsd: a.costUsd + r.usage.costUsd, cached: a.cached && r.usage.cached }), { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true });
    const passed = score >= t && !rs.some((r) => r.panel?.swap?.tie);
    const merged: PanelResult = { ...first, usage, items: rs.flatMap((r) => r.items) };
    return result(cfg, passed, mode === 'nvidia' ? `context-relevance ${score}: ratings ${rs.map((r) => r.items[0]?.rating ?? '?').join(' and ')} of 2 (threshold ${t})` : describe(m, score, first, t, 'context-relevance'), {
      source: 'ai-judge',
      score,
      explanation: first.reasoning,
      metadata: judgeMeta(m, merged, t, { mode, promptVersion: metrics.map((x) => x.version).join(' + '), ...(mode === 'nvidia' ? { itemLabels: ['relevant', 'irrelevant'] } : {}) }),
    });
  });

/* ------------------------------------------------------------------ registration */

const faithfulnessFn = strictOver(faithfulness, checkFn('groundedness'));
registerCheck('faithfulness', faithfulnessFn);
registerCheck('groundedness', faithfulnessFn);
// the R1a names always mean the strict metric, anywhere
registerCheck('rag-faithfulness', faithfulness);

const relevanceFn = strictOver(answerRelevance, checkFn('answer-relevance'));
registerCheck('answer-relevance', relevanceFn);
registerCheck('rag-answer-relevance', answerRelevance);

registerCheck('context-relevance', contextRelevance);

/** Names of the check types that ask a judge through the judge service (a run with one needs a judge before it starts). */
export function needsJudgeService(type: string, strictRun: boolean, cfg?: object): boolean {
  const resolved = resolveMetric(type);
  const id = resolved?.def.id ?? type;
  if (type === 'rag-faithfulness' || type === 'rag-answer-relevance') return true;
  const def = resolved?.def;
  if (!def) return false;
  // the model mode of entity recall (Ragas) asks a judge; its regex mode does not
  if (id === 'context-entity-recall') return ((cfg as { mode?: unknown } | undefined)?.mode ?? resolved.options.mode) === 'llm';
  if (def.kind !== 'judged' && def.judge !== 'service') return false;
  // these keep an older heuristic-or-`judge:` implementation outside a RAG run
  return def.judge === 'service' && (!HAS_LEGACY.has(id) || strictRun);
}

/** Metrics whose older implementation (checks.ts) still answers outside a RAG target run. */
const HAS_LEGACY = new Set(['faithfulness', 'answer-relevance', 'context-precision', 'context-recall', 'answer-correctness', 'factual-correctness']);
