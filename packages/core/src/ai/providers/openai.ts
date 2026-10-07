import type { ProviderConfig } from '../../model/types.js';
import type { ChatMessage, ChatRequest, ChatResponse, LlmProvider, ToolCall } from '../types.js';
import { estimateTokens } from '../types.js';
import { configuredHeaders, doFetch, parseToolCall, postJson, sseEvents, StreamTimer } from '../http.js';
import type { Redactor } from '../../util/redact.js';

/**
 * OpenAI-compatible Chat Completions provider. Also used for Azure OpenAI, Ollama, vLLM,
 * LM Studio, OpenRouter and any other server implementing `/chat/completions`.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(
    readonly config: ProviderConfig,
    private apiKey: string | undefined,
    private redactor?: Redactor,
  ) {}

  private get isAzure(): boolean {
    return this.config.kind === 'azure-openai';
  }

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const u = `${base}${path}`;
    if (this.isAzure) return `${u}${u.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(this.config.apiVersion || '2024-10-21')}`;
    return u;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) {
      if (this.isAzure) h['api-key'] = this.apiKey;
      else h.authorization = `Bearer ${this.apiKey}`;
    }
    for (const [k, v] of configuredHeaders(this.config)) h[k] = v;
    return h;
  }

  private toWire(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length)
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.rawArguments ?? JSON.stringify(t.arguments) } })),
      };
    return { role: m.role, content: m.content };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const body: Record<string, unknown> = { model: req.model, messages: req.messages.map((m) => this.toWire(m)) };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.seed !== undefined) body.seed = req.seed;
    if (req.tools?.length)
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } } }));
    if (req.responseFormat?.type === 'json') body.response_format = { type: 'json_object' };
    else if (req.responseFormat?.type === 'json_schema' && req.responseFormat.schema)
      body.response_format = { type: 'json_schema', json_schema: { name: req.responseFormat.name ?? 'output', schema: req.responseFormat.schema, strict: false } };

    const opts = { signal: req.signal, redactor: this.redactor, provider: this.config.name };
    const timer = new StreamTimer();

    if (!req.stream) {
      const j = (await postJson(this.url('/chat/completions'), body, this.headers(), opts)) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const msg = j.choices?.[0]?.message;
      const text = msg?.content ?? '';
      const toolCalls = (msg?.tool_calls ?? []).map((t) => parseToolCall(t.id, t.function.name, t.function.arguments));
      return this.finish(text, toolCalls, j.usage, j.choices?.[0]?.finish_reason, j.model ?? req.model, timer.result(startedAt), j, req);
    }

    body.stream = true;
    body.stream_options = { include_usage: true };
    const res = await doFetch(this.url('/chat/completions'), body, this.headers(), opts);
    let text = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let finish: string | undefined;
    let model = req.model;
    const partial = new Map<number, { id: string; name: string; args: string }>();
    for await (const ev of sseEvents(res)) {
      if (ev.data === '[DONE]') break;
      let chunk: {
        model?: string;
        usage?: typeof usage;
        choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
      };
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const c = chunk.choices?.[0];
      if (c?.finish_reason) finish = c.finish_reason;
      const d = c?.delta;
      if (d?.content) {
        timer.tick();
        text += d.content;
        req.onDelta?.(d.content);
      }
      for (const tc of d?.tool_calls ?? []) {
        timer.tick();
        const p = partial.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: '', args: '' };
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
        partial.set(tc.index, p);
      }
    }
    const toolCalls = [...partial.values()].map((p) => parseToolCall(p.id, p.name, p.args));
    return this.finish(text, toolCalls, usage, finish, model, timer.result(startedAt), undefined, req);
  }

  private finish(
    text: string,
    toolCalls: ToolCall[],
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
    finishReason: string | undefined,
    model: string,
    timing: ChatResponse['timing'],
    raw: unknown,
    req: ChatRequest,
  ): ChatResponse {
    const estimated = !usage;
    const input = usage?.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join('\n'));
    const output = usage?.completion_tokens ?? estimateTokens(text);
    return {
      text,
      toolCalls,
      usage: { inputTokens: input, outputTokens: output, totalTokens: usage?.total_tokens ?? input + output },
      usageEstimated: estimated || undefined,
      finishReason,
      model,
      timing,
      raw,
    };
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    const j = (await postJson(this.url('/embeddings'), { model: model ?? this.config.embeddingModel, input: texts }, this.headers(), {
      signal,
      redactor: this.redactor,
      provider: this.config.name,
    })) as { data?: Array<{ embedding: number[]; index: number }> };
    return (j.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await doFetch(this.url('/models'), undefined, this.headers(), { signal, provider: this.config.name, method: 'GET', redactor: this.redactor });
    const j = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
    return (j.data?.map((d) => d.id) ?? j.models?.map((m) => m.name) ?? []).sort();
  }
}

