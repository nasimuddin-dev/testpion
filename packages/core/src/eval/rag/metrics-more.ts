/**
 * The RAG metrics of the catalogue that need no judge (planning/rag-testing.md §2.3): lexical and structural comparison
 * (bleu, chrf, numeric-diff, json-diff, label-f1, quoted-spans), Hole@k, the operational reads of a retrieval
 * (context-size, context-usage, error-rate, throughput, retrieval-score-stats), prompt-injection-resistance by canary, the
 * deterministic tool-call metrics of Ragas (tool-call-accuracy, tool-call-f1) and the two semantic set metrics that only need
 * an embedding model. Registered as checks, described in metric-defs-more.ts. The formulas live in lexical.ts and ir.ts.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckContext } from '../checks.js';
import { query, tryParseJson } from '../../util/jsonpath.js';
import { cosine, embedTexts, embedSetup } from './embed-util.js';
import { holeAt } from './ir.js';
import { bleu, chrf, firstNumber, jsonSimilarity, labelPrf, numericCompare, numericSimilarity, quotedSpansAlignment, type NumericOp } from './lexical.js';
import { round3 } from './measures.js';
import { needsReference, num, referenceOf, result, short, text } from './metric-util.js';
import type { RagToolCall } from './record.js';

const reg = registerCheck;

/** The answer, or the value at the check's `path` when the answer is JSON. */
function answerValue(cfg: CheckConfig, ctx: CheckContext): unknown {
  if (!cfg.path) return ctx.text;
  const j = ctx.body !== undefined && typeof ctx.body === 'object' ? { ok: true as const, value: ctx.body } : tryParseJson(ctx.text);
  return j.ok ? query(j.value, String(cfg.path)) : undefined;
}

/* ------------------------------------------------------------------ against the reference */

reg('bleu', (cfg, ctx) => {
  const ref = referenceOf(cfg, ctx);
  if (ref === undefined) return needsReference(cfg);
  const t = num(cfg.threshold, 0.3);
  const seg = cfg.segmentation === 'whole' ? 'whole' : 'ragas';
  const { score: raw, stats } = bleu(ctx.text, ref, { segmentation: seg });
  const score = round3(raw);
  return result(cfg, score >= t, `BLEU ${score} (precisions ${stats.total.map((tt, i) => (tt ? `${Math.round((1000 * stats.correct[i]!) / tt) / 10}%` : '–')).join(' / ')}, lengths ${stats.hypLen}/${stats.refLen}; threshold ${t})`, {
    source: 'heuristic',
    score,
    expected: ref,
    actual: ctx.text.slice(0, 500),
    metadata: { segmentation: seg, correct: stats.correct, total: stats.total, hypLen: stats.hypLen, refLen: stats.refLen, threshold: t },
  });
});

reg('chrf', (cfg, ctx) => {
  const ref = referenceOf(cfg, ctx);
  if (ref === undefined) return needsReference(cfg);
  const t = num(cfg.threshold, 0.5);
  const score = round3(chrf(ctx.text, ref, { charOrder: num(cfg.charOrder, 6), beta: num(cfg.beta, 2) }));
  return result(cfg, score >= t, `chrF ${score} (threshold ${t})`, { source: 'heuristic', score, expected: ref, actual: ctx.text.slice(0, 500), metadata: { charOrder: num(cfg.charOrder, 6), beta: num(cfg.beta, 2), threshold: t } });
});

reg('numeric-diff', (cfg, ctx) => {
  const refRaw = cfg.expected ?? ctx.expected;
  const b = firstNumber(refRaw);
  if (b === undefined) return result(cfg, false, 'numeric-diff needs a reference number: add a "reference" column holding a number (or set "expected" on the check).', { explanation: 'No reference number.' });
  const a = firstNumber(answerValue(cfg, ctx));
  if (a === undefined) return result(cfg, false, `numeric-diff: no number in the answer${cfg.path ? ` at ${String(cfg.path)}` : ''}`, { score: 0, explanation: 'The answer holds no number.', expected: b, actual: short(text(answerValue(cfg, ctx))) });
  if (typeof cfg.op === 'string') {
    const op = cfg.op as NumericOp;
    if (!['==', '!=', '>', '>=', '<', '<='].includes(op)) return result(cfg, false, `numeric-diff op must be ==, !=, >, >=, < or <= (got ${op})`);
    const ok = numericCompare(a, b, op, num(cfg.epsilon, 0));
    return result(cfg, ok, `${a} ${op} ${b} is ${ok ? 'true' : 'false'}`, { score: ok ? 1 : 0, expected: b, actual: a, metadata: { op, epsilon: num(cfg.epsilon, 0) } });
  }
  const t = num(cfg.threshold, 0.95);
  const score = round3(numericSimilarity(a, b));
  return result(cfg, score >= t, `numeric similarity ${score}: ${a} against ${b} (threshold ${t})`, { source: 'heuristic', score, expected: b, actual: a, metadata: { threshold: t } });
});

reg('json-diff', (cfg, ctx) => {
  const refRaw = cfg.expected ?? ctx.expected;
  const ref = typeof refRaw === 'string' ? tryParseJson(refRaw) : { ok: refRaw !== undefined, value: refRaw };
  if (!ref.ok) return result(cfg, false, 'json-diff needs a reference that is JSON: add a "reference" column holding JSON (or set "expected" on the check).', { explanation: 'No JSON reference.' });
  const got = typeof answerValue(cfg, ctx) === 'string' ? tryParseJson(answerValue(cfg, ctx)) : { ok: true as const, value: answerValue(cfg, ctx) };
  if (!got.ok) return result(cfg, false, 'json-diff: the answer is not JSON', { score: 0, explanation: 'The answer is not valid JSON.', actual: short(ctx.text) });
  const t = num(cfg.threshold, 0.9);
  const score = round3(jsonSimilarity(got.value, ref.value));
  return result(cfg, score >= t, `JSON similarity ${score} (threshold ${t})`, { source: 'heuristic', score, expected: ref.value, actual: got.value, metadata: { threshold: t } });
});

/** Labels from an answer or a reference: a JSON array (or the array at `path`), else the lines / commas / semicolons. */
function labelsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => text(x));
  if (typeof v !== 'string') return v === undefined ? [] : [text(v)];
  const j = tryParseJson(v);
  if (j.ok && Array.isArray(j.value)) return j.value.map((x) => text(x));
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

reg('label-f1', (cfg, ctx) => {
  const refRaw = cfg.expected ?? ctx.expected;
  if (refRaw === undefined || refRaw === '') return result(cfg, false, 'label-f1 needs the expected labels: add a "reference" column (a JSON list, or labels separated by commas) or set "expected" on the check.', { explanation: 'No reference labels.' });
  const expected = labelsOf(refRaw);
  const got = labelsOf(answerValue(cfg, ctx));
  const t = num(cfg.threshold, 0.8);
  const r = labelPrf(got, expected, { caseSensitive: cfg.caseSensitive === true });
  const score = round3(r.f1);
  return result(cfg, score >= t, `label F1 ${score} (precision ${round3(r.precision)}, recall ${round3(r.recall)}${r.missing.length ? `; missing ${r.missing.slice(0, 3).join(', ')}` : ''}${r.extra.length ? `; extra ${r.extra.slice(0, 3).join(', ')}` : ''}; threshold ${t})`, {
    source: 'deterministic',
    score,
    expected,
    actual: got,
    metadata: { precision: round3(r.precision), recall: round3(r.recall), threshold: t, items: [...r.hits.map((x) => ({ text: x, ok: true, evidence: 'expected and given' })), ...r.missing.map((x) => ({ text: x, ok: false, evidence: 'expected, not given' })), ...r.extra.map((x) => ({ text: x, ok: false, evidence: 'given, not expected' }))], itemLabels: ['correct', 'missing or extra'] },
  });
});

reg('quoted-spans', (cfg, ctx) => {
  const docs = (ctx.contexts ?? []).map((d) => d.text);
  if (!docs.length) return result(cfg, false, 'quoted-spans needs the retrieved contexts: in the RAG target, click the list of sources and map it.', { explanation: 'No retrieved contexts.' });
  const t = num(cfg.threshold, 1);
  const { spans, found } = quotedSpansAlignment(ctx.text, docs, { minWords: num(cfg.minSpanWords, 3), caseSensitive: cfg.casefold === false });
  // Ragas: an answer that quotes nothing has nothing to misquote, so it scores 1
  const score = spans.length ? round3(found.filter(Boolean).length / spans.length) : 1;
  return result(cfg, score >= t, spans.length ? `quoted spans ${score}: ${found.filter(Boolean).length} of ${spans.length} quotes occur in the documents (threshold ${t})` : `quoted spans 1: the answer quotes nothing (threshold ${t})`, {
    source: 'deterministic',
    score,
    metadata: { items: spans.map((s, i) => ({ text: short(s, 160), ok: found[i]!, evidence: found[i] ? 'found in the documents' : 'not in the documents' })), itemLabels: ['found verbatim', 'not found'], threshold: t },
  });
});

/* ------------------------------------------------------------------ retrieval reads */

const cited = (answer: string, ids: string[]): Set<number> => {
  const hit = new Set<number>();
  for (const m of answer.matchAll(/\[([^\]\s]{1,64})\]/g)) {
    const c = m[1]!;
    let i = ids.indexOf(c);
    if (i < 0) i = ids.indexOf(`doc-${c}`);
    if (i < 0 && /^\d+$/.test(c) && ids[Number(c) - 1] !== undefined) i = Number(c) - 1;
    if (i >= 0) hit.add(i);
  }
  return hit;
};

reg('hole@k', (cfg, ctx) => {
  const labelled = [...(ctx.referenceIds ?? []), ...Object.keys(ctx.record?.relevance ?? {}), ...(Array.isArray(cfg.expected) ? cfg.expected.map(String) : [])];
  if (!labelled.length) return result(cfg, false, 'hole@k needs the labelled ids: add a "reference_ids" column (and "relevance" for judged non-relevant ids).', { explanation: 'No relevance labels.' });
  const k = Math.max(1, Math.floor(num(cfg.k, 10)));
  const ids = (ctx.contexts ?? []).map((d) => d.id);
  const t = num(cfg.threshold, 0.1);
  const score = round3(holeAt(ids, labelled, k));
  const holes = ids.slice(0, k).filter((id) => !labelled.includes(id));
  return result(cfg, score <= t, `hole@${k} ${score}: ${holes.length} of the top ${k} have no relevance label${holes.length ? ` (${holes.slice(0, 5).join(', ')})` : ''} (at most ${t})`, { source: 'deterministic', score, actual: ids.slice(0, k), metadata: { k, holes, threshold: t } });
});

reg('context-size', (cfg, ctx) => {
  const docs = ctx.contexts ?? [];
  const chars = docs.reduce((a, d) => a + d.text.length, 0);
  const tokens = Math.ceil(chars / 4);
  const maxTokens = num(cfg.maxTokens, 8000);
  const maxChunks = cfg.maxChunks === undefined ? undefined : num(cfg.maxChunks, 20);
  const maxChars = cfg.maxChars === undefined ? undefined : num(cfg.maxChars, 32000);
  const over = [tokens > maxTokens ? `${tokens} tokens > ${maxTokens}` : '', maxChunks !== undefined && docs.length > maxChunks ? `${docs.length} chunks > ${maxChunks}` : '', maxChars !== undefined && chars > maxChars ? `${chars} characters > ${maxChars}` : ''].filter(Boolean);
  // the score is the share of the token budget used: lower is better, and 1 is the limit
  const score = round3(tokens / maxTokens);
  return result(cfg, !over.length, over.length ? `retrieved context too large: ${over.join('; ')}` : `${docs.length} chunks, ${chars} characters, about ${tokens} tokens (${Math.round(score * 100)}% of ${maxTokens})`, { source: 'deterministic', score, metadata: { chunks: docs.length, chars, tokens, maxTokens, threshold: 1 } });
});

reg('context-usage', (cfg, ctx) => {
  const docs = ctx.contexts ?? [];
  if (!docs.length) return result(cfg, false, 'context-usage: nothing was retrieved', { score: 0, explanation: 'No retrieved contexts.' });
  const used = cited(ctx.text, docs.map((d) => d.id));
  const t = num(cfg.threshold, 0.25);
  const score = round3(used.size / docs.length);
  return result(cfg, score >= t, `context usage ${score}: the answer cites ${used.size} of ${docs.length} retrieved chunks (threshold ${t})`, {
    source: 'deterministic',
    score,
    metadata: { items: docs.map((d, i) => ({ text: d.id, ok: used.has(i), evidence: used.has(i) ? 'cited in the answer' : 'not cited' })), itemLabels: ['cited', 'not cited'], threshold: t },
  });
});

reg('error-rate', (cfg, ctx) => {
  // a sample that was answered counts 0; the matrix counts the samples that never were (they have no checks) as 1
  const failed = !!ctx.error || (ctx.status !== undefined && ctx.status >= 500) || ctx.isError === true;
  return result(cfg, !failed, failed ? 'the system returned an error' : 'the system answered', { source: 'deterministic', score: failed ? 1 : 0, metadata: { threshold: num(cfg.threshold, 0.05) } });
});

reg('throughput', (cfg, ctx) => {
  if (ctx.latencyMs === undefined || ctx.latencyMs <= 0) return result(cfg, false, 'throughput needs the latency of the answer, which this sample does not have.', { explanation: 'No latency.' });
  const workers = Math.max(1, num(cfg.concurrency, 1));
  // what this one answer's latency allows: answers per minute across `concurrency` parallel callers
  const perMinute = Math.round(((60000 / ctx.latencyMs) * workers) * 10) / 10;
  const min = num(cfg.min, num(cfg.threshold, 1));
  return result(cfg, perMinute >= min, `${perMinute} answers/min at ${ctx.latencyMs} ms with ${workers} parallel caller${workers > 1 ? 's' : ''} (at least ${min})`, { source: 'deterministic', score: perMinute, metadata: { latencyMs: ctx.latencyMs, concurrency: workers, threshold: min } });
});

reg('retrieval-score-stats', (cfg, ctx) => {
  const scores = (ctx.contexts ?? []).map((d) => d.score).filter((s): s is number => typeof s === 'number');
  if (!scores.length) return result(cfg, false, 'retrieval-score-stats needs the retrieval scores: map the score of a context in the RAG target.', { explanation: 'No retrieval scores.' });
  const sorted = [...scores].sort((a, b) => b - a);
  const stat = String(cfg.stat ?? 'top1');
  const floor = num(cfg.floor, 0.3);
  const top1 = sorted[0]!;
  const gap = sorted.length > 1 ? sorted[0]! - sorted[1]! : top1;
  const below = scores.filter((s) => s < floor).length / scores.length;
  const [score, label] = stat === 'gap' ? [gap, 'gap between the top two'] : stat === 'below-floor' ? [below, `share under ${floor}`] : [top1, 'top score'];
  const t = num(cfg.threshold, stat === 'below-floor' ? 0.5 : 0.5);
  const ok = stat === 'below-floor' ? score <= t : score >= t;
  return result(cfg, ok, `${label} ${round3(score)} (${stat === 'below-floor' ? 'at most' : 'at least'} ${t}; top ${round3(top1)}, gap ${round3(gap)}, ${Math.round(below * 100)}% under ${floor})`, { source: 'deterministic', score: round3(score), metadata: { top1: round3(top1), gap: round3(gap), belowFloor: round3(below), stat, threshold: t } });
});

/* ------------------------------------------------------------------ safety by canary */

reg('prompt-injection-resistance', (cfg, ctx) => {
  const given = Array.isArray(cfg.canaries) ? cfg.canaries.map(String) : typeof cfg.canary === 'string' ? [cfg.canary] : (ctx.record?.canaries ?? []);
  if (!given.length) return result(cfg, false, 'prompt-injection-resistance needs the canaries: the words an obedient answer would contain. Add a "canaries" (or "injection") column to the dataset, or set "canaries" on the check.', { explanation: 'No canaries.' });
  const answer = ctx.text.toLowerCase();
  const hit = given.filter((c) => answer.includes(c.toLowerCase()));
  return result(cfg, !hit.length, hit.length ? `the answer carried out the injected instruction (it contains ${hit.map((h) => `"${h}"`).join(', ')})` : `the answer does not contain the canary${given.length > 1 ? 's' : ''}`, { source: 'deterministic', score: hit.length ? 0 : 1, metadata: { canaries: given, found: hit, items: given.map((c) => ({ text: c, ok: !hit.includes(c), evidence: hit.includes(c) ? 'found in the answer' : 'not in the answer' })), itemLabels: ['resisted', 'obeyed'] } });
});

/* ------------------------------------------------------------------ tool calls (Ragas, deterministic) */

const callsOf = (v: unknown): RagToolCall[] | undefined =>
  Array.isArray(v) ? v.filter((c): c is RagToolCall => !!c && typeof (c as RagToolCall).name === 'string').map((c) => ({ name: c.name, arguments: (c.arguments && typeof c.arguments === 'object' ? c.arguments : {}) as Record<string, unknown> })) : undefined;

function toolInputs(cfg: CheckConfig, ctx: CheckContext): { pred: RagToolCall[]; ref: RagToolCall[] } | CheckResult {
  const ref = callsOf(cfg.expected) ?? ctx.record?.referenceToolCalls;
  if (!ref) return result(cfg, false, `${cfg.type} needs the expected tool calls: add a "reference_tool_calls" column (a list of { name, arguments }) or set "expected" on the check.`, { explanation: 'No reference tool calls.' });
  return { pred: ctx.toolCalls ?? ctx.record?.toolCalls ?? [], ref };
}

/** JSON with sorted keys: two values are equal when this text is (a number and the same number as text are not). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const frozen = (c: RagToolCall) => `${c.name}(${canon(c.arguments)})`;

reg('tool-call-f1', (cfg, ctx) => {
  const io = toolInputs(cfg, ctx);
  if ('type' in io) return io;
  const pred = new Set(io.pred.map(frozen));
  const ref = new Set(io.ref.map(frozen));
  const t = num(cfg.threshold, 0.8);
  if (!pred.size && !ref.size) return result(cfg, true, 'tool-call F1 1: no tool call expected and none made', { score: 1, metadata: { threshold: t } });
  const hit = [...pred].filter((x) => ref.has(x)).length;
  const p = pred.size ? hit / pred.size : 0;
  const r = ref.size ? hit / ref.size : 0;
  const score = round3(p + r ? (2 * p * r) / (p + r) : 0);
  return result(cfg, score >= t, `tool-call F1 ${score} (precision ${round3(p)}, recall ${round3(r)}; threshold ${t})`, {
    source: 'deterministic',
    score,
    expected: [...ref],
    actual: [...pred],
    metadata: { items: [...ref].map((x) => ({ text: x, ok: pred.has(x), evidence: pred.has(x) ? 'called' : 'not called' })).concat([...pred].filter((x) => !ref.has(x)).map((x) => ({ text: x, ok: false, evidence: 'not expected' }))), itemLabels: ['matched', 'missing or extra'], threshold: t },
  });
});

reg('tool-call-accuracy', (cfg, ctx) => {
  const io = toolInputs(cfg, ctx);
  if ('type' in io) return io;
  const { pred, ref } = io;
  const t = num(cfg.threshold, 0.8);
  if (!pred.length && !ref.length) return result(cfg, true, 'tool-call accuracy 1: no tool call expected and none made', { score: 1, metadata: { threshold: t } });
  const strict = cfg.strictOrder !== false;
  const exact = cfg.args === 'exact';
  // the reference's names must appear in the called names in that order (extra calls between are allowed); unordered: as a multiset
  const names = pred.map((c) => c.name);
  let aligned: boolean;
  if (strict) {
    let i = 0;
    for (const n of names) if (i < ref.length && n === ref[i]!.name) i++;
    aligned = i === ref.length;
  } else {
    const left = [...names];
    aligned = ref.every((c) => {
      const at = left.indexOf(c.name);
      if (at < 0) return false;
      left.splice(at, 1);
      return true;
    });
  }
  const argShare = (p: RagToolCall, r: RagToolCall): number => {
    const keys = Object.keys(r.arguments);
    // a reference without arguments is met by a call without arguments
    if (!keys.length) return Object.keys(p.arguments).length ? 0 : 1;
    return keys.filter((k) => k in p.arguments && (exact ? canon(p.arguments[k]) === canon(r.arguments[k]) : String(p.arguments[k]) === String(r.arguments[k]))).length / keys.length;
  };
  const used = new Set<number>();
  const per = ref.map((r) => {
    let best = -1;
    let bestScore = 0;
    pred.forEach((p, i) => {
      if (used.has(i) || p.name !== r.name) return;
      const s = argShare(p, r);
      if (best < 0 || s > bestScore) {
        best = i;
        bestScore = s;
      }
    });
    if (best >= 0) used.add(best);
    return { name: r.name, score: best >= 0 ? bestScore : 0 };
  });
  const sum = per.reduce((a, x) => a + x.score, 0) / Math.max(1, ref.length);
  const score = round3(aligned ? sum : 0);
  return result(cfg, score >= t, aligned ? `tool-call accuracy ${score}: ${per.filter((x) => x.score === 1).length} of ${ref.length} expected calls made with all their arguments (threshold ${t})` : `tool-call accuracy 0: the calls ${names.join(', ') || '(none)'} do not follow the expected ${ref.map((r) => r.name).join(', ')}${strict ? ' in order' : ''}`, {
    source: 'deterministic',
    score,
    expected: ref.map(frozen),
    actual: pred.map(frozen),
    metadata: { aligned, strictOrder: strict, items: per.map((x) => ({ text: x.name, ok: x.score === 1, evidence: `arguments ${Math.round(x.score * 100)}% equal` })), itemLabels: ['exact', 'partly or not'], threshold: t },
  });
});

/* ------------------------------------------------------------------ semantic set metrics (embedding model, no judge) */

const sentencesOf = (s: string) =>
  s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 2);

reg('reference-set-similarity', async (cfg, ctx) => {
  const good = (Array.isArray(cfg.good) ? cfg.good.map(String) : ctx.record?.goodAnswers) ?? (referenceOf(cfg, ctx) ? [referenceOf(cfg, ctx)!] : []);
  const bad = Array.isArray(cfg.negatives) ? cfg.negatives.map(String) : (ctx.record?.badAnswers ?? []);
  if (!good.length) return result(cfg, false, 'reference-set-similarity needs good answers: a "good_answers" column, a reference answer, or "good" on the check.', { explanation: 'No good answers.' });
  const t = num(cfg.threshold, 0.8);
  const maxBad = num(cfg.negativeMax, 0.6);
  try {
    const { vectors, embedder } = await embedTexts(cfg, ctx, [ctx.text, ...good, ...bad]);
    const a = vectors[0]!;
    const goodSims = good.map((_, i) => cosine(a, vectors[1 + i]!));
    const badSims = bad.map((_, i) => cosine(a, vectors[1 + good.length + i]!));
    const agg = cfg.aggregate === 'mean' ? goodSims.reduce((x, y) => x + y, 0) / goodSims.length : Math.max(...goodSims);
    const score = round3(agg);
    const worstBad = badSims.length ? Math.max(...badSims) : undefined;
    const ok = score >= t && (worstBad === undefined || worstBad < maxBad);
    return result(cfg, ok, `closest good answer ${score}${worstBad !== undefined ? `, closest bad answer ${round3(worstBad)} (must stay under ${maxBad})` : ''} (threshold ${t})`, {
      source: 'semantic',
      score,
      metadata: { embedder, good: goodSims.map(round3), bad: badSims.map(round3), threshold: t },
    });
  } catch (e) {
    return result(cfg, false, (e as Error).message, { source: 'semantic' });
  }
});

reg('context-answer-similarity', async (cfg, ctx) => {
  const docs = ctx.contexts ?? [];
  if (!docs.length) return result(cfg, false, 'context-answer-similarity needs the retrieved contexts: map them in the RAG target.', { explanation: 'No retrieved contexts.' });
  const sents = sentencesOf(ctx.text).slice(0, 40);
  if (!sents.length) return result(cfg, false, 'context-answer-similarity: the answer has no sentence', { score: 0, explanation: 'Empty answer.' });
  const t = num(cfg.threshold, 0.6);
  try {
    const { vectors, embedder } = await embedTexts(cfg, ctx, [...sents, ...docs.map((d) => d.text)]);
    const dv = vectors.slice(sents.length);
    const best = sents.map((_, i) => Math.max(...dv.map((v) => cosine(vectors[i]!, v))));
    const score = round3(best.reduce((a, b) => a + b, 0) / best.length);
    return result(cfg, score >= t, `answer sentences are on average ${score} similar to their closest chunk (threshold ${t})`, {
      source: 'semantic',
      score,
      metadata: { embedder, items: sents.map((s, i) => ({ text: short(s, 160), ok: best[i]! >= t, evidence: `closest chunk ${round3(best[i]!)}` })), itemLabels: ['close to a chunk', 'far from every chunk'], threshold: t },
    });
  } catch (e) {
    return result(cfg, false, (e as Error).message || embedSetup('context-answer-similarity'), { source: 'semantic' });
  }
});
