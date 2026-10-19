/**
 * The RAG metrics of the first release (planning/rag-testing.md §2.3), registered as checks so they work anywhere a
 * check works (a test's assertions and evaluators, a saved evaluation, the matrix):
 *
 *  - against the reference answer, no model: `normalized-match`, `token-f1`, `rouge` (rouge1, rouge2, rougeL);
 *  - retrieval against the gold chunk ids, no model: `context-precision-ids`, `context-recall-ids`;
 *  - judged, through the judge service: `rag-faithfulness`, `rag-answer-relevance`.
 *
 * Latency, tokens and cost are the existing `latency`, `tokens` and `cost` checks (a target fills them from the
 * response and the mapping). Every score is computed here from the numbers or the judge's verdicts, so it can be followed
 * item by item; "n/a" (nothing to judge) is neither a pass nor a fail and is not counted in a mean.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckDoc, type CheckContext } from '../checks.js';
import { idRetrieval, normalizeAnswer, round3, rouge, tokenOverlap, type RougeType } from './measures.js';
import { assertJudgeUsable, judgeCall, type JudgeRef } from './judge.js';
import { ANSWER_RELEVANCE, FAITHFULNESS, JUDGED_METRICS, type JudgedMetric } from './judge-prompts.js';

/**
 * What each metric reads, for the docs and the editors. They are not registered as the check registry's documented
 * checks: that list goes into every AI call that writes a test file, and a flow author has no use for RAG metrics.
 */
export const RAG_CHECK_DOCS: Record<string, CheckDoc> = {};
const reg = (type: string, fn: Parameters<typeof registerCheck>[1], doc?: CheckDoc) => {
  registerCheck(type, fn);
  if (doc) RAG_CHECK_DOCS[type] = doc;
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

function result(cfg: CheckConfig, passed: boolean, message: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { type: cfg.type, name: cfg.name ?? cfg.type, passed, source: 'deterministic', message, ...extra };
}

/** The check types that ask a judge model (a run with one of them needs a judge before it starts). */
export const JUDGED_CHECK_TYPES: ReadonlySet<string> = new Set(JUDGED_METRICS.map((m) => m.id));

const needsReference = (cfg: CheckConfig) =>
  result(cfg, false, `${cfg.type} needs a reference answer: add a "reference" column to the dataset (or set "expected" on the check).`, { explanation: 'No reference answer to compare with.' });

const referenceOf = (cfg: CheckConfig, ctx: CheckContext): string | undefined => {
  const r = cfg.expected ?? ctx.expected;
  return r === undefined || r === null || r === '' ? undefined : text(r);
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
    const gold = Array.isArray(cfg.expected) ? cfg.expected.map(String) : ctx.referenceIds;
    if (!gold?.length)
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

/* ------------------------------------------------------------------ judged */

const na = (cfg: CheckConfig, m: JudgedMetric, why: string): CheckResult =>
  result(cfg, true, `${m.id} is n/a: ${why}`, { source: 'ai-judge', explanation: why, metadata: { na: why, promptVersion: m.version } });

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One judged metric as a check (see the module comment): the score is the share of items with a true verdict. */
function judgedCheck(m: JudgedMetric, defaultThreshold: number) {
  return async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
    const host = ctx.services?.ragJudge;
    if (!host) return result(cfg, false, `${m.id} needs a judge model and none is available here.`, { source: 'ai-judge' });
    const answer = ctx.text ?? '';
    const docs = ctx.contexts ?? [];
    if (m.inputs.includes('contexts') && !docs.length)
      return result(cfg, false, `${m.id} needs the retrieved contexts: in the RAG target, click the list of sources in the sample response and map it (or turn on the endpoint’s "return sources" option).`, { source: 'ai-judge', explanation: 'No retrieved contexts.' });
    if (m.inputs.includes('question') && !ctx.question) return result(cfg, false, `${m.id} needs the question.`, { source: 'ai-judge' });
    if (!answer.trim()) return m.empty === 'na' ? na(cfg, m, 'the answer is empty') : result(cfg, false, `${m.id} 0: the answer is empty`, { source: 'ai-judge', score: 0, metadata: { items: [], promptVersion: m.version } });
    const input: Record<string, unknown> = {};
    for (const f of m.inputs) input[f] = f === 'answer' ? answer : f === 'question' ? ctx.question : f === 'contexts' ? docs.map((d) => ({ id: d.id, text: d.text })) : referenceOf(cfg, ctx);
    // a check's own judge (`judge: { provider, model }`; `name` as the other judged checks write it), else the evaluation's
    const own = cfg.judge as { provider?: string; model?: string; name?: string } | undefined;
    const judge: JudgeRef = { ...(ctx.judge ?? {}), ...(own?.provider ? { provider: own.provider, model: own.model ?? own.name } : {}) };
    const t = num(cfg.threshold, defaultThreshold);
    try {
      assertJudgeUsable(host, judge);
      const span = ctx.services?.span?.child(`judge ${m.id}`, 'llm', { attributes: { metric: m.id, version: m.version } });
      let a;
      try {
        a = await judgeCall(host, m, input, { judge, signal: ctx.services?.signal });
        span?.end({ output: { items: a.verdict.items.length, cached: a.cached } });
      } catch (e) {
        span?.fail(e);
        throw e;
      }
      const items = a.verdict.items.map((i) => ({ text: i.text.slice(0, 500), ok: i.verdict, evidence: i.reason.slice(0, 300) }));
      const jm = { judge: { ...a.judge, cached: a.cached }, judgeUsage: { ...a.usage, cached: a.cached }, itemLabels: m.labels, items, threshold: t, redactions: a.redactionCount };
      if (!items.length) return { ...na(cfg, m, m.id === FAITHFULNESS.id ? 'the answer makes no factual claims' : 'the judge found nothing to judge in the answer'), metadata: { na: 'nothing to judge', ...jm }, explanation: a.verdict.reasoning };
      const ok = items.filter((i) => i.ok).length;
      const score = round3(ok / items.length);
      const bad = items.filter((i) => !i.ok);
      return result(cfg, score >= t, `${m.id} ${score}: ${ok} of ${items.length} ${m.noun} ${m.labels[0]}${bad.length ? `; ${m.labels[1]}: ${bad.slice(0, 3).map((i) => `"${short(i.text)}"`).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}` : ''} (threshold ${t})`, {
        source: 'ai-judge',
        score,
        explanation: a.verdict.reasoning,
        metadata: jm,
      });
    } catch (e) {
      const budget = (e as { details?: { budget?: boolean } }).details?.budget;
      return result(cfg, false, budget ? `${m.id} n/a: ${(e as Error).message}` : `judge failed: ${(e as Error).message}`, { source: 'ai-judge', metadata: { ...(budget ? { na: 'budget' } : {}), promptVersion: m.version } });
    }
  };
}

reg('rag-faithfulness', judgedCheck(FAITHFULNESS, 0.8), {
  fields: 'threshold (default 0.8), judge: { provider, model } (default: the evaluation’s judge)',
  example: { type: 'rag-faithfulness', threshold: 0.8 },
});
reg('rag-answer-relevance', judgedCheck(ANSWER_RELEVANCE, 0.7), {
  fields: 'threshold (default 0.7), judge: { provider, model } (default: the evaluation’s judge)',
  example: { type: 'rag-answer-relevance', threshold: 0.7 },
});
