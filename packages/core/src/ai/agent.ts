import type { TokenUsage } from '../model/types.js';
import type { ChatMessage, LlmProvider, ToolDefinition } from './types.js';
import type { SpanHandle } from '../trace/tracer.js';
import { ApsError } from '../errors.js';

export interface AgentTool extends ToolDefinition {
  source: 'mock' | 'mcp';
  server?: string;
  invoke(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError?: boolean; raw?: unknown }>;
}

interface AgentToolCallRecord {
  step: number;
  id: string;
  name: string;
  source: 'mock' | 'mcp' | 'unknown';
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

interface AgentRunResult {
  finalText: string;
  steps: number;
  toolCalls: AgentToolCallRecord[];
  usage: TokenUsage;
  latencyMs: number;
  modelCalls: number;
  stoppedReason: 'final' | 'max-steps';
  /** One entry per model call: what the model said and how many tools it asked for (the trajectory view's model steps). */
  rounds: Array<{ step: number; text: string; calls: number }>;
  transcript: ChatMessage[];
}

/**
 * Minimal, provider-agnostic tool-calling loop. Every model call and tool call is recorded
 * as a span so the full agent execution can be inspected in the trace viewer.
 */
export async function runAgent(opts: {
  provider: LlmProvider;
  model: string;
  system?: string;
  input: string;
  tools: AgentTool[];
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  span?: SpanHandle;
  signal?: AbortSignal;
}): Promise<AgentRunResult> {
  const t0 = performance.now();
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.input });
  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const calls: AgentToolCallRecord[] = [];
  const rounds: AgentRunResult['rounds'] = [];
  const maxSteps = opts.maxSteps ?? 8;
  let modelCalls = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) throw new ApsError('CancelledError', 'Agent run cancelled');
    const llmSpan = opts.span?.child(`llm step ${step}`, 'llm', {
      attributes: { model: opts.model, provider: opts.provider.config.name, step },
      input: messages[messages.length - 1],
    });
    let r;
    try {
      r = await opts.provider.chat({
        model: opts.model,
        messages,
        tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
      });
    } catch (e) {
      llmSpan?.fail(e);
      throw e;
    }
    modelCalls++;
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.totalTokens += r.usage.totalTokens;
    llmSpan?.setAttributes({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, finishReason: r.finishReason, toolCalls: r.toolCalls.length });
    llmSpan?.end({ output: r.toolCalls.length ? { text: r.text, toolCalls: r.toolCalls } : r.text });
    rounds.push({ step, text: r.text.slice(0, 600), calls: r.toolCalls.length });

    if (!r.toolCalls.length) {
      messages.push({ role: 'assistant', content: r.text });
      return { finalText: r.text, steps: step, toolCalls: calls, usage, latencyMs: Math.round(performance.now() - t0), modelCalls, stoppedReason: 'final', rounds, transcript: messages };
    }

    messages.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls });
    for (const tc of r.toolCalls) {
      const tool = toolByName.get(tc.name);
      const tSpan = opts.span?.child(`${tool?.source === 'mcp' ? 'mcp' : 'tool'} ${tc.name}`, tool?.source === 'mcp' ? 'mcp' : 'tool', {
        attributes: { tool: tc.name, server: tool?.server, step },
        input: tc.arguments,
      });
      const ts = performance.now();
      let text: string;
      let isError = false;
      if (!tool) {
        text = `Error: tool "${tc.name}" is not available.`;
        isError = true;
      } else {
        try {
          const out = await tool.invoke(tc.arguments, opts.signal);
          text = out.text;
          isError = !!out.isError;
        } catch (e) {
          text = `Error: ${(e as Error).message}`;
          isError = true;
        }
      }
      const durationMs = Math.round(performance.now() - ts);
      tSpan?.end({ status: isError ? 'error' : 'ok', output: text, error: isError ? text.slice(0, 500) : undefined });
      calls.push({ step, id: tc.id, name: tc.name, source: tool?.source ?? 'unknown', arguments: tc.arguments, result: text.slice(0, 4000), isError, durationMs });
      messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: text });
    }
  }
  const last = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  return { finalText: last, steps: maxSteps, toolCalls: calls, usage, latencyMs: Math.round(performance.now() - t0), modelCalls, stoppedReason: 'max-steps', rounds, transcript: messages };
}
