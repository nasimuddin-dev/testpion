/**
 * The retrieval metrics that need no model: the IR measures over the gold chunk ids (recall@k, precision@k, hit-rate@k,
 * mrr@k, ndcg@k, map@k, r-precision), the lexical context precision and recall against the gold chunk TEXTS, and
 * string similarity of the answer to the reference. Registered as checks, described in metric-defs.ts.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckContext } from '../checks.js';
import { averagePrecisionAt, hitRateAt, mrrAt, ndcgAt, ndcgGraded, precisionAt, rankedAveragePrecision, recallAt, rPrecision, similarityRatio } from './ir.js';
import { round3 } from './measures.js';
import { goldIds, needsReference, num, referenceOf, result, short } from './metric-util.js';

type IrFn = (retrieved: string[], gold: string[], k: number) => number;
const IR: Array<[string, IrFn, number, string]> = [
  ['recall@k', (r, g, k) => recallAt(r, g, k), 0.8, 'of the gold ids are in the top'],
  ['precision@k', (r, g, k) => precisionAt(r, g, k), 0.3, 'of the top'],
  ['hit-rate@k', (r, g, k) => hitRateAt(r, g, k), 1, 'hit in the top'],
  ['mrr@k', (r, g, k) => mrrAt(r, g, k), 0.5, 'reciprocal rank in the top'],
  ['ndcg@k', (r, g, k) => ndcgAt(r, g, k), 0.6, 'nDCG in the top'],
  ['map@k', (r, g, k) => averagePrecisionAt(r, g, k), 0.5, 'average precision in the top'],
];

for (const [type, fn, defaultThreshold] of IR) {
  registerCheck(type, (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
    // graded relevance (a `relevance` column of qrels) is enough for nDCG: the grades say which chunks are gold
    const grades = type === 'ndcg@k' ? ctx.record?.relevance : undefined;
    const gold = goldIds(cfg, ctx) ?? (grades ? [] : undefined);
    if (!gold) return result(cfg, false, `${type} needs the gold chunk ids: add a "reference_ids" column to the dataset (a list of ids).`, { explanation: 'No reference ids.' });
    const k = Math.max(1, Math.floor(num(cfg.k, 10)));
    const ids = (ctx.contexts ?? []).map((d) => d.id);
    const t = num(cfg.threshold, defaultThreshold);
    // nothing retrieved is a real failure of the retriever: 0, not n/a
    const score = round3(grades ? ndcgGraded(ids, grades, k, { gain: cfg.gain === 'exponential' ? 'exponential' : 'linear', gold }) : fn(ids, gold, k));
    return result(cfg, score >= t, `${type.replace('@k', `@${k}`)} ${score}${ids.length ? '' : ' (nothing was retrieved)'} (threshold ${t})`, {
      source: 'deterministic',
      score,
      expected: gold,
      actual: ids.slice(0, k),
      metadata: { k, retrieved: ids.length, gold: gold.length, threshold: t },
    });
  });
}

registerCheck('r-precision', (cfg, ctx) => {
  const gold = goldIds(cfg, ctx);
  if (!gold) return result(cfg, false, 'r-precision needs the gold chunk ids: add a "reference_ids" column to the dataset (a list of ids).', { explanation: 'No reference ids.' });
  const ids = (ctx.contexts ?? []).map((d) => d.id);
  const t = num(cfg.threshold, 0.5);
  const score = round3(rPrecision(ids, gold));
  return result(cfg, score >= t, `r-precision ${score} (R = ${new Set(gold).size}; threshold ${t})`, { score, expected: gold, actual: ids.slice(0, gold.length), metadata: { threshold: t } });
});

/* ------------------------------------------------------------------ against the gold chunk texts */

const goldTexts = (cfg: CheckConfig, ctx: CheckContext): string[] | undefined => {
  const g = Array.isArray(cfg.expected) ? cfg.expected.map(String) : ctx.referenceContexts;
  return g?.length ? g : undefined;
};
const noGoldTexts = (cfg: CheckConfig) => result(cfg, false, `${cfg.type} needs the gold chunk texts: add a "reference_contexts" column to the dataset (a list of texts).`, { explanation: 'No reference contexts.' });

registerCheck('context-precision-lexical', (cfg, ctx) => {
  const gold = goldTexts(cfg, ctx);
  if (!gold) return noGoldTexts(cfg);
  const docs = ctx.contexts ?? [];
  const sim = num(cfg.similarity, 0.5);
  const t = num(cfg.threshold, 0.5);
  if (!docs.length) return result(cfg, false, 'context-precision-lexical: nothing was retrieved', { score: 0, explanation: 'No retrieved contexts.' });
  const best = docs.map((d) => Math.max(...gold.map((g) => similarityRatio(d.text, g))));
  const relevant = best.map((b) => b >= sim);
  const score = round3(rankedAveragePrecision(relevant));
  return result(cfg, score >= t, `lexical context precision ${score}: ${relevant.filter(Boolean).length} of ${docs.length} chunks match a gold chunk (similarity ≥ ${sim}; threshold ${t})`, {
    source: 'heuristic',
    score,
    metadata: { items: docs.map((d, i) => ({ text: d.id, ok: relevant[i]!, evidence: `similarity ${round3(best[i]!)}` })), itemLabels: ['matches a gold chunk', 'matches none'], threshold: t },
  });
});

registerCheck('context-recall-lexical', (cfg, ctx) => {
  const gold = goldTexts(cfg, ctx);
  if (!gold) return noGoldTexts(cfg);
  const docs = ctx.contexts ?? [];
  const sim = num(cfg.similarity, 0.5);
  const t = num(cfg.threshold, 0.8);
  // Ragas’ non-LLM recall: strictly above the similarity
  const best = gold.map((g) => (docs.length ? Math.max(...docs.map((d) => similarityRatio(d.text, g))) : 0));
  const found = best.map((b) => b > sim);
  const score = round3(found.filter(Boolean).length / gold.length);
  return result(cfg, score >= t, `lexical context recall ${score}: ${found.filter(Boolean).length} of ${gold.length} gold chunks found (similarity > ${sim}; threshold ${t})`, {
    source: 'heuristic',
    score,
    metadata: { items: gold.map((g, i) => ({ text: short(g, 120), ok: found[i]!, evidence: `best similarity ${round3(best[i]!)}` })), itemLabels: ['retrieved', 'missing'], threshold: t },
  });
});

registerCheck('string-similarity', (cfg, ctx) => {
  const ref = referenceOf(cfg, ctx);
  if (ref === undefined) return needsReference(cfg);
  const fold = (s: string) => (cfg.normalize === true ? s.trim().toLowerCase() : s);
  const t = num(cfg.threshold, 0.8);
  const score = round3(similarityRatio(fold(ctx.text), fold(ref)));
  return result(cfg, score >= t, `string similarity ${score} (threshold ${t})`, { source: 'heuristic', score, expected: ref, actual: ctx.text.slice(0, 500), metadata: { threshold: t } });
});
