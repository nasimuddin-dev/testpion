/**
 * The judged generation metrics on the judge service (planning/rag-testing.md §2.3, type 3): factual correctness (claims
 * both ways) and Ragas' answer correctness (factual F1 + semantic similarity), NVIDIA's whole-answer ratings (answer accuracy,
 * response groundedness; two prompts averaged, one invalid rating falls back to the other), DeepEval's hallucination
 * (lower is better), correctness, completeness, factuality, citation accuracy, negative rejection, and the RAGAS aggregate.
 * In a RAG target run they are strict (no judge, no score); `answer-correctness` outside one keeps its older heuristic.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { checkFn, registerCheck, type CheckContext } from '../checks.js';
import { sentences } from '../text.js';
import { answerClaims, answerVsReference, envOf, referenceClaims, referenceVsAnswer, type PassEnv } from './claim-passes.js';
import { embedTexts, cosine } from './embed-util.js';
import { REFUSAL } from './failure.js';
import { addUsage, assertJudgeUsable, contextsInput, describe, guarded, judgeMeta, judgePanel, judgedCheck, na, needContexts, needsField, noUsage, panelOf, referenceText, round3, strictOver, type JudgeHost, type PanelResult, type Usage } from './judged-kit.js';
import { ANSWER_ACCURACY, CITATION_ACCURACY, COMPLETENESS, CORRECTNESS, FACTUALITY, HALLUCINATION, RESPONSE_GROUNDEDNESS } from './prompts-r2.js';
import { num, result } from './metric-util.js';
import type { JudgedMetric } from './judge-prompts.js';

/* ------------------------------------------------------------------ factual correctness */

interface Factual {
  precision?: number;
  recall?: number;
  items: Array<{ text: string; ok: boolean; evidence: string }>;
  usage: Usage;
  judge: PanelResult['judge'];
  redactions: number;
  claimsAnswer: number;
  claimsReference: number;
}

/** The claims of the answer against the reference and the claims of the reference against the answer (2 calls each side). */
async function factualParts(env: PassEnv, ctx: CheckContext, reference: string, mode: string): Promise<Factual> {
  let usage = noUsage();
  let judge: PanelResult['judge'] | undefined;
  let redactions = 0;
  const items: Factual['items'] = [];
  let precision: number | undefined;
  let recall: number | undefined;
  const [a, r] = await Promise.all([answerClaims(env), referenceClaims(env, reference)]);
  usage = addUsage(addUsage(usage, a.usage), r.usage);
  judge ??= a.judge;
  // a reference without claims makes recall (and F1) undefined: no verdict is worth asking for
  const early = mode !== 'precision' && !r.texts.length;
  const [pv, rv] = early
    ? [undefined, undefined]
    : await Promise.all([mode !== 'recall' && a.texts.length ? answerVsReference(env, a.texts, reference) : undefined, mode !== 'precision' && r.texts.length ? referenceVsAnswer(env, r.texts, ctx.text) : undefined]);
  if (pv) {
    usage = addUsage(usage, pv.usage);
    redactions = Math.max(redactions, pv.redactions);
    precision = pv.flags.filter(Boolean).length / pv.flags.length;
    pv.texts.forEach((t, i) => items.push({ text: `answer: ${t}`, ok: pv.flags[i]!, evidence: pv.items[i]?.evidence ?? '' }));
  }
  if (rv) {
    usage = addUsage(usage, rv.usage);
    redactions = Math.max(redactions, rv.redactions);
    recall = rv.flags.filter(Boolean).length / rv.flags.length;
    rv.texts.forEach((t, i) => items.push({ text: `reference: ${t}`, ok: rv.flags[i]!, evidence: rv.items[i]?.evidence ?? '' }));
  }
  return { precision, recall, items, usage, judge: judge!, redactions, claimsAnswer: a.texts.length, claimsReference: r.texts.length };
}

const fbeta = (p: number, r: number, beta: number) => (p + r > 0 ? ((1 + beta * beta) * p * r) / (beta * beta * p + r) : 0);

/** Factual F-beta / precision / recall of the answer's claims against the reference's; undefined when it cannot be computed. */
function factualScore(f: Factual, mode: string, beta: number): { score?: number; why?: string } {
  if (mode === 'precision') return f.claimsAnswer ? { score: f.precision } : { why: 'the answer makes no factual claims' };
  if (!f.claimsReference) return { why: 'the reference makes no factual claims' };
  if (mode === 'recall') return { score: f.recall };
  // an answer without claims (a refusal) against a reference that has some: nothing it says is right
  return { score: fbeta(f.precision ?? 0, f.recall ?? 0, beta) };
}

const factualCorrectness = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, { id: 'factual-correctness', version: 'factual-correctness-v2' }, async (host) => {
    const reference = referenceText(cfg, ctx);
    if (!reference) return needsField(cfg, 'factual-correctness', 'a reference answer', 'add a "reference" column to the dataset (or set "expected" on the check).');
    if (!ctx.text.trim()) return na(cfg, { id: 'factual-correctness', version: 'factual-correctness-v2' }, 'the answer is empty');
    const mode = String(cfg.mode ?? 'f1');
    if (!['f1', 'precision', 'recall'].includes(mode)) return result(cfg, false, `factual-correctness mode must be f1, precision or recall (got ${mode})`, { source: 'ai-judge' });
    const t = num(cfg.threshold, 0.7);
    const env = envOf(cfg, ctx, host, t, 'higher', 'factual-correctness');
    assertJudgeUsable(host, env.panel.judges?.[0] ?? env.panel.judge);
    const f = await factualParts(env, ctx, reference, mode);
    const { score: raw, why } = factualScore(f, mode, num(cfg.beta, 1));
    const m = { id: 'factual-correctness', version: 'factual-correctness-v2' };
    if (raw === undefined) return na(cfg, m, why ?? 'nothing to compare', { metadata: { itemLabels: ['supported', 'not supported'], items: f.items, judgeUsage: f.usage, judge: { ...f.judge, cached: f.usage.cached } } });
    const score = round3(raw);
    return result(cfg, score >= t, `factual correctness ${mode} ${score}${f.precision !== undefined ? ` (precision ${round3(f.precision)}` : ' ('}${f.recall !== undefined ? `${f.precision !== undefined ? ', ' : ''}recall ${round3(f.recall)}` : ''}; threshold ${t})`, {
      source: 'ai-judge',
      score,
      metadata: {
        metric: 'factual-correctness',
        mode,
        ...(f.precision !== undefined ? { precision: round3(f.precision) } : {}),
        ...(f.recall !== undefined ? { recall: round3(f.recall) } : {}),
        items: f.items.map((i) => ({ ...i, evidence: i.evidence.slice(0, 300) })),
        itemLabels: ['supported', 'not supported'],
        judge: { ...f.judge, cached: f.usage.cached },
        judgeUsage: f.usage,
        promptVersion: 'factual-correctness-v2',
        threshold: t,
        redactions: f.redactions,
      },
    });
  });

/* ------------------------------------------------------------------ answer correctness (Ragas: factual + semantic) */

const answerCorrectness = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, { id: 'answer-correctness', version: 'answer-correctness-v1' }, async (host) => {
    const m = { id: 'answer-correctness', version: 'answer-correctness-v1' };
    const reference = referenceText(cfg, ctx);
    if (!reference) return needsField(cfg, 'answer-correctness', 'a reference answer', 'add a "reference" column to the dataset (or set "expected" on the check).');
    if (!ctx.text.trim()) return na(cfg, m, 'the answer is empty');
    const weights = Array.isArray(cfg.weights) && cfg.weights.length === 2 && cfg.weights.every((w) => typeof w === 'number' && w >= 0) ? (cfg.weights as number[]) : [0.75, 0.25];
    const sum = weights[0]! + weights[1]!;
    if (!sum) return result(cfg, false, 'answer-correctness weights must not both be 0', { source: 'ai-judge' });
    const t = num(cfg.threshold, 0.6);
    const env = envOf(cfg, ctx, host, t, 'higher', 'answer-correctness');
    assertJudgeUsable(host, env.panel.judges?.[0] ?? env.panel.judge);
    const f = await factualParts(env, ctx, reference, 'f1');
    const { score: factual, why } = factualScore(f, 'f1', 1);
    if (factual === undefined) return na(cfg, m, why ?? 'nothing to compare', { metadata: { items: f.items, itemLabels: ['supported', 'not supported'], judgeUsage: f.usage } });
    let similarity = 0;
    let embedder = '';
    if (weights[1]! > 0) {
      const e = await embedTexts(cfg, ctx, [ctx.text, reference]);
      similarity = Math.max(0, Math.min(1, cosine(e.vectors[0]!, e.vectors[1]!)));
      embedder = e.embedder;
    }
    const score = round3((weights[0]! * factual + weights[1]! * similarity) / sum);
    return result(cfg, score >= t, `answer correctness ${score}: ${weights[0]} × factual F1 ${round3(factual)} + ${weights[1]} × semantic similarity ${round3(similarity)} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      metadata: {
        metric: 'answer-correctness',
        factual: round3(factual),
        similarity: round3(similarity),
        weights,
        ...(embedder ? { embedder } : {}),
        items: f.items,
        itemLabels: ['supported', 'not supported'],
        judge: { ...f.judge, cached: f.usage.cached },
        judgeUsage: f.usage,
        promptVersion: m.version,
        threshold: t,
      },
    });
  });

/* ------------------------------------------------------------------ the NVIDIA ratings: two prompts, averaged */

/**
 * Several prompts that each rate the whole sample; the score is the mean of the ratings that came back valid. A prompt whose
 * verdict is not valid is left out and the other one counts (NVIDIA's rule); when none is valid the judge failed.
 */
async function ratedTwice(cfg: CheckConfig, ctx: CheckContext, host: JudgeHost, o: { id: string; prompts: readonly JudgedMetric[]; inputs: Array<Record<string, unknown>>; threshold: number; labels: [string, string] }): Promise<CheckResult> {
  const t = num(cfg.threshold, o.threshold);
  const panel = panelOf(cfg, ctx, t);
  assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
  const settled = await Promise.allSettled(o.prompts.map((p, i) => judgePanel(host, p, o.inputs[i]!, panel)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<PanelResult> => s.status === 'fulfilled');
  if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
  const scored = ok.filter((s) => s.value.score !== undefined);
  const first = ok[0]!.value;
  const m = o.prompts[0]!;
  if (!scored.length) return na(cfg, m, 'the judge gave no rating', { explanation: first.reasoning, metadata: judgeMeta(m, first, t) });
  const score = round3(scored.reduce((a, s) => a + s.value.score!, 0) / scored.length);
  const usage = ok.reduce<Usage>((a, s) => addUsage(a, s.value.usage), noUsage());
  const dropped = settled.length - ok.length;
  const max = m.rating ?? 1;
  const tie = ok.some((s) => s.value.panel?.swap?.tie);
  return result(cfg, score >= t && !tie, `${o.id} ${score}: ratings ${ok.map((s) => s.value.items[0]?.rating ?? '?').join(' and ')} of ${max}${dropped ? ` (${dropped} prompt${dropped > 1 ? 's' : ''} gave no valid rating and ${dropped > 1 ? 'were' : 'was'} left out)` : ''} (threshold ${t})`, {
    source: 'ai-judge',
    score,
    explanation: first.reasoning,
    metadata: judgeMeta(m, { ...first, usage, items: ok.flatMap((s) => s.value.items) }, t, { promptVersion: o.prompts.map((p) => p.version).join(' + '), itemLabels: o.labels, ...(dropped ? { invalidRatings: dropped } : {}) }),
  });
}

const responseGroundedness = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, RESPONSE_GROUNDEDNESS[0]!, async (host) => {
    const docs = contextsInput(ctx);
    // NVIDIA's own pre-check: a blank answer or blank context scores 0 without asking
    if (!ctx.text.trim() || !docs.some((d) => d.text.trim())) return result(cfg, 0 >= num(cfg.threshold, 0.5), `response-groundedness 0: ${ctx.text.trim() ? 'nothing was retrieved' : 'the answer is empty'}`, { source: 'ai-judge', score: 0, metadata: { metric: 'response-groundedness', noCall: true, items: [], threshold: num(cfg.threshold, 0.5) } });
    const prompts = cfg.prompts === 1 ? RESPONSE_GROUNDEDNESS.slice(0, 1) : RESPONSE_GROUNDEDNESS;
    return ratedTwice(cfg, ctx, host, { id: 'response-groundedness', prompts, inputs: prompts.map(() => ({ answer: ctx.text, contexts: docs })), threshold: 0.5, labels: ['grounded', 'not grounded'] });
  });

const answerAccuracy = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, ANSWER_ACCURACY[0]!, async (host) => {
    const reference = referenceText(cfg, ctx);
    if (!reference) return needsField(cfg, 'answer-accuracy', 'a reference answer', 'add a "reference" column to the dataset (or set "expected" on the check).');
    if (!ctx.text.trim()) return result(cfg, 0 >= num(cfg.threshold, 0.5), 'answer-accuracy 0: the answer is empty', { source: 'ai-judge', score: 0, metadata: { metric: 'answer-accuracy', noCall: true, items: [], threshold: num(cfg.threshold, 0.5) } });
    const q = ctx.question ?? '';
    const prompts = cfg.prompts === 1 ? ANSWER_ACCURACY.slice(0, 1) : ANSWER_ACCURACY;
    // the second prompt sees the two texts the other way round
    const inputs = [{ question: q, response: ctx.text, reference }, { question: q, response: reference, reference: ctx.text }];
    return ratedTwice(cfg, ctx, host, { id: 'answer-accuracy', prompts, inputs, threshold: 0.5, labels: ['matches', 'does not match'] });
  });

/* ------------------------------------------------------------------ hallucination (DeepEval; lower is better) */

const hallucination = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, HALLUCINATION, async (host) => {
    const against = cfg.against === 'contexts' ? 'contexts' : 'reference-contexts';
    const docs = against === 'contexts' ? (ctx.contexts ?? []).map((d) => ({ id: d.id, text: d.text })) : (ctx.referenceContexts ?? []).map((text, i) => ({ id: `ref-${i + 1}`, text }));
    if (!docs.length)
      return against === 'contexts'
        ? needContexts(cfg, 'hallucination')
        : needsField(cfg, 'hallucination', 'the ground-truth documents', 'add a "reference_contexts" column to the dataset (or set `against: contexts` to compare with the retrieved documents).');
    if (!ctx.text.trim()) return na(cfg, HALLUCINATION, 'the answer is empty');
    // DeepEval's default pass mark: at most half of the documents contradicted
    const t = num(cfg.threshold, 0.5);
    const panel = panelOf(cfg, ctx, t, 'lower');
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    const r = await judgePanel(host, HALLUCINATION, { answer: ctx.text, referenceContexts: docs }, panel);
    if (r.score === undefined) return na(cfg, HALLUCINATION, 'the judge returned no verdict for the documents', { explanation: r.reasoning, metadata: judgeMeta(HALLUCINATION, r, t) });
    const score = round3(r.score);
    return result(cfg, score <= t && !r.panel?.swap?.tie, `hallucination ${score}: ${r.items.filter((i) => !i.ok).length} of ${r.items.length} documents are contradicted by the answer (at most ${t}; alignment ${round3(1 - score)})`, {
      source: 'ai-judge',
      score,
      explanation: r.reasoning,
      metadata: judgeMeta(HALLUCINATION, r, t, { promptVersion: HALLUCINATION.version, alignment: round3(1 - score), against, direction: 'lower' }),
    });
  });

/* ------------------------------------------------------------------ the single-prompt judges */

const correctness = judgedCheck({
  metric: CORRECTNESS,
  id: 'correctness',
  threshold: 1,
  needs: ['answer', 'reference'],
  input: (cfg, ctx) => ({ question: ctx.question ?? '', answer: ctx.text, reference: referenceText(cfg, ctx) }),
});

const completeness = judgedCheck({
  metric: COMPLETENESS,
  id: 'completeness',
  threshold: 0.8,
  needs: ['question', 'answer'],
  input: (cfg, ctx) => ({ question: ctx.question ?? '', answer: ctx.text, reference: referenceText(cfg, ctx) }),
  emptyWhy: 'the question asks for nothing that can be checked',
});

/** The categories' scores can be changed: `scores: { A: 0.4, B: 0.6, C: 1, D: 0, E: 1 }`. */
const factualityMetric = (cfg: CheckConfig): JudgedMetric => {
  const s = (cfg.scores ?? {}) as Record<string, unknown>;
  const given = ['A', 'B', 'C', 'D', 'E'].map((k, i) => (typeof s[k] === 'number' ? (s[k] as number) : FACTUALITY.ratingScores![i]!));
  return given.every((v, i) => v === FACTUALITY.ratingScores![i]) ? FACTUALITY : { ...FACTUALITY, version: `factuality-v1+${given.join(',')}`, ratingScores: given };
};
const factuality = judgedCheck({
  metric: (cfg) => factualityMetric(cfg),
  id: 'factuality',
  threshold: 0.6,
  needs: ['answer', 'reference'],
  input: (cfg, ctx) => ({ question: ctx.question ?? '', answer: ctx.text, reference: referenceText(cfg, ctx) }),
  extra: (_cfg, _ctx, r) => ({ category: String.fromCharCode(65 + (r.items[0]?.rating ?? 0)) }),
});

/* ------------------------------------------------------------------ citation accuracy */

const MARKER = /\[([^\]\s]{1,64})\]/g;

/** The pairs (sentence, cited document) of an answer: [id] and [n] markers, resolved as the `citation` check does. */
function citationPairs(answer: string, docs: Array<{ id: string; text: string }>) {
  const pairs: Array<{ sentence: string; id: string; document: string; sentenceIndex: number }> = [];
  const parts = answer.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  parts.forEach((s, sentenceIndex) => {
    for (const m of s.matchAll(MARKER)) {
      const c = m[1]!;
      const doc = docs.find((d) => d.id === c) ?? docs.find((d) => d.id === `doc-${c}`) ?? (/^\d+$/.test(c) ? docs[Number(c) - 1] : undefined);
      pairs.push({ sentence: s.replace(MARKER, '').replace(/\s+/g, ' ').trim(), id: c, document: doc?.text ?? '', sentenceIndex });
    }
  });
  return { pairs, sentences: parts.length || sentences(answer).length };
}

const citationAccuracy = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, CITATION_ACCURACY, async (host) => {
    const docs = contextsInput(ctx);
    if (!docs.length) return needContexts(cfg, 'citation-accuracy');
    const { pairs, sentences: total } = citationPairs(ctx.text, docs);
    if (!pairs.length) return na(cfg, CITATION_ACCURACY, 'the answer cites no document');
    const t = num(cfg.threshold, 0.8);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    const r = await judgePanel(host, CITATION_ACCURACY, { citations: pairs.map((p) => ({ sentence: p.sentence, cited: p.id, document: p.document || '(this id is not among the retrieved documents)' })), contexts: docs }, { ...panel, swap: false });
    if (!r.items.length) return na(cfg, CITATION_ACCURACY, 'the judge returned no verdict for the citations', { explanation: r.reasoning, metadata: judgeMeta(CITATION_ACCURACY, r, t) });
    const flags = pairs.map((p, i) => p.document !== '' && r.items[i]?.ok === true);
    const precision = flags.filter(Boolean).length / flags.length;
    // ALCE's recall: sentences of the answer with at least one supported citation / sentences
    const supportedSentences = new Set(pairs.filter((_, i) => flags[i]).map((p) => p.sentenceIndex)).size;
    const recall = total ? supportedSentences / total : 0;
    const mode = String(cfg.mode ?? 'precision');
    const raw = mode === 'recall' ? recall : mode === 'f1' ? (precision + recall ? (2 * precision * recall) / (precision + recall) : 0) : precision;
    const score = round3(raw);
    const items = pairs.map((p, i) => ({ text: `[${p.id}] ${p.sentence}`.slice(0, 500), ok: flags[i]!, evidence: p.document ? (r.items[i]?.evidence ?? '') : 'not among the retrieved documents' }));
    return result(cfg, score >= t, `citation accuracy (${mode}) ${score}: ${flags.filter(Boolean).length} of ${flags.length} citations support their sentence; ${supportedSentences} of ${total} sentences are supported by a citation (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: r.reasoning,
      metadata: judgeMeta(CITATION_ACCURACY, { ...r, items }, t, { promptVersion: CITATION_ACCURACY.version, mode, precision: round3(precision), recall: round3(recall) }),
    });
  });

/* ------------------------------------------------------------------ negative rejection (no judge) */

const negativeRejection = (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
  // without the flag, a question counts as answerable: only a refusal that should not have been is counted
  const answerable = ctx.record?.answerable !== false;
  const declined = !ctx.text.trim() || REFUSAL.test(ctx.text);
  const ok = answerable ? !declined : declined;
  const kind = ok ? 'ok' : answerable ? 'false-refusal' : 'missed-refusal';
  return result(cfg, ok, ok ? (answerable ? 'the question is answerable and the system answered' : 'the question has no answer in the documents and the system declined') : answerable ? 'false refusal: the system declined a question it could answer' : 'missed refusal: the system answered a question the documents cannot answer', {
    source: 'heuristic',
    score: ok ? 1 : 0,
    metadata: { kind, answerable, declined },
  });
};

/* ------------------------------------------------------------------ the RAGAS aggregate (DeepEval) */

const ragasScore = (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
  guarded(cfg, ctx, { id: 'ragas-score', version: 'ragas-score-v1' }, async () => {
    const ids = ['answer-relevance', 'faithfulness', 'context-precision', 'context-recall'];
    const t = num(cfg.threshold, 0.7);
    const parts = await Promise.all(
      ids.map(async (id) => {
        const fn = checkFn(id)!;
        const r = await fn({ ...(id === 'answer-relevance' ? { mode: cfg.mode } : {}), ...(cfg.judge ? { judge: cfg.judge } : {}), type: id }, ctx);
        return { id, r };
      }),
    );
    const scored = parts.filter((p) => typeof p.r.score === 'number' && !(p.r.metadata as { na?: string } | undefined)?.na);
    const missing = parts.filter((p) => !scored.includes(p));
    if (missing.some((p) => !p.r.passed && p.r.score === undefined)) return result(cfg, false, `ragas-score needs all four metrics: ${missing.map((p) => `${p.id}: ${p.r.message}`).join('; ')}`, { source: 'ai-judge' });
    if (!scored.length) return na(cfg, { id: 'ragas-score', version: 'ragas-score-v1' }, 'none of its four metrics had a score');
    const score = round3(scored.reduce((a, p) => a + p.r.score!, 0) / scored.length);
    const usage = parts.reduce<Usage>((a, p) => {
      const u = (p.r.metadata as { judgeUsage?: Usage } | undefined)?.judgeUsage;
      return u ? addUsage(a, u) : a;
    }, noUsage());
    return result(cfg, score >= t, `ragas score ${score}: ${parts.map((p) => `${p.id} ${p.r.score ?? 'n/a'}`).join(', ')} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      metadata: { metric: 'ragas-score', subScores: Object.fromEntries(parts.map((p) => [p.id, p.r.score ?? null])), judgeUsage: usage, threshold: t, items: parts.map((p) => ({ text: p.id, ok: p.r.passed, evidence: p.r.message.slice(0, 200) })), itemLabels: ['passed', 'failed'] },
    });
  });

/* ------------------------------------------------------------------ registration */

const legacyCorrectness = checkFn('answer-correctness');
registerCheck('factual-correctness', strictOver(factualCorrectness, legacyCorrectness));
registerCheck('answer-correctness', strictOver(answerCorrectness, legacyCorrectness));
registerCheck('response-groundedness', responseGroundedness);
registerCheck('answer-accuracy', answerAccuracy);
registerCheck('hallucination', hallucination);
registerCheck('correctness', correctness);
registerCheck('completeness', completeness);
registerCheck('factuality', factuality);
registerCheck('citation-accuracy', citationAccuracy);
registerCheck('negative-rejection', negativeRejection);
registerCheck('ragas-score', ragasScore);


