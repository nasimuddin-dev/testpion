import type { ProviderConfig } from '../../model/types.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../types.js';
import { estimateTokens } from '../types.js';
import { sleep } from '../../util/concurrency.js';

export interface MockRule {
  /** Regular expression matched against the last user message. */
  match: string;
  response?: string;
  /** Force a tool call (agent testing). */
  toolCall?: { name: string; arguments?: Record<string, unknown> };
}

/**
 * Deterministic offline provider for mock LLM responses (spec §36): useful for
 * offline authoring, CI without API keys and deterministic regression tests.
 *
 * Rules are read from provider headers: a header `x-mock-rules` containing a JSON array of MockRule.
 * Without rules it echoes the prompt. When tools are offered and no tool result exists yet,
 * it calls the first tool whose name appears in the prompt (or the first tool).
 */
export class MockProvider implements LlmProvider {
  private rules: MockRule[] = [];
  private latency = 0;
  // a rule's pattern, compiled once (an evaluation calls chat() per record)
  private patterns = new Map<string, RegExp>();
  private pattern(match: string): RegExp {
    let re = this.patterns.get(match);
    if (!re) {
      re = new RegExp(match, 'i');
      this.patterns.set(match, re);
    }
    return re;
  }

  constructor(readonly config: ProviderConfig) {
    const h = (name: string) => config.headers?.find((x) => x.key.toLowerCase() === name)?.value;
    try {
      this.rules = JSON.parse(h('x-mock-rules') ?? '[]');
    } catch {
      this.rules = [];
    }
    this.latency = Number(h('x-mock-latency-ms') ?? 0) || 0;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const t0 = performance.now();
    if (this.latency) await sleep(this.latency, req.signal);
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    let text = '';
    let toolCalls: ChatResponse['toolCalls'] = [];
    const rule = this.rules.find((r) => {
      try {
        return this.pattern(r.match).test(lastUser);
      } catch {
        return false;
      }
    });
    if (rule?.toolCall && !hasToolResult) toolCalls = [{ id: 'call_0', name: rule.toolCall.name, arguments: rule.toolCall.arguments ?? {} }];
    else if (rule?.response !== undefined) text = rule.response;
    else if (req.tools?.length && !hasToolResult) {
      const tool = req.tools.find((t) => lastUser.toLowerCase().includes(t.name.toLowerCase())) ?? req.tools[0]!;
      toolCalls = [{ id: 'call_0', name: tool.name, arguments: {} }];
    } else if (hasToolResult) {
      const last = [...req.messages].reverse().find((m) => m.role === 'tool');
      text = `Based on the tool result: ${last?.content ?? ''}`;
    } else if (req.responseFormat && req.responseFormat.type !== 'text') text = JSON.stringify({ echo: lastUser });
    else text = `Mock response: ${lastUser}`;

    if (text && req.stream && req.onDelta) for (const w of text.split(/(?<=\s)/)) req.onDelta(w);
    const inT = estimateTokens(req.messages.map((m) => m.content).join('\n'));
    const outT = estimateTokens(text || JSON.stringify(toolCalls));
    const totalMs = Math.round(performance.now() - t0);
    return {
      text,
      toolCalls,
      usage: { inputTokens: inT, outputTokens: outT, totalTokens: inT + outT },
      usageEstimated: true,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      model: req.model || 'mock',
      timing: { startedAt, totalMs, firstTokenMs: totalMs },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Deterministic hashed bag-of-words embedding (64 dims) — adequate for offline similarity tests.
    return texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0;
        for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
        v[h % 64] += 1;
      }
      return v;
    });
  }

  async listModels(): Promise<string[]> {
    return ['mock'];
  }
}
