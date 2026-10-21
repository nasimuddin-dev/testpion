/**
 * The older RAG checks (context precision / recall / entity recall, groundedness, answer relevance / correctness, citation): claim-by-claim
 * judging with the single-prompt judge of check-judge.ts, or no model at all. They answer in every run that is not a RAG target run; in one the
 * strict judged metrics of eval/rag take over by name (`overrideCheck`, see eval/rag/judged-kit.ts `strictOver`).
 */
import type { CheckConfig, CheckResult, RetrievedDoc } from '../model/types.js';
import { query } from '../util/jsonpath.js';
import { round3 } from './rag/measures.js';
import { coverage, coverageIn, sentences, tokenF1, wordSet } from './text.js';
import { asText, registerCheck, res, short, threshold, type CheckContext } from './check-registry.js';
import { askJudge, judgeFailed, runJudge } from './check-judge.js';

/**
 * One judged item of a claim-by-claim check: a claim of the answer, a retrieved document, a statement of the reference.
 * `ok` is the verdict (supported, relevant, found); `evidence` is what the judge pointed at, so a person can check it.
 */
export interface EvidenceItem {
  text: string;
  ok: boolean;
  evidence?: string;
}

/**
 * Claim-by-claim judging (the way Ragas measures faithfulness, context precision and recall): the judge returns a
 * verdict per item, with the evidence, instead of one number. The score is computed here from the verdicts, so it
 * can be followed item by item, and the items are kept in the result (what was demonstrated, what is still to verify).
 */
async function judgeItems(cfg: CheckConfig, ctx: CheckContext, task: string, sections: Array<[string, string | undefined]>, key: string): Promise<{ items: EvidenceItem[]; judge: Record<string, unknown> }> {
  const prompt = [
    'You are a strict, impartial evaluator. Judge only from the text given here, not from your own knowledge.',
    task,
    'Return ONLY a JSON object: {"items": [{"text": "<the item>", "ok": true|false, "evidence": "<a short quote or document id that decides it, or why nothing does>"}]}.',
    ...sections.filter(([, v]) => v).map(([k, v]) => `\n${k}:\n${v}`),
  ].join('\n');
  const { text, value, judge } = await askJudge(cfg, ctx, prompt, key, 1500);
  const raw = (value as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) throw new Error(`judge returned no items: ${short(text, 200)}`);
  const items = raw
    .map((x) => x as { text?: unknown; ok?: unknown; evidence?: unknown })
    .filter((x) => x && typeof x.text === 'string')
    .map((x) => ({ text: String(x.text).slice(0, 500), ok: x.ok === true || x.ok === 'true', ...(x.evidence ? { evidence: String(x.evidence).slice(0, 300) } : {}) }));
  return { items, judge };
}

/**
 * What a check calls its verdicts ([ok, not ok]), shown with the items: claims are "supported" or "not supported",
 * documents "useful" or "not useful", facts "found" or "missing".
 */
const LABELS = {
  claims: ['supported', 'not supported'],
  documents: ['useful', 'not useful'],
  statements: ['found', 'missing'],
  entities: ['retrieved', 'missing'],
  answer: ['matching', 'not matching'],
} as const;

/** "3 of 4 claims supported by the context; not supported: …" — the items a person should look at first. */
function itemsSummary(items: EvidenceItem[], noun: string, verdict: string, badLabel: string): string {
  const bad = items.filter((i) => !i.ok);
  const head = `${items.length - bad.length} of ${items.length} ${noun} ${verdict}`;
  return bad.length ? `${head}; ${badLabel}: ${bad.slice(0, 3).map((i) => `"${short(i.text, 80)}"`).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}` : head;
}


/** Rank-aware average precision: relevant documents ranked first score higher. */
function averagePrecision(relevant: boolean[]): number {
  let hits = 0;
  let sum = 0;
  relevant.forEach((r, i) => {
    if (r) {
      hits++;
      sum += hits / (i + 1);
    }
  });
  return hits ? round3(sum / hits) : 0;
}


/** The share of items judged ok (0 when there are none; unrounded, for scores computed from several shares). */
const rawShare = (items: EvidenceItem[]) => (items.length ? items.filter((i) => i.ok).length / items.length : 0);
/** The share of items judged ok, rounded (`empty` when there is nothing to judge). */
const okShare = (items: EvidenceItem[], empty: number) => (items.length ? round3(rawShare(items)) : empty);

/** The question, for a judge prompt (undefined when the test has none). */
const questionOf = (ctx: CheckContext) => asText(ctx.question ?? ctx.input ?? '') || undefined;

/**
 * A check judged item by item: asks the judge, scores the share of ok items against the threshold and keeps the items
 * with their verdict names in the result. `items` may rework what the judge returned (ordering, defaults).
 */
async function judgedItemsCheck(
  cfg: CheckConfig,
  ctx: CheckContext,
  o: {
    key: string;
    task: string;
    sections: Array<[string, string | undefined]>;
    label: string;
    noun: keyof typeof LABELS;
    verdict: string;
    threshold: number;
    /** The score when the judge found nothing to judge. */
    empty: number;
    items?(items: EvidenceItem[]): EvidenceItem[];
    score?(items: EvidenceItem[]): number;
    extra?(score: number): Record<string, unknown>;
  },
): Promise<CheckResult> {
  try {
    const judged = await judgeItems(cfg, ctx, o.task, o.sections, o.key);
    const items = o.items ? o.items(judged.items) : judged.items;
    const score = o.score ? o.score(items) : okShare(items, o.empty);
    return res(cfg, score >= o.threshold, `${o.label} (judge) ${score}: ${itemsSummary(items, o.noun, o.verdict, LABELS[o.noun][1])}`, {
      source: 'ai-judge',
      score,
      metadata: { items, itemLabels: LABELS[o.noun], judge: judged.judge, threshold: o.threshold, ...o.extra?.(score) },
    });
  } catch (e) {
    return judgeFailed(cfg, e);
  }
}

/* ------------------------------------------------------------------ RAG */

function ragContexts(ctx: CheckContext): RetrievedDoc[] {
  return ctx.contexts ?? [];
}

registerCheck('context-precision', async (cfg, ctx) => {
  const docs = ragContexts(ctx);
  const t = threshold(cfg, 0.5);
  const reference = cfg.expected ?? ctx.expected;
  if (cfg.judge)
    return judgedItemsCheck(cfg, ctx, {
      key: 'context-precision',
      task: 'For each RETRIEVED DOCUMENT, in the order given, decide whether it is useful for answering the QUESTION (to reach the REFERENCE ANSWER when one is given). One item per document; "text" is the document id.',
      sections: [
        ['QUESTION', asText(ctx.question ?? ctx.input ?? '')],
        ['REFERENCE ANSWER', reference !== undefined ? asText(reference) : undefined],
        ['RETRIEVED DOCUMENTS', docs.map((d) => `[${d.id}] ${d.text}`).join('\n')],
      ],
      label: 'context precision',
      noun: 'documents',
      verdict: 'useful',
      threshold: t,
      empty: 0,
      // the judge's verdicts in the documents' order (rank matters), a document it skipped counts as not judged
      items: (items) => {
        const byId = new Map(items.map((i) => [i.text.replace(/^\[|\]$/g, ''), i]));
        return docs.map((d, i) => byId.get(d.id) ?? items[i] ?? { text: d.id, ok: false, evidence: 'not judged' });
      },
      score: (items) => averagePrecision(items.map((i) => i.ok)),
    });
  const ref = `${ctx.question ?? ''} ${asText(reference ?? '')}`;
  const refWords = wordSet(ref);
  const relevance = docs.map((d) => coverageIn(d.text, refWords) >= Number(cfg.docThreshold ?? 0.1) || coverage(ref, d.text) >= 0.3);
  const score = averagePrecision(relevance);
  const hits = relevance.filter(Boolean).length;
  return res(cfg, score >= t, `context precision ${score} (${hits}/${docs.length} relevant)`, {
    source: 'heuristic',
    score,
    metadata: { relevant: docs.filter((_, i) => relevance[i]).map((d) => d.id), items: docs.map((d, i) => ({ text: d.id, ok: relevance[i]!, evidence: short(d.text, 120) })), itemLabels: LABELS.documents },
  });
});

registerCheck('context-recall', async (cfg, ctx) => {
  const exp = asText(cfg.expected ?? ctx.expected ?? '');
  const all = ragContexts(ctx).map((d) => d.text).join('\n');
  const t = threshold(cfg, 0.6);
  if (cfg.judge)
    return judgedItemsCheck(cfg, ctx, {
      key: 'context-recall',
      task: 'Split the REFERENCE ANSWER into its statements. For each, decide whether the RETRIEVED CONTEXT contains the information it needs (ok: true) or not.',
      sections: [
        ['QUESTION', questionOf(ctx)],
        ['REFERENCE ANSWER', exp],
        ['RETRIEVED CONTEXT', ragContexts(ctx).map((d) => `[${d.id}] ${d.text}`).join('\n')],
      ],
      label: 'context recall',
      noun: 'statements',
      verdict: 'found in the context',
      threshold: t,
      empty: 0,
    });
  const sents = sentences(exp);
  const allWords = wordSet(all);
  const found = sents.map((s) => coverageIn(s, allWords) >= 0.6);
  const score = sents.length ? round3(found.filter(Boolean).length / sents.length) : round3(coverageIn(exp, allWords));
  return res(cfg, score >= t, `context recall ${score}`, { source: 'heuristic', score, metadata: { items: sents.map((s, i) => ({ text: s, ok: found[i]! })), itemLabels: LABELS.statements } });
});

/** The names, numbers and dates of a text (what a retrieval must not lose). */
function entities(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(?:[A-Z][\w'-]*(?:\s+(?:of|de|the|and|&)?\s*[A-Z][\w'-]*)*)\b/g)) {
    const e = m[0].trim();
    // a capitalized word that starts a sentence is not a name
    const at = m.index ?? 0;
    const startsSentence = at === 0 || /[.!?]\s*$/.test(text.slice(Math.max(0, at - 3), at));
    if (!startsSentence || e.includes(' ')) found.add(e);
  }
  // numbers with their unit (8am, 25%, 3.5kg, 2024-07-18)
  for (const m of text.matchAll(/\b\d(?:[\d,./:-]*\d)?[a-z%]*/gi)) found.add(m[0]);
  return [...found];
}

// the reference's entities that the retrieved context holds (Ragas' context entity recall), with no model
registerCheck('context-entity-recall', (cfg, ctx) => {
  const exp = asText(cfg.expected ?? ctx.expected ?? '');
  const all = ragContexts(ctx)
    .map((d) => d.text)
    .join('\n')
    .toLowerCase();
  const list = Array.isArray(cfg.entities) ? (cfg.entities as unknown[]).map(String) : entities(exp);
  const items = list.map((e) => ({ text: e, ok: all.includes(e.toLowerCase()) }));
  const score = okShare(items, 1);
  const t = threshold(cfg, 0.8);
  return res(cfg, score >= t, `context entity recall ${score}: ${itemsSummary(items, 'entities', 'retrieved', 'missing')}`, { source: 'deterministic', score, metadata: { items, itemLabels: LABELS.entities } });
});

registerCheck('groundedness', async (cfg, ctx) => {
  const all = ragContexts(ctx).map((d) => `[${d.id}] ${d.text}`).join('\n');
  const t = threshold(cfg, 0.7);
  if (cfg.judge)
    return judgedItemsCheck(cfg, ctx, {
      key: 'groundedness',
      task: 'Break the RESPONSE into its atomic factual claims. For each claim, decide whether the RETRIEVED CONTEXT supports it (ok: true) or not (unsupported or contradicted); the evidence is the supporting quote or document id.',
      sections: [
        ['QUESTION', questionOf(ctx)],
        ['RETRIEVED CONTEXT', all],
        ['RESPONSE', ctx.text || asText(ctx.body)],
      ],
      label: 'groundedness',
      noun: 'claims',
      verdict: 'supported by the context',
      threshold: t,
      // an answer without a claim (a refusal, "I don't know") makes up nothing
      empty: 1,
      extra: (score) => ({ hallucinationIndicator: round3(1 - score) }),
    });
  const sents = sentences(ctx.text);
  const allWords = wordSet(all);
  const supported = sents.map((s) => coverageIn(s, allWords) >= Number(cfg.sentenceThreshold ?? 0.5));
  const unsupported = sents.filter((_, i) => !supported[i]);
  const score = sents.length ? round3((sents.length - unsupported.length) / sents.length) : 1;
  return res(cfg, score >= t, `groundedness ${score} — ${unsupported.length} unsupported sentence(s)`, {
    source: 'heuristic',
    score,
    metadata: { unsupported: unsupported.slice(0, 10), hallucinationIndicator: round3(1 - score), items: sents.map((s, i) => ({ text: s, ok: supported[i]! })), itemLabels: LABELS.claims },
  });
});

registerCheck('answer-relevance', async (cfg, ctx) => {
  const t = threshold(cfg, cfg.judge ? 0.7 : 0.2);
  if (cfg.judge) {
    try {
      const j = await runJudge(cfg, ctx, 'The RESPONSE directly and completely answers the INPUT question.');
      return res(cfg, j.score >= t, `answer relevance (judge) ${j.score}`, { source: 'ai-judge', score: j.score, explanation: j.reasoning, metadata: { judge: j.judge } });
    } catch (e) {
      return judgeFailed(cfg, e);
    }
  }
  const q = asText(ctx.question ?? ctx.input ?? '');
  const exp = asText(cfg.expected ?? ctx.expected ?? '');
  const qCovered = coverage(q, ctx.text);
  const score = round3(Math.max(qCovered * 0.5 + (exp ? tokenF1(ctx.text, exp) * 0.5 : qCovered * 0.5), 0));
  return res(cfg, score >= t, `answer relevance ${score}`, { source: 'heuristic', score });
});

/**
 * The answer's facts against the reference's (Ragas' factual correctness): precision is the share of the answer's
 * claims the reference supports, recall the share of the reference's claims the answer makes; `mode` picks f1
 * (default), precision or recall.
 */
registerCheck('answer-correctness', async (cfg, ctx) => {
  const reference = asText(cfg.expected ?? ctx.expected ?? '');
  const answer = cfg.path ? asText(query(ctx.body, String(cfg.path))) : ctx.text;
  const mode = String(cfg.mode ?? 'f1');
  const t = threshold(cfg, 0.7);
  if (!reference) return res(cfg, false, 'answer-correctness needs a reference answer (expected)', { source: cfg.judge ? 'ai-judge' : 'heuristic' });
  let answerItems: EvidenceItem[];
  let referenceItems: EvidenceItem[];
  let judge: Record<string, unknown> | undefined;
  if (cfg.judge) {
    try {
      const a = await judgeItems(
        cfg,
        ctx,
        'Break the RESPONSE into its atomic factual claims. For each, decide whether the REFERENCE ANSWER supports it (ok: true) or not.',
        [
          ['QUESTION', questionOf(ctx)],
          ['REFERENCE ANSWER', reference],
          ['RESPONSE', answer],
        ],
        'answer-correctness:precision',
      );
      const b =
        mode === 'precision'
          ? { items: [] }
          : await judgeItems(
              cfg,
              ctx,
              'Break the REFERENCE ANSWER into its atomic factual claims. For each, decide whether the RESPONSE states it too (ok: true) or misses or contradicts it.',
              [
                ['QUESTION', questionOf(ctx)],
                ['REFERENCE ANSWER', reference],
                ['RESPONSE', answer],
              ],
              'answer-correctness:recall',
            );
      answerItems = a.items;
      referenceItems = b.items;
      judge = a.judge;
    } catch (e) {
      return judgeFailed(cfg, e);
    }
  } else {
    const referenceWords = wordSet(reference);
    const answerWords = wordSet(answer);
    answerItems = sentences(answer).map((s) => ({ text: s, ok: coverageIn(s, referenceWords) >= 0.5 }));
    referenceItems = sentences(reference).map((s) => ({ text: s, ok: coverageIn(s, answerWords) >= 0.5 }));
  }
  const precision = rawShare(answerItems);
  const recall = rawShare(referenceItems);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const score = round3(mode === 'precision' ? precision : mode === 'recall' ? recall : f1);
  const missing = referenceItems.filter((i) => !i.ok);
  const wrong = answerItems.filter((i) => !i.ok);
  const detail = [wrong.length ? `${wrong.length} claim(s) not in the reference` : '', mode !== 'precision' && missing.length ? `${missing.length} reference fact(s) missing` : ''].filter(Boolean).join(', ');
  return res(cfg, score >= t, `answer correctness ${mode} ${score}${detail ? ` — ${detail}` : ''}`, {
    source: cfg.judge ? 'ai-judge' : 'heuristic',
    score,
    metadata: {
      mode,
      precision: round3(precision),
      ...(mode !== 'precision' ? { recall: round3(recall) } : {}),
      items: [...answerItems.map((i) => ({ ...i, text: `answer: ${i.text}` })), ...referenceItems.map((i) => ({ ...i, text: `reference: ${i.text}` }))],
      itemLabels: LABELS.answer,
      ...(judge ? { judge } : {}),
      threshold: t,
    },
  });
});

registerCheck('citation', (cfg, ctx) => {
  const idList = ragContexts(ctx).map((d) => d.id);
  const ids = new Set(idList);
  const cited = [...ctx.text.matchAll(/\[([^\]\s]{1,64})\]/g)].map((m) => m[1]!);
  if (!cited.length) return res(cfg, cfg.required === false, cfg.required === false ? 'no citations (optional)' : 'no citations found', { source: 'deterministic', score: 0 });
  // [1] cites the first document
  const valid = cited.filter((c) => ids.has(c) || ids.has(`doc-${c}`) || idList[Number(c) - 1] !== undefined);
  const score = Math.round((valid.length / cited.length) * 1000) / 1000;
  return res(cfg, score >= threshold(cfg, 1), `${valid.length}/${cited.length} citations refer to retrieved documents`, {
    source: 'deterministic',
    score,
    actual: cited,
    expected: [...ids],
  });
});

