/**
 * The RAG metrics of the first release (planning/rag-testing.md §2.3), registered as checks so they work anywhere a
 * check works (a test's assertions and evaluators, a saved evaluation, the matrix):
 *
 *  - against the reference answer, no model: `normalized-match`, `token-f1`, `rouge` (rouge1, rouge2, rougeL);
 *  - retrieval against the gold chunk ids, no model: `context-precision-ids`, `context-recall-ids`;
 *  - judged, through the judge service: faithfulness, answer-relevance, context-relevance (metrics-judged.ts);
 *  - the IR measures and the lexical metrics: metrics-ir.ts. All are described by one table, metric-defs.ts.
 *
 * Latency, tokens and cost are the existing `latency`, `tokens` and `cost` checks (a target fills them from the
 * response and the mapping). Every score is computed here from the numbers or the judge's verdicts, so it can be followed
 * item by item; "n/a" (nothing to judge) is neither a pass nor a fail and is not counted in a mean.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckDoc, type CheckContext } from '../checks.js';
import { idRetrieval, normalizeAnswer, round3, rouge, tokenOverlap, type RougeType } from './measures.js';
import { goldIds, needsReference, num, referenceOf, result } from './metric-util.js';
import './metrics-ir.js';
import './metrics-judged.js';
import './metric-defs.js';
import './metrics-more.js';
import './metric-defs-more.js';
import './metrics-retrieval-judged.js';
import './metrics-generation-judged.js';
import './metrics-claims.js';
import './judge-templates.js';
import './metric-defs-judged.js';
import './metrics-sql.js';
import './metric-defs-sql.js';
import './metrics-r3.js';

/**
 * What each metric reads, for the docs and the editors. They are not registered as the check registry's documented
 * checks: that list goes into every AI call that writes a test file, and a flow author has no use for RAG metrics.
 */
const RAG_CHECK_DOCS: Record<string, CheckDoc> = {};
const reg = (type: string, fn: Parameters<typeof registerCheck>[1], doc?: CheckDoc) => {
  registerCheck(type, fn);
  if (doc) RAG_CHECK_DOCS[type] = doc;
};


/* ------------------------------------------------------------------ answer against the reference */

reg(
  'normalized-match',
  (cfg, ctx) => {
    const ref = referenceOf(cfg, ctx);
    if (ref === undefined) return needsReference(cfg);
    const a = normalizeAnswer(ctx.text);
    const r = normalizeAnswer(ref);
    const ok = a === r;
    return result(cfg, ok, ok ? 'the answer matches the reference once case, punctuation and articles are ignored' : `the answer differs from the reference ("${a.slice(0, 80)}" vs "${r.slice(0, 80)}")`, { score: ok ? 1 : 0, expected: ref, actual: ctx.text.slice(0, 500) });
  },
  { fields: 'expected (default: the dataset record’s reference answer)', example: { type: 'normalized-match' } },
);

reg(
  'token-f1',
  (cfg, ctx) => {
    const ref = referenceOf(cfg, ctx);
    if (ref === undefined) return needsReference(cfg);
    const t = num(cfg.threshold, 0.5);
    const { precision, recall, f1 } = tokenOverlap(ctx.text, ref, { normalize: cfg.normalize === true });
    const score = round3(f1);
    return result(cfg, score >= t, `token F1 ${score} (precision ${round3(precision)}, recall ${round3(recall)}; threshold ${t})`, {
      source: 'heuristic',
      score,
      expected: ref,
      actual: ctx.text.slice(0, 500),
      metadata: { precision: round3(precision), recall: round3(recall), threshold: t },
    });
  },
  { fields: 'expected (default: the reference answer), threshold (default 0.5), normalize (drop punctuation and articles first)', example: { type: 'token-f1', threshold: 0.6 } },
);

const rougeCheck = (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
  const ref = referenceOf(cfg, ctx);
  if (ref === undefined) return needsReference(cfg);
  const kind = String(cfg.rouge ?? 'rougeL');
  if (!['rouge1', 'rouge2', 'rougeL'].includes(kind)) return result(cfg, false, `rouge must be rouge1, rouge2 or rougeL (got ${kind})`);
  const mode = String(cfg.mode ?? 'fmeasure');
  const t = num(cfg.threshold, 0.5);
  const r = rouge(ctx.text, ref, kind as RougeType);
  const score = round3(mode === 'precision' ? r.precision : mode === 'recall' ? r.recall : r.f1);
  return result(cfg, score >= t, `${kind} ${mode === 'fmeasure' ? 'F-measure' : mode} ${score} (precision ${round3(r.precision)}, recall ${round3(r.recall)}; threshold ${t})`, {
    source: 'heuristic',
    score,
    expected: ref,
    actual: ctx.text.slice(0, 500),
    metadata: { rouge: kind, mode, precision: round3(r.precision), recall: round3(r.recall), f1: round3(r.f1), threshold: t },
  });
};
reg('rouge', rougeCheck, { fields: 'rouge (rouge1 | rouge2 | rougeL, default rougeL), mode (fmeasure | precision | recall), threshold (default 0.5)', example: { type: 'rouge', rouge: 'rougeL', threshold: 0.5 } });
reg('rouge-l', rougeCheck);

/* ------------------------------------------------------------------ retrieval against the gold ids */

function idMetric(which: 'precision' | 'recall') {
  return (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
    const gold = goldIds(cfg, ctx);
    if (!gold)
      return result(cfg, false, `${cfg.type} needs the gold chunk ids: add a "reference_ids" column to the dataset (a list of ids).`, { explanation: 'No reference ids.' });
    if (!ctx.contexts?.length)
      return result(cfg, false, `${cfg.type}: nothing was retrieved. Map the contexts (and their ids) in the RAG target if the system returns them.`, {
        score: 0,
        explanation: 'No retrieved contexts.',
        expected: gold,
        actual: [],
      });
    const t = num(cfg.threshold, which === 'precision' ? 0.5 : 0.8);
    const r = idRetrieval(
      ctx.contexts.map((d) => d.id),
      gold,
    );
    const score = round3(r[which]);
    return result(cfg, score >= t, `context ${which} by id ${score}: ${r.hits.length} of ${which === 'precision' ? r.hits.length + r.extra.length + ' retrieved' : gold.length + ' gold'} ids match${r.missed.length ? `; missing ${r.missed.slice(0, 5).join(', ')}` : ''}${which === 'precision' && r.extra.length ? `; not gold: ${r.extra.slice(0, 5).join(', ')}` : ''} (threshold ${t})`, {
      score,
      expected: gold,
      actual: ctx.contexts.map((d) => d.id),
      metadata: { hits: r.hits, missed: r.missed, extra: r.extra, threshold: t },
    });
  };
}
reg('context-precision-ids', idMetric('precision'), {
  fields: 'expected (default: the record’s reference_ids), threshold (default 0.5)',
  example: { type: 'context-precision-ids' },
});
reg('context-recall-ids', idMetric('recall'), { fields: 'expected (default: the record’s reference_ids), threshold (default 0.8)', example: { type: 'context-recall-ids', threshold: 1 } });
