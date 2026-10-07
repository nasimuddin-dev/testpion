import type { ProviderConfig } from '../../model/types.js';
import type { ChatMessage, ChatRequest, ChatResponse, LlmProvider, ToolCall } from '../types.js';
import { configuredHeaders, doFetch, parseToolCall, postJson, sseEvents, StreamTimer } from '../http.js';
import type { Redactor } from '../../util/redact.js';

/** Anthropic Messages API (and compatible gateways). */
export class AnthropicProvider implements LlmProvider {
  constructor(
    readonly config: ProviderConfig,
    private apiKey: string | undefined,
    private redactor?: Redactor,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'anthropic-version': this.config.apiVersion || '2023-06-01' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    for (const [k, v] of configuredHeaders(this.config)) h[k] = v;
    return h;
  }

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return /\/v1$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
  }

  private toWire(messages: ChatMessage[]): { system?: string; messages: Array<Record<string, unknown>> } {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
    const out: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        const last = out[out.length - 1];
        // consecutive tool results are merged into one user turn
        if (last?.role === 'user' && Array.isArray(last.content) && (last.content as Array<{ type: string }>).every((b) => b.type === 'tool_result'))
          (last.content as unknown[]).push(block);
        else out.push({ role: 'user', content: [block] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments });
        out.push({ role: 'assistant', content });
      } else out.push({ role: m.role, content: m.content });
    }
    return { system, messages: out };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const { system, messages } = this.toWire(req.messages);
    let sys = system;
    if (req.responseFormat && req.responseFormat.type !== 'text') {
      const hint = req.responseFormat.schema
        ? `Respond only with a JSON value that conforms to this JSON Schema:\n${JSON.stringify(req.responseFormat.schema)}`
        : 'Respond only with valid JSON.';
      sys = sys ? `${sys}\n\n${hint}` : hint;
    }
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? 1024, messages };
    if (sys) body.system = sys;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.tools?.length)
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? { type: 'object', properties: {} } }));
    const opts = { signal: req.signal, redactor: this.redactor, provider: this.config.name };
    const timer = new StreamTimer();

    if (!req.stream) {
      const j = (await postJson(this.url('/messages'), body, this.headers(), opts)) as {
        model?: string;
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const toolCalls: ToolCall[] = (j.content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id!, name: b.name!, arguments: b.input ?? {}, rawArguments: JSON.stringify(b.input ?? {}) }));
      const inT = j.usage?.input_tokens ?? 0;
      const outT = j.usage?.output_tokens ?? 0;
      return { text, toolCalls, usage: { inputTokens: inT, outputTokens: outT, totalTokens: inT + outT }, finishReason: j.stop_reason, model: j.model ?? req.model, timing: timer.result(startedAt), raw: j };
    }

    body.stream = true;
    const res = await doFetch(this.url('/messages'), body, this.headers(), opts);
    let text = '';
    let inT = 0;
    let outT = 0;
    let finish: string | undefined;
    let model = req.model;
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    for await (const ev of sseEvents(res)) {
      let d: Record<string, any>;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (d.type) {
        case 'message_start':
          model = d.message?.model ?? model;
          inT = d.message?.usage?.input_tokens ?? 0;
          outT = d.message?.usage?.output_tokens ?? 0;
          break;
        case 'content_block_start':
          blocks.set(d.index, { type: d.content_block?.type, id: d.content_block?.id, name: d.content_block?.name, json: '' });
          break;
        case 'content_block_delta':
          timer.tick();
          if (d.delta?.type === 'text_delta') {
            text += d.delta.text;
            req.onDelta?.(d.delta.text);
          } else if (d.delta?.type === 'input_json_delta') {
            const b = blocks.get(d.index);
            if (b) b.json += d.delta.partial_json ?? '';
          }
          break;
        case 'message_delta':
          if (d.usage?.output_tokens !== undefined) outT = d.usage.output_tokens;
          if (d.delta?.stop_reason) finish = d.delta.stop_reason;
          break;
        case 'error':
          throw new Error(d.error?.message ?? 'Anthropic stream error');
      }
    }
    const toolCalls: ToolCall[] = [...blocks.values()].filter((b) => b.type === 'tool_use').map((b) => parseToolCall(b.id!, b.name!, b.json));
    return { text, toolCalls, usage: { inputTokens: inT, outputTokens: outT, totalTokens: inT + outT }, finishReason: finish, model, timing: timer.result(startedAt) };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await doFetch(this.url('/models'), undefined, this.headers(), { signal, provider: this.config.name, method: 'GET', redactor: this.redactor });
    const j = (await res.json()) as { data?: Array<{ id: string }> };
    return (j.data ?? []).map((d) => d.id);
  }
}
