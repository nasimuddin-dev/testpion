/**
 * A `rag` test that names a `target`: the question goes to the RAG system through the target's request, its answer and
 * retrieved contexts are read by the target's mapping, and the test's evaluators score them (execute.ts calls this
 * from its `rag` case, handing over the protocol clients). A `rag` test without a target keeps its two older modes: the
 * answer and contexts written in the file (offline scoring), or our own model answering over the written contexts.
 *
 * A record with `turns` is a conversation: its user messages are replayed against the target one after another (eval/rag/
 * conversation.ts) and the transcript, with the system's own answers, is what the conversational metrics judge.
 */
import type { RagToolCallRef } from '@testpion/shared';
import type { CheckResult, RagTest, TestCase, TokenUsage } from '../model/types.js';
import type { VariableScope } from '../vars/variables.js';
import type { SpanHandle } from '../trace/tracer.js';
import type { CheckContext } from '../eval/checks.js';
import { callTarget, type TargetCall, type TargetRunner } from '../eval/rag/run-target.js';
import { pickRecord, type ConversationTurn } from '../eval/rag/record.js';
import { historyVars, runConversation, userMessages } from '../eval/rag/conversation.js';
import { scrubDocImage, storableRecord } from '../eval/rag/images.js';
import { normalizeTest } from './loader.js';

export interface RagRunResult {
  ctx: CheckContext;
  partial: { input?: string; output?: string };
  metadata?: Record<string, unknown>;
  checks?: CheckResult[];
}

/** Runs one protocol step of a target and gives its check context (execute.ts owns the clients). */
export type StepRunner = (step: TestCase, scope: VariableScope) => Promise<CheckContext>;

/** The sample kept in a result: bounded, and already redacted by the run's redactor when the result is written. */
const KEEP_DOCS = 20;
const KEEP_CHARS = 8000;
/** A conversation keeps less of each turn's chunks than a single answer does (a long transcript must stay a small result). */
const KEEP_TURN_DOCS = 10;
const KEEP_TURN_CHARS = 2000;

const compactTurns = (turns: ConversationTurn[]): ConversationTurn[] =>
  turns.map((t) => (t.contexts ? { ...t, contexts: t.contexts.slice(0, KEEP_TURN_DOCS).map((d) => ({ ...d, text: d.text.slice(0, KEEP_TURN_CHARS) })) } : t));

export async function runRagTargetTest(test: RagTest, scope: VariableScope, span: SpanHandle, run: StepRunner, guard?: (step: TestCase, scope: VariableScope) => void): Promise<RagRunResult> {
  const record0 = pickRecord(test.variables);
  const messages = userMessages(record0?.turns);
  const first = scope.resolve(test.question);
  // a conversation asks the last user message of the transcript as "the question" of the single-turn metrics
  const s = span.child(messages.length ? 'rag conversation' : 'rag target', 'internal', { input: messages.length ? messages.join(' → ').slice(0, 500) : first });
  try {
    const runner: TargetRunner = { normalize: (raw) => normalizeTest(raw), run, guard };
    let calls: TargetCall[];
    let turns: ConversationTurn[] | undefined;
    let convToolCalls: RagToolCallRef[] | undefined;
    if (messages.length) {
      const conv = await runConversation(test.target!, messages.map((m) => scope.resolve(m)), scope, runner, test.variables ?? {});
      calls = conv.calls;
      turns = conv.turns;
      convToolCalls = conv.toolCalls;
    } else calls = [await callTarget(test.target!, first, scope, runner, { ...historyVars([], first, '', 1), ...(test.variables ?? {}) })];
    const call = calls[calls.length - 1]!;
    const { sample } = call;
    const question = turns ? [...turns].reverse().find((t) => t.role === 'user')?.content ?? first : first;
    const usages = calls.map((c) => c.sample.usage).filter((u): u is NonNullable<typeof u> => !!u);
    const sum = (k: 'inputTokens' | 'outputTokens' | 'totalTokens') => usages.reduce((a, u) => a + (u[k] ?? 0), 0);
    const tokens: TokenUsage | undefined = usages.length ? { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: usages.some((u) => u.totalTokens !== undefined) ? sum('totalTokens') : sum('inputTokens') + sum('outputTokens') } : undefined;
    const latencyMs = calls.reduce((a, c) => a + c.latencyMs, 0);
    s.setAttributes({ documents: sample.contexts.length, latencyMs, ...(turns ? { turns: calls.length } : {}) });
    s.end({ output: { answer: sample.answer.slice(0, 500), documents: sample.contexts.map((d) => ({ id: d.id, score: d.score, text: d.text.slice(0, 200) })) } });
    const reference = test.expected !== undefined ? scope.resolve(String(test.expected)) : undefined;
    // the tools the system called: its own trace (the target's mapping) beside any the dataset lists
    const traced = turns ? convToolCalls : sample.toolCalls;
    const toolCalls = traced?.length ? traced : record0?.toolCalls;
    const record = record0 || turns || toolCalls ? { ...(record0 ?? {}), ...(turns ? { turns } : {}), ...(toolCalls?.length ? { toolCalls } : {}) } : undefined;
    return {
      ctx: {
        testType: 'rag',
        status: call.ctx.status,
        body: sample.answer,
        text: sample.answer,
        contexts: sample.contexts,
        question,
        expected: reference,
        referenceContexts: test.referenceContexts,
        referenceIds: test.referenceIds,
        record,
        toolCalls,
        judge: test.judge,
        tokens,
        latencyMs: turns ? latencyMs : call.latencyMs,
        firstTokenMs: call.ctx.firstTokenMs,
      },
      partial: { input: turns ? messages.join('\n') : question, output: sample.answer.slice(0, 4000) },
      metadata: {
        rag: {
          query: question,
          ...(reference !== undefined ? { reference } : {}),
          ...(test.referenceIds?.length ? { referenceIds: test.referenceIds } : {}),
          ...(test.referenceContexts?.length ? { referenceContexts: test.referenceContexts } : {}),
          protocol: test.target!.protocol,
          ...(record ? { record: storableRecord({ ...record, ...(turns ? { turns: compactTurns(turns) } : {}) }) } : {}),
          documentIds: sample.contexts.map((d) => d.id),
          scores: sample.contexts.map((d) => d.score ?? null),
          sample: {
            answer: sample.answer.slice(0, KEEP_CHARS),
            contexts: sample.contexts.slice(0, KEEP_DOCS).map((d) => scrubDocImage({ ...d, text: d.text.slice(0, KEEP_CHARS) })),
            ...(sample.usage ? { usage: sample.usage } : {}),
            ...(toolCalls?.length ? { toolCalls: toolCalls.slice(0, 100) } : {}),
          },
          ...(turns ? { conversation: { turns: calls.length, latenciesMs: calls.map((c) => c.latencyMs), ...(calls.at(-1)?.sample.conversationId ? { conversationId: calls.at(-1)!.sample.conversationId } : {}) } } : {}),
          ...(calls.some((c) => c.sample.warnings.length) ? { warnings: calls.flatMap((c) => c.sample.warnings).slice(0, 10) } : {}),
        },
      },
    };
  } catch (e) {
    s.fail(e);
    throw e;
  }
}
