/**
 * Probe a RAG target: one real call with a question, the response as the mapping sees it, and the sample the mapping reads
 * from it (the Connect dialog's "Probe", `testpion rag probe`, the MCP tool rag_probe). A probe never needs a mapping and
 * never fails on a bad status: the response is what the mapping is made from.
 */
import type { RagSample, RagTarget } from '@testpion/shared';
import type { EngineContext } from '../engine.js';
import { callTarget } from '../eval/rag/run-target.js';
import type { RagResponse } from '../eval/rag/mapping.js';
import { Tracer } from '../trace/tracer.js';
import { assertProductionStep } from '../net/production-guard.js';
import { normalizeTest } from './loader.js';
import { productionStep, ragStepRunner } from './execute.js';

export interface RagProbe {
  question: string;
  /** What the mapping reads: the parsed response (an SSE stream as `{ events }`), its text, and which kind it is. */
  response: { kind: RagResponse['kind']; doc: unknown; text: string; truncated: boolean };
  status?: number;
  latencyMs: number;
  /** The sample the target's mapping reads from it (empty answer and contexts while there is no mapping yet). */
  sample: RagSample;
}

const MAX_TEXT = 200_000;

export async function probeRagTarget(ctx: EngineContext, target: RagTarget, question: string, o: { signal?: AbortSignal } = {}): Promise<RagProbe> {
  const tracer = new Tracer('rag probe', ctx.redactor);
  const root = tracer.start('rag probe', 'test');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeoutMs ?? ctx.services.defaultTimeoutMs);
  const onAbort = () => controller.abort();
  o.signal?.addEventListener('abort', onAbort);
  try {
    const svc = ctx.services;
    const call = await callTarget(
      target,
      question,
      ctx.vars,
      {
        normalize: (raw) => normalizeTest(raw),
        run: ragStepRunner(svc, root, controller.signal),
        guard: svc.production ? (step, sc) => assertProductionStep(svc.production!, productionStep(step, sc)) : undefined,
      },
      {},
      { probe: true },
    );
    const text = call.response.text;
    return {
      question,
      response: { kind: call.response.kind, doc: call.response.doc, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT },
      status: call.ctx.status,
      latencyMs: call.latencyMs,
      sample: call.sample,
    };
  } finally {
    clearTimeout(timeout);
    o.signal?.removeEventListener('abort', onAbort);
    root.end({ status: 'ok' });
  }
}
