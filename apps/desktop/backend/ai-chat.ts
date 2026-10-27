/** The AI playground chat (aiChat): one prompt to a model with the evaluators of the request. The Backend method is a one-line delegate. */
import { Tracer, estimateCost, runChecks, shortId, tryParseJson, validateSchema, renderPrompt } from '@testpion/core';
import type { AiChatParams } from './params.js';
import type { Backend } from './backend.js';
import { linkedController } from './request-context.js';

export async function aiChat(be: Backend, p: AiChatParams) {
  const id = p.requestId ?? shortId('ai-');
  const ctrl = linkedController();
  be.controllers.set(id, ctrl);
  const ctx = be.context({ environment: p.environment });
  const tracer = new Tracer(`AI ${p.model}`, ctx.redactor);
  const deltas = be.batched<unknown>('ai.deltas', 40);
  try {
    const { provider, model } = ctx.services.providers.resolveModel({ provider: p.provider, name: p.model || undefined });
    const input = p.input ?? {};
    const prompt = renderPrompt(p.prompt, ctx.vars, input);
    const system = p.system ? renderPrompt(p.system, ctx.vars, input) : undefined;
    const messages = [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user' as const, content: prompt }];
    const span = tracer.start(`llm ${model}`, 'llm', { attributes: { provider: provider.config.name, model, temperature: p.temperature, topP: p.topP, maxTokens: p.maxTokens }, input: messages });
    const r = await provider.chat({
      model,
      messages,
      temperature: p.temperature,
      topP: p.topP,
      maxTokens: p.maxTokens,
      seed: p.seed,
      responseFormat: p.responseFormat,
      stream: p.stream !== false,
      signal: ctrl.signal,
      onDelta: (d) => deltas.push({ id, delta: d }),
    });
    deltas.flush();
    const cost = estimateCost(be.settings.pricing, provider.config, r.model || model, r.usage);
    span.setAttributes({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, ttftMs: r.timing.firstTokenMs, costUsd: cost.cost });
    span.end({ output: r.text });
    const parsed = tryParseJson(r.text);
    const schemaCheck = p.responseFormat?.schema ? validateSchema(p.responseFormat.schema, parsed.ok ? parsed.value : undefined) : undefined;
    const checks = p.evaluators?.length
      ? await runChecks(ctx.vars.resolveDeep(p.evaluators), {
          testType: 'llm',
          body: parsed.ok ? parsed.value : r.text,
          text: r.text,
          latencyMs: r.timing.totalMs,
          tokens: r.usage,
          costUsd: cost.cost,
          input,
          expected: p.expected,
          services: { providers: ctx.services.providers },
        })
      : [];
    const trace = tracer.finish();
    be.record('trace', () => be.ws.saveTrace(trace, 'llm'));
    be.record('history entry', () => be.ws.meta.addHistory({ id: shortId('h-'), timestamp: new Date().toISOString(), kind: 'llm', name: `${provider.config.name} · ${r.model || model}`, status: 'ok', durationMs: r.timing.totalMs, request: { provider: p.provider, model, prompt: p.prompt, system: p.system, input }, responseMeta: { usage: r.usage, costUsd: cost.cost, firstTokenMs: r.timing.firstTokenMs }, traceId: trace.traceId }));
    return {
      id,
      provider: provider.config.name,
      model: r.model || model,
      text: r.text,
      json: parsed.ok ? parsed.value : undefined,
      isJson: parsed.ok,
      schemaValid: schemaCheck?.valid,
      schemaErrors: schemaCheck?.errors,
      toolCalls: r.toolCalls,
      usage: r.usage,
      usageEstimated: r.usageEstimated,
      costUsd: cost.cost,
      priceVersion: cost.priceVersion,
      timing: r.timing,
      finishReason: r.finishReason,
      checks,
      renderedPrompt: prompt,
      traceId: trace.traceId,
    };
  } finally {
    be.controllers.delete(id);
  }
}
