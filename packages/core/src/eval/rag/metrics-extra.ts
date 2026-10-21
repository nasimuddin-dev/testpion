/**
 * The judge designs that needed their own (planning/rag-testing.md §2.3): G-Eval (and its conversational form), the blinded
 * pairwise comparison, and summarization (DeepEval's min of alignment and coverage, and Ragas' keyphrase-question score).
 * All of them are built from the existing pieces: the judge-template engine for the final rating, the shared verdict format,
 * the panel (juries, repeat), the cache and the ledger.
 *
 * G-Eval note: the paper weights each score by the probability of its token. The AI layer does not expose token
 * probabilities, so `samples: n` asks n times and takes the mean, which estimates the same expectation (planning §2.3 7.6).
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckContext } from '../checks.js';
import { conversationInput } from './conversation-input.js';
import { runTemplate, type TemplateInput } from './judge-templates.js';
import { addUsage, assertJudgeUsable, claimsPass, guarded, judgeMeta, judgePanel, meets, na, needsField, noUsage, panelOf, referenceText, round3, single, type Usage } from './judged-kit.js';
import { gevalSteps, PAIRWISE, SUMMARY_ALIGNMENT, SUMMARY_ANSWERS, SUMMARY_QUESTIONS, summaryCoverage } from './prompts-extra.js';
import { num, result } from './metric-util.js';
import { listOf } from './lists.js';

const fail = (cfg: CheckConfig, msg: string): CheckResult => result(cfg, false, msg, { source: 'ai-judge', explanation: msg });

/* ------------------------------------------------------------------ g-eval */

/** The score range: [1, 5] as a list, as text ("1-5", "[1, 5]"), default 1 to 5. */
function scaleOf(v: unknown): [number, number] {
  let x = v;
  if (typeof v === 'string') {
    const m = /(-?\d+)\s*(?:-|–|to|,)\s*(-?\d+)/.exec(v);
    x = m ? [Number(m[1]), Number(m[2])] : undefined;
  }
  return Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === 'number') ? [x[0] as number, x[1] as number] : typeof v === 'string' && v.trim() ? [Number.NaN, Number.NaN] : [1, 5];
}

/** DeepEval's parameter names are accepted beside TestPion's. */
const PARAM: Record<string, TemplateInput> = { question: 'question', input: 'question', answer: 'answer', actual_output: 'answer', output: 'answer', reference: 'reference', expected_output: 'reference', contexts: 'contexts', context: 'contexts', retrieval_context: 'contexts', conversation: 'conversation' };

function gevalCheck(id: 'g-eval' | 'conversational-g-eval') {
  return async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
    const criteria = typeof cfg.criteria === 'string' ? cfg.criteria.trim() : '';
    if (!criteria) return fail(cfg, `${id} needs "criteria": what a good answer is, in words (G-Eval turns it into evaluation steps).`);
    const inputs = [...new Set((listOf(cfg.params) ?? (id === 'conversational-g-eval' ? ['conversation'] : ['question'])).map((p) => PARAM[String(p).trim()]).filter((x): x is TemplateInput => !!x))];
    if (id === 'conversational-g-eval' && !inputs.includes('conversation')) inputs.push('conversation');
    if (id === 'conversational-g-eval' && !conversationInput(ctx.record?.turns).some((m) => m.role === 'assistant')) return needsField(cfg, id, 'a conversation', 'add a "turns" column to the dataset and run it against a RAG target.');
    const [min, max] = scaleOf(cfg.scale);
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) return fail(cfg, `${id} scale must be two whole numbers with the second larger (got ${JSON.stringify(cfg.scale)}).`);
    let steps = listOf(cfg.steps) ?? [];
    if (!steps.length) {
      // the steps are written once by the judge from the criteria and cached (same criteria, same judge: the same steps)
      const gm = gevalSteps(criteria);
      const g = await guarded(cfg, ctx, gm, async (host) => {
        const panel = panelOf(cfg, ctx, 0);
        assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
        const p = await claimsPass(host, gm, {}, panel);
        return result(cfg, true, 'steps', { metadata: { steps: p.claims, usage: p.usage } });
      });
      const made = (g.metadata as { steps?: string[] } | undefined)?.steps;
      if (!made) return g;
      if (!made.length) return na(cfg, gm, 'the judge wrote no evaluation steps for the criteria');
      steps = made;
    }
    const withSteps = `${criteria}\n\nEvaluation steps (follow them in order, then rate):\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    const samples = Math.max(1, Math.min(10, Math.floor(num(cfg.samples, 1))));
    const r = await runTemplate(samples > 1 ? { ...cfg, repeat: samples } : cfg, ctx, { id, kind: 'scale', criteria: withSteps, min, max, inputs }, { threshold: num(cfg.threshold, 0.5) });
    return { ...r, metadata: { ...(r.metadata ?? {}), steps, scale: [min, max], ...(samples > 1 ? { samples } : {}) } };
  };
}
registerCheck('g-eval', gevalCheck('g-eval'));
registerCheck('conversational-g-eval', gevalCheck('conversational-g-eval'));

/* ------------------------------------------------------------------ pairwise */

registerCheck('pairwise', async (cfg, ctx) => {
  const other = typeof cfg.against === 'string' && cfg.against.trim() ? cfg.against : ctx.record?.otherAnswer;
  if (!other?.trim()) return needsField(cfg, 'pairwise', 'the answer to compare with', 'add a "baseline_answer" column to the dataset (the other system’s answer to the same question), or set "against" on the check.');
  if (!ctx.question?.trim()) return needsField(cfg, 'pairwise', 'the question', 'the dataset needs a "question" column.');
  if (!ctx.text.trim()) return na(cfg, PAIRWISE, 'the answer is empty');
  return guarded(cfg, ctx, PAIRWISE, async (host) => {
    const t = num(cfg.threshold, 0.5);
    const panel = single(panelOf(cfg, ctx, t));
    assertJudgeUsable(host, panel.judge);
    const ref = referenceText(cfg, ctx);
    const base = { question: ctx.question, ...(ref ? { reference: ref } : {}) };
    // blinded and in both orders: a preference that flips with the order is not a preference
    const first = await judgePanel(host, PAIRWISE, { ...base, answerA: ctx.text, answerB: other }, panel);
    const second = await judgePanel(host, PAIRWISE, { ...base, answerA: other, answerB: ctx.text }, panel);
    if (first.score === undefined || second.score === undefined) return na(cfg, PAIRWISE, 'the judge returned no verdict', { explanation: first.reasoning });
    // each score is how much A was preferred (1 A better, 0.5 tie, 0 B better); this answer was A first and B second
    const score = round3((first.score + (1 - second.score)) / 2);
    const usage: Usage = addUsage(addUsage(noUsage(), first.usage), second.usage);
    const consistent = Math.sign(first.score - 0.5) === Math.sign(0.5 - second.score);
    return result(cfg, meets(score, t, 'higher'), `pairwise ${score}: ${score > 0.5 ? 'this answer is preferred' : score < 0.5 ? 'the other answer is preferred' : 'a tie'}${consistent ? '' : ' (the two orders disagreed)'} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: `${first.reasoning} / ${second.reasoning}`,
      metadata: judgeMeta(PAIRWISE, { ...first, usage }, t, { promptVersion: PAIRWISE.version, orders: [first.score, round3(1 - second.score)], consistent, win: score > 0.5 ? 1 : score < 0.5 ? 0 : 0.5 }),
    });
  });
});

/* ------------------------------------------------------------------ summarization */

registerCheck('summarization', async (cfg, ctx) => {
  const source = (typeof cfg.source === 'string' && cfg.source.trim() ? cfg.source : ctx.record?.source)?.trim();
  if (!source) return needsField(cfg, 'summarization', 'the source text', 'add a "source" column to the dataset (the text that was summarised), or set "source" on the check.');
  if (!ctx.text.trim()) return na(cfg, SUMMARY_ALIGNMENT, 'the summary is empty');
  const mode = cfg.mode === 'ragas' ? 'ragas' : 'deepeval';
  const n = Math.max(1, Math.min(20, Math.floor(num(cfg.questions, 5))));
  return guarded(cfg, ctx, SUMMARY_ALIGNMENT, async (host) => {
    const t = num(cfg.threshold, 0.5);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    let usage = noUsage();
    if (mode === 'deepeval') {
      const coverage = summaryCoverage(n);
      const [a, c] = await Promise.all([judgePanel(host, SUMMARY_ALIGNMENT, { source, answer: ctx.text }, panel), judgePanel(host, coverage, { source, answer: ctx.text }, panel)]);
      usage = addUsage(addUsage(usage, a.usage), c.usage);
      if (a.score === undefined || c.score === undefined) return na(cfg, SUMMARY_ALIGNMENT, a.score === undefined ? 'the summary makes no factual claims to check against the source' : 'the judge wrote no coverage questions', { metadata: judgeMeta(SUMMARY_ALIGNMENT, { ...a, usage }, t) });
      const score = round3(Math.min(a.score, c.score));
      return result(cfg, meets(score, t, 'higher'), `summarization ${score}: alignment ${a.score} (${a.items.filter((i) => i.ok).length} of ${a.items.length} claims supported by the source), coverage ${c.score} (${c.items.filter((i) => i.ok).length} of ${c.items.length} questions covered) (threshold ${t})`, {
        source: 'ai-judge',
        score,
        explanation: `${a.reasoning} / ${c.reasoning}`,
        metadata: judgeMeta(SUMMARY_ALIGNMENT, { ...a, usage, items: [...a.items.map((i) => ({ ...i, text: `claim: ${i.text}` })), ...c.items.map((i) => ({ ...i, text: `question: ${i.text}` }))] }, t, { promptVersion: `${SUMMARY_ALIGNMENT.version}+${coverage.version}`, mode, alignment: a.score, coverage: c.score }),
      });
    }
    // Ragas: questions from the key phrases of the source, answered from the summary alone; blended with how much shorter the summary is
    const q = await claimsPass(host, SUMMARY_QUESTIONS, { source }, panel);
    usage = addUsage(usage, q.usage);
    if (!q.claims.length) return na(cfg, SUMMARY_QUESTIONS, 'the judge found no key phrases in the source');
    const ans = await judgePanel(host, SUMMARY_ANSWERS, { questions: q.claims, answer: ctx.text }, panel);
    usage = addUsage(usage, ans.usage);
    if (ans.score === undefined) return na(cfg, SUMMARY_ANSWERS, 'the judge returned no verdict', { metadata: judgeMeta(SUMMARY_ANSWERS, { ...ans, usage }, t) });
    const conciseness = 1 - Math.min(ctx.text.length, source.length) / source.length;
    const w = Math.max(0, Math.min(1, num(cfg.coeff, 0.5)));
    const score = round3((1 - w) * ans.score + w * conciseness);
    return result(cfg, meets(score, t, 'higher'), `summarization ${score} (Ragas): questions answered from the summary ${ans.score}, conciseness ${round3(conciseness)} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: ans.reasoning,
      metadata: judgeMeta(SUMMARY_ANSWERS, { ...ans, usage }, t, { promptVersion: `${SUMMARY_QUESTIONS.version}+${SUMMARY_ANSWERS.version}`, mode, qa: ans.score, conciseness: round3(conciseness), coeff: w }),
    });
  });
});
