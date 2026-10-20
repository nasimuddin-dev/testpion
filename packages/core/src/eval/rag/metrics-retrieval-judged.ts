/**
 * The judged retrieval metrics on the judge service (planning/rag-testing.md §2.3, type 1): context precision, context
 * utilization, context recall, the model mode of context entity recall and judged retrieval relevance. In a RAG target
 * run (or a rescore, or Try) they are strict, as faithfulness is: no judge, no score; the verdicts are cached by content, the
 * calls are in the usage ledger, juries / swap / repeat apply. Outside one, `context-precision` and `context-recall` keep
 * their older heuristic-or-`judge:` implementation (checks.ts) under the same names.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { checkFn, registerCheck, type CheckContext } from '../checks.js';
import { rankedAveragePrecision } from './ir.js';
import { addUsage, assertJudgeUsable, contextsInput, describe, guarded, judgedCheck, judgeMeta, judgePanel, na, needContexts, needsField, noUsage, panelOf, referenceText, round3, strictOver, type Usage } from './judged-kit.js';
import { CONTEXT_PRECISION, CONTEXT_PRECISION_ONE, CONTEXT_RECALL, CONTEXT_UTILIZATION, ENTITIES_OF_CONTEXTS, ENTITIES_OF_REFERENCE, RETRIEVAL_RELEVANCE } from './prompts-r2.js';
import { num, result } from './metric-util.js';
import { hitRateAt, ndcgAt, precisionAt, mrrAt } from './ir.js';

/* ------------------------------------------------------------------ context precision and utilization */

/** One verdict per chunk, rank-weighted: the shape of context precision and of utilization. */
async function rankedVerdicts(cfg: CheckConfig, ctx: CheckContext, o: { id: string; metric: typeof CONTEXT_PRECISION; one?: typeof CONTEXT_PRECISION_ONE; target: Record<string, unknown>; threshold: number }): Promise<CheckResult> {
  return guarded(cfg, ctx, o.metric, async (host) => {
    const docs = contextsInput(ctx);
    if (!docs.length) return needContexts(cfg, o.id);
    const t = num(cfg.threshold, o.threshold);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    const base = { question: ctx.question ?? '', ...o.target };
    // Ragas asks once per chunk; asking once for all chunks is cheaper and the default
    if (cfg.perChunk === true && o.one) {
      const rs = await Promise.all(docs.map((d) => judgePanel(host, o.one!, { ...base, contexts: [d] }, panel)));
      const flags = rs.map((r) => r.items[0]?.ok === true);
      const score = round3(rankedAveragePrecision(flags));
      const usage = rs.reduce<Usage>((a, r) => addUsage(a, r.usage), noUsage());
      const first = rs[0]!;
      return result(cfg, score >= t, `${o.id} ${score}: ${flags.filter(Boolean).length} of ${docs.length} chunks ${o.metric.labels[0]}, rank-weighted (one judge call per chunk; threshold ${t})`, {
        source: 'ai-judge',
        score,
        explanation: first.reasoning,
        metadata: judgeMeta(o.metric, { ...first, usage, items: docs.map((d, i) => ({ text: d.id, ok: flags[i]!, evidence: rs[i]!.items[0]?.evidence ?? '' })) }, t, { promptVersion: o.one.version, perChunk: true }),
      });
    }
    const r = await judgePanel(host, o.metric, { ...base, contexts: docs }, panel);
    if (r.score === undefined) return na(cfg, o.metric, 'the judge returned no verdict for the retrieved chunks', { explanation: r.reasoning, metadata: judgeMeta(o.metric, r, t) });
    const score = round3(r.score);
    return result(cfg, score >= t && !r.panel?.swap?.tie, describe(o.metric, score, r, t, o.id), {
      source: 'ai-judge',
      score,
      explanation: r.reasoning,
      metadata: judgeMeta(o.metric, r, t, { promptVersion: o.metric.version, ...(r.items.length !== docs.length ? { itemsMismatch: `${r.items.length} verdicts for ${docs.length} chunks` } : {}) }),
    });
  });
}

const contextPrecision = (cfg: CheckConfig, ctx: CheckContext) => {
  if (!ctx.question) return Promise.resolve(needsField(cfg, 'context-precision', 'the question', 'the dataset needs a "question" column.'));
  const reference = referenceText(cfg, ctx);
  // Ragas' with-reference form judges against the reference; without one the answer is the target (its "without reference" form)
  if (!reference && !ctx.text?.trim()) return Promise.resolve(needsField(cfg, 'context-precision', 'a reference answer', 'add a "reference" column to the dataset (or use the answer: it is empty here).'));
  return rankedVerdicts(cfg, ctx, { id: 'context-precision', metric: CONTEXT_PRECISION, one: CONTEXT_PRECISION_ONE, target: reference ? { reference } : { answer: ctx.text }, threshold: 0.5 });
};

const contextUtilization = (cfg: CheckConfig, ctx: CheckContext) => {
  if (!ctx.question) return Promise.resolve(needsField(cfg, 'context-utilization', 'the question', 'the dataset needs a "question" column.'));
  if (!ctx.text?.trim()) return Promise.resolve(na(cfg, CONTEXT_UTILIZATION, 'the answer is empty'));
  return rankedVerdicts(cfg, ctx, { id: 'context-utilization', metric: CONTEXT_UTILIZATION, target: { answer: ctx.text }, threshold: 0.5 });
};

/* ------------------------------------------------------------------ context recall */

const contextRecall = judgedCheck({
  metric: CONTEXT_RECALL,
  id: 'context-recall',
  threshold: 0.8,
  needs: ['reference', 'contexts'],
  input: (cfg, ctx) => ({ question: ctx.question ?? '', reference: referenceText(cfg, ctx), contexts: contextsInput(ctx) }),
  emptyWhy: 'the reference makes no statements to look for',
});

/* ------------------------------------------------------------------ context entity recall, model mode */

const entityKey = (e: string, caseSensitive: boolean) => (caseSensitive ? e.trim() : e.trim().toLowerCase());

/** Ragas' ContextEntityRecall: a model lists the entities of the reference and of the contexts; |E_C ∩ E_R| / |E_R|. */
const entityRecallLlm = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, ENTITIES_OF_REFERENCE, async (host) => {
    const reference = referenceText(cfg, ctx);
    if (!reference) return needsField(cfg, 'context-entity-recall', 'a reference answer', 'add a "reference" column to the dataset (or set "expected" on the check).');
    if (!ctx.contexts?.length) return needContexts(cfg, 'context-entity-recall');
    const t = num(cfg.threshold, 0.8);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    const one = { ...panel, judges: panel.judges?.slice(0, 1), swap: false, repeat: 1 };
    const [er, ec] = await Promise.all([judgePanel(host, ENTITIES_OF_REFERENCE, { reference }, one), judgePanel(host, ENTITIES_OF_CONTEXTS, { contexts: contextsInput(ctx) }, one)]);
    const cs = cfg.caseSensitive === true;
    const ref = [...new Map(er.items.map((i) => [entityKey(i.text, cs), i.text.trim()])).entries()];
    if (!ref.length) return na(cfg, ENTITIES_OF_REFERENCE, 'the reference names no entity', { explanation: er.reasoning, metadata: judgeMeta(ENTITIES_OF_REFERENCE, er, t) });
    const inCtx = new Set(ec.items.map((i) => entityKey(i.text, cs)));
    const items = ref.map(([k, text]) => ({ text, ok: inCtx.has(k), evidence: inCtx.has(k) ? 'named in the retrieved documents' : 'not named in the retrieved documents' }));
    const score = round3(items.filter((i) => i.ok).length / items.length);
    const usage = addUsage(er.usage, ec.usage);
    return result(cfg, score >= t, `context entity recall ${score}: ${items.filter((i) => i.ok).length} of ${items.length} entities of the reference are in the retrieved documents (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: er.reasoning,
      metadata: judgeMeta(ENTITIES_OF_REFERENCE, { ...er, usage, items }, t, { mode: 'llm', promptVersion: `${ENTITIES_OF_REFERENCE.version} + ${ENTITIES_OF_CONTEXTS.version}`, itemLabels: ['found', 'missing'], contextEntities: ec.items.length }),
    });
  });

/* ------------------------------------------------------------------ judged retrieval relevance */

/** Labels per chunk, then precision@k, MRR or nDCG over those labels (no recall: the documents that were not retrieved are unknown). */
const retrievalRelevance = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, RETRIEVAL_RELEVANCE, async (host) => {
    if (!ctx.question) return needsField(cfg, 'retrieval-relevance', 'the question', 'the dataset needs a "question" column.');
    const docs = contextsInput(ctx);
    if (!docs.length) return needContexts(cfg, 'retrieval-relevance');
    const t = num(cfg.threshold, 0.5);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    const r = await judgePanel(host, RETRIEVAL_RELEVANCE, { question: ctx.question, contexts: docs }, { ...panel, swap: false });
    if (!r.items.length) return na(cfg, RETRIEVAL_RELEVANCE, 'the judge labelled no chunk', { explanation: r.reasoning, metadata: judgeMeta(RETRIEVAL_RELEVANCE, r, t) });
    const labels = docs.map((d, i) => (r.items[i]?.ok ? d.id : undefined)).filter((x): x is string => x !== undefined);
    const ids = docs.map((d) => d.id);
    const k = Math.max(1, Math.floor(num(cfg.k, docs.length)));
    const measure = String(cfg.measure ?? 'precision');
    const fn = measure === 'mrr' ? mrrAt : measure === 'ndcg' ? ndcgAt : measure === 'hit-rate' ? hitRateAt : precisionAt;
    const score = round3(fn(ids, labels, k));
    return result(cfg, score >= t, `retrieval relevance (${measure}@${k}) ${score}: ${labels.length} of ${docs.length} chunks labelled relevant (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: r.reasoning,
      metadata: judgeMeta(RETRIEVAL_RELEVANCE, r, t, { promptVersion: RETRIEVAL_RELEVANCE.version, measure, k }),
    });
  });

/* ------------------------------------------------------------------ registration */

// the regex mode of entity recall stays in checks.ts; the model mode is this
const legacyEntity = checkFn('context-entity-recall');
registerCheck('context-entity-recall', (cfg, ctx) => (cfg.mode === 'llm' ? entityRecallLlm(cfg, ctx) : legacyEntity ? legacyEntity(cfg, ctx) : result(cfg, false, 'context-entity-recall is not available')));
registerCheck('context-precision', strictOver(contextPrecision, checkFn('context-precision')));
registerCheck('context-recall', strictOver(contextRecall, checkFn('context-recall')));
registerCheck('context-utilization', contextUtilization);
registerCheck('retrieval-relevance', retrievalRelevance);

