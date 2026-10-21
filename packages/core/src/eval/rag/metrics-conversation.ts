/**
 * The conversational metrics (planning/rag-testing.md §2.3 type 9): knowledge retention, role adherence, conversation
 * completeness, turn relevancy, topic adherence (Ragas), the TruLens / Phoenix conversation judges, and `per-turn:<metric>`,
 * which scores every assistant turn with any single-turn metric. They read the transcript a conversation run produced
 * (`record.turns`: the user's messages and the system's own answers, with what it retrieved for each); a plain single-turn
 * sample has no transcript and the metric says so. Judged through the judge service like every other judged metric.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, runChecks, type CheckContext } from '../checks.js';
import { assistantTurns, conversationInput, type ConversationMessage } from './conversation-input.js';
import { turnPairs } from './conversation.js';
import { runTemplate, type TemplateInput } from './judge-templates.js';
import { addUsage, assertJudgeUsable, claimsPass, guarded, judgeMeta, judgePanel, judgedCheck, na, needsField, noUsage, panelOf, round3, meets, type Usage } from './judged-kit.js';
import { CONVERSATION_COMPLETENESS, KNOWLEDGE_RETENTION, ROLE_ADHERENCE, TOPIC_EXTRACT, topicClassify, turnRelevancy } from './prompts-conversation.js';
import type { JudgedMetric } from './judge-prompts.js';
import { num, result } from './metric-util.js';

const NEED_TURNS = 'add a "turns" column to the dataset (the user messages to send, or a transcript) and run it against a RAG target; the target replays the conversation turn by turn.';

/** The conversation of a sample, or the reason it has none. */
function conversationOf(ctx: CheckContext): ConversationMessage[] | undefined {
  const c = conversationInput(ctx.record?.turns);
  return assistantTurns(c).length ? c : undefined;
}

const fail = (cfg: CheckConfig, msg: string): CheckResult => result(cfg, false, msg, { source: 'ai-judge', explanation: msg });

/** A judged check over the transcript: the conversation must exist; `extra` may demand more (a role, topics). */
function convCheck(spec: { id: string; threshold: number; metric: (cfg: CheckConfig) => JudgedMetric; need?: (cfg: CheckConfig, ctx: CheckContext) => string | undefined; input?: (cfg: CheckConfig, c: ConversationMessage[]) => Record<string, unknown> }) {
  return async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
    const c = conversationOf(ctx);
    if (!c) return needsField(cfg, spec.id, 'a conversation', NEED_TURNS);
    const bad = spec.need?.(cfg, ctx);
    if (bad) return fail(cfg, bad);
    return judgedCheck({ metric: spec.metric(cfg), id: spec.id, threshold: spec.threshold, input: (k) => ({ conversation: c, ...(spec.input?.(k, c) ?? {}) }), emptyWhy: 'the conversation has nothing to judge' })(cfg, ctx);
  };
}

registerCheck('knowledge-retention', convCheck({ id: 'knowledge-retention', threshold: 0.8, metric: () => KNOWLEDGE_RETENTION }));

registerCheck(
  'role-adherence',
  convCheck({
    id: 'role-adherence',
    threshold: 0.8,
    metric: () => ROLE_ADHERENCE,
    need: (cfg) => (typeof cfg.role === 'string' && cfg.role.trim() ? undefined : 'role-adherence needs "role": the assistant’s role in one sentence ("a polite clinic receptionist who never gives medical advice").'),
    input: (cfg) => ({ role: String(cfg.role).trim() }),
  }),
);

registerCheck('conversation-completeness', convCheck({ id: 'conversation-completeness', threshold: 0.8, metric: () => CONVERSATION_COMPLETENESS }));

registerCheck(
  'turn-relevancy',
  convCheck({
    id: 'turn-relevancy',
    threshold: 0.8,
    metric: (cfg) => turnRelevancy(Math.max(1, Math.min(40, Math.floor(num(cfg.window, 10))))),
  }),
);

/* ------------------------------------------------------------------ topic adherence (Ragas), two calls */

async function topicAdherence(cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> {
  const c = conversationOf(ctx);
  if (!c) return needsField(cfg, 'topic-adherence', 'a conversation', NEED_TURNS);
  const allowed = Array.isArray(cfg.topics) ? cfg.topics.map(String).filter((s) => s.trim()) : ctx.record?.referenceTopics;
  if (!allowed?.length) return needsField(cfg, 'topic-adherence', 'the allowed topics', 'list them in the metric’s "topics" or add a "reference_topics" column to the dataset.');
  const mode = (['f1', 'precision', 'recall'].includes(String(cfg.mode)) ? String(cfg.mode) : 'f1') as 'f1' | 'precision' | 'recall';
  const classify = topicClassify(mode);
  return guarded(cfg, ctx, classify, async (host) => {
    const t = num(cfg.threshold, 0.7);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    // step 1: the topics the user raised (one judge, once); step 2: each topic on the allowed list, and answered or refused
    const topics = await claimsPass(host, TOPIC_EXTRACT, { conversation: c }, panel);
    if (!topics.claims.length) return na(cfg, classify, 'the user raised no topic in this conversation', { metadata: { topics: [] } });
    const r = await judgePanel(host, classify, { conversation: c, topics: topics.claims, referenceTopics: allowed }, panel);
    if (r.score === undefined) return na(cfg, classify, 'the judge returned no verdict', { explanation: r.reasoning, metadata: judgeMeta(classify, r, t) });
    const score = round3(r.score);
    const usage: Usage = addUsage(topics.usage, r.usage);
    // the judge's own words per topic: on topic (verdict) and answered (rating 1)
    const lines = r.items.map((i) => `${i.text} (${i.ok ? 'on topic' : 'off topic'}, ${i.rating === 1 ? 'answered' : 'refused'})`);
    const passed = meets(score, t, 'higher') && !r.panel?.swap?.tie;
    return result(cfg, passed, `topic-adherence ${mode} ${score}: ${lines.slice(0, 4).join('; ')}${lines.length > 4 ? ` and ${lines.length - 4} more` : ''} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: r.reasoning,
      metadata: judgeMeta(classify, { ...r, usage }, t, { promptVersion: classify.version, topics: topics.claims, mode, referenceTopics: allowed }),
    });
  });
}
registerCheck('topic-adherence', topicAdherence);

/* ------------------------------------------------------------------ TruLens / Phoenix conversation judges (templates) */

const likertConv = (id: string, criteria: string, threshold: number) => (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
  if (!conversationOf(ctx)) return Promise.resolve(needsField(cfg, id, 'a conversation', NEED_TURNS));
  const inputs = ['conversation'] as TemplateInput[];
  return runTemplate(cfg, ctx, { id, kind: 'scale', criteria, min: 0, max: 3, inputs }, { threshold });
};
registerCheck('coherence-across-turns', likertConv('coherence-across-turns', 'How coherent is the assistant across the whole conversation: does each answer follow from the earlier ones, without contradicting them or losing the thread?', 0.67));
registerCheck('conversation-helpfulness', likertConv('conversation-helpfulness', 'How helpful is the assistant to the user over the whole conversation: does the user end up able to do what they came to do?', 0.67));
registerCheck('user-friction', (cfg, ctx) => {
  if (!conversationOf(ctx)) return Promise.resolve(needsField(cfg, 'user-friction', 'a conversation', NEED_TURNS));
  return runTemplate(
    cfg,
    ctx,
    { id: 'user-friction', kind: 'binary', criteria: 'The user never has to repeat, rephrase or correct a request because the assistant misunderstood it or did not do what was asked.', pass: 'The assistant understands each request the first time.', fail: 'The user repeats a request, rewords it, or says the assistant got it wrong.', inputs: ['conversation'] },
    { threshold: 1 },
  );
});

/* ------------------------------------------------------------------ per-turn:<metric> */

/** The metric a per-turn check scores each assistant turn with: the `metric` option, with the other options passed on. */
function perTurn(defaultMetric?: string) {
  return async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
    const inner = String(cfg.metric ?? defaultMetric ?? '');
    if (!inner) return fail(cfg, 'per-turn needs "metric": the single-turn metric to score each assistant turn with (per-turn:faithfulness).');
    const pairs = turnPairs(ctx.record?.turns);
    if (!pairs.length) return needsField(cfg, `per-turn:${inner}`, 'a conversation', NEED_TURNS);
    const { metric: _m, type: _t, name: _n, ...options } = cfg as CheckConfig & { metric?: unknown };
    let usage = noUsage();
    const scores: Array<{ turn: number; score?: number; passed: boolean; message: string }> = [];
    for (const p of pairs) {
      // every turn is scored as its own sample: its question, its answer, what was retrieved for it; the reference stays the conversation's
      const turnCtx: CheckContext = {
        ...ctx,
        question: p.question,
        text: p.answer,
        body: p.answer,
        contexts: (p.turn.contexts ?? []).map((d) => ({ ...d })),
        toolCalls: p.turn.toolCalls ?? ctx.toolCalls,
        record: { ...ctx.record, turns: undefined },
        ragRun: { strict: true, metrics: [inner] },
      };
      const [r] = await runChecks([{ ...options, type: inner }], turnCtx);
      const u = (r?.metadata as { judgeUsage?: Usage } | undefined)?.judgeUsage;
      if (u) usage = addUsage(usage, u);
      const isNa = !!(r?.metadata as { na?: string } | undefined)?.na;
      scores.push({ turn: p.index, ...(typeof r?.score === 'number' && !isNa ? { score: r.score } : {}), passed: !!r?.passed, message: r?.message ?? '' });
    }
    const scored = scores.filter((s) => s.score !== undefined);
    if (!scored.length) return na(cfg, { id: `per-turn:${inner}`, version: 'per-turn-v1' }, `${inner} gave no score for any of the ${pairs.length} turns`, { metadata: { turns: scores } });
    const values = scored.map((s) => s.score!);
    const mean = round3(values.reduce((a, b) => a + b, 0) / values.length);
    const min = round3(Math.min(...values));
    const aggregate = cfg.aggregate === 'min' ? 'min' : 'mean';
    const score = aggregate === 'min' ? min : mean;
    const t = num(cfg.threshold, 0.8);
    return result(cfg, meets(score, t, 'higher'), `per-turn ${inner} ${aggregate} ${score} over ${scored.length} turn(s) (mean ${mean}, lowest ${min}; threshold ${t})`, {
      source: 'ai-judge',
      score,
      metadata: { metric: `per-turn:${inner}`, threshold: t, perTurn: scores.map((s) => ({ turn: s.turn, score: s.score ?? null, passed: s.passed })), mean, min, aggregate, promptVersion: 'per-turn-v1', judgeUsage: usage },
    });
  };
}
registerCheck('per-turn', perTurn());
registerCheck('turn-faithfulness', perTurn('faithfulness'));
