/**
 * A `rag` test that names a `target`: the question goes to the RAG system through the target's request, its answer and
 * retrieved contexts are read by the target's mapping, and the test's evaluators score them (execute.ts calls this
 * from its `rag` case, handing over the protocol clients). A `rag` test without a target keeps its two older modes: the
 * answer and contexts written in the file (offline scoring), or our own model answering over the written contexts.
 */
import type { CheckResult, RagTest, TestCase, TokenUsage } from '../model/types.js';
import type { VariableScope } from '../vars/variables.js';
import type { SpanHandle } from '../trace/tracer.js';
import type { CheckContext } from '../eval/checks.js';
import { callTarget } from '../eval/rag/run-target.js';
import { pickRecord } from '../eval/rag/record.js';
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

export async function runRagTargetTest(test: RagTest, scope: VariableScope, span: SpanHandle, run: StepRunner, guard?: (step: TestCase, scope: VariableScope) => void): Promise<RagRunResult> {
  const question = scope.resolve(test.question);
  const s = span.child('rag target', 'internal', { input: question });
  try {
    const call = await callTarget(
      test.target!,
      question,
      scope,
      {
        normalize: (raw) => normalizeTest(raw),
        run,
        guard,
      },
      test.variables ?? {},
    );
    const { sample } = call;
    const u = sample.usage;
    const tokens: TokenUsage | undefined = u ? { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) } : undefined;
    s.setAttributes({ documents: sample.contexts.length, latencyMs: call.latencyMs });
    s.end({ output: { answer: sample.answer.slice(0, 500), documents: sample.contexts.map((d) => ({ id: d.id, score: d.score, text: d.text.slice(0, 200) })) } });
    const reference = test.expected !== undefined ? scope.resolve(String(test.expected)) : undefined;
    const record = pickRecord(test.variables);
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
        toolCalls: record?.toolCalls,
        judge: test.judge,
        tokens,
        latencyMs: call.latencyMs,
        firstTokenMs: call.ctx.firstTokenMs,
      },
      partial: { input: question, output: sample.answer.slice(0, 4000) },
      metadata: {
        rag: {
          query: question,
          ...(reference !== undefined ? { reference } : {}),
          ...(test.referenceIds?.length ? { referenceIds: test.referenceIds } : {}),
          ...(test.referenceContexts?.length ? { referenceContexts: test.referenceContexts } : {}),
          protocol: test.target!.protocol,
          ...(record ? { record } : {}),
          documentIds: sample.contexts.map((d) => d.id),
          scores: sample.contexts.map((d) => d.score ?? null),
          sample: { answer: sample.answer.slice(0, KEEP_CHARS), contexts: sample.contexts.slice(0, KEEP_DOCS).map((d) => ({ ...d, text: d.text.slice(0, KEEP_CHARS) })), ...(sample.usage ? { usage: sample.usage } : {}) },
          ...(sample.warnings.length ? { warnings: sample.warnings.slice(0, 10) } : {}),
        },
      },
    };
  } catch (e) {
    s.fail(e);
    throw e;
  }
}
