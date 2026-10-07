import type { ProviderConfig } from '../../model/types.js';
import type { ChatMessage, ChatRequest, ChatResponse, LlmProvider, ToolCall } from '../types.js';
import { configuredHeaders, doFetch, postJson, sseEvents, StreamTimer } from '../http.js';
import type { Redactor } from '../../util/redact.js';

type GeminiPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: unknown } };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  modelVersion?: string;
};

/** Google Gemini `generateContent` API (and compatible endpoints). */
export class GeminiProvider implements LlmProvider {
  constructor(
    readonly config: ProviderConfig,
    private apiKey: string | undefined,
    private redactor?: Redactor,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h['x-goog-api-key'] = this.apiKey;
    for (const [k, v] of configuredHeaders(this.config)) h[k] = v;
    return h;
  }

  private url(model: string, stream: boolean): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const root = /\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`;
    return `${root}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  }

  private toWire(messages: ChatMessage[]) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        let response: unknown;
        try {
          response = JSON.parse(m.content);
        } catch {
          response = { result: m.content };
        }
        if (typeof response !== 'object' || response === null || Array.isArray(response)) response = { result: response };
        contents.push({ role: 'user', parts: [{ functionResponse: { name: m.toolName ?? 'tool', response } }] });
      } else if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const t of m.toolCalls ?? []) parts.push({ functionCall: { name: t.name, args: t.arguments } });
        contents.push({ role: 'model', parts });
      } else contents.push({ role: 'user', parts: [{ text: m.content }] });
    }
    return { system, contents };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const { system, contents } = this.toWire(req.messages);
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.topP !== undefined) generationConfig.topP = req.topP;
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.seed !== undefined) generationConfig.seed = req.seed;
    if (req.responseFormat && req.responseFormat.type !== 'text') {
      generationConfig.responseMimeType = 'application/json';
      if (req.responseFormat.schema) generationConfig.responseJsonSchema = req.responseFormat.schema;
    }
    const body: Record<string, unknown> = { contents, generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.inputSchema })) }];
    const opts = { signal: req.signal, redactor: this.redactor, provider: this.config.name };
    const timer = new StreamTimer();

    const collect = (r: GeminiResponse, acc: { text: string; calls: ToolCall[] }) => {
      for (const p of r.candidates?.[0]?.content?.parts ?? []) {
        if (p.text) acc.text += p.text;
        if (p.functionCall)
          acc.calls.push({ id: `call_${acc.calls.length}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {}, rawArguments: JSON.stringify(p.functionCall.args ?? {}) });
      }
    };

    if (!req.stream) {
      const j = (await postJson(this.url(req.model, false), body, this.headers(), opts)) as GeminiResponse;
      const acc = { text: '', calls: [] as ToolCall[] };
      collect(j, acc);
      return this.result(acc, j.usageMetadata, j.candidates?.[0]?.finishReason, j.modelVersion ?? req.model, timer.result(startedAt), j);
    }

    const res = await doFetch(this.url(req.model, true), body, this.headers(), opts);
    const acc = { text: '', calls: [] as ToolCall[] };
    let usage: GeminiResponse['usageMetadata'];
    let finish: string | undefined;
    let model = req.model;
    for await (const ev of sseEvents(res)) {
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const before = acc.text.length;
      collect(chunk, acc);
      if (acc.text.length > before) {
        timer.tick();
        req.onDelta?.(acc.text.slice(before));
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.candidates?.[0]?.finishReason) finish = chunk.candidates[0].finishReason;
      if (chunk.modelVersion) model = chunk.modelVersion;
    }
    return this.result(acc, usage, finish, model, timer.result(startedAt), undefined);
  }

  private result(acc: { text: string; calls: ToolCall[] }, u: GeminiResponse['usageMetadata'], finish: string | undefined, model: string, timing: ChatResponse['timing'], raw: unknown): ChatResponse {
    const inT = u?.promptTokenCount ?? 0;
    const outT = u?.candidatesTokenCount ?? 0;
    return { text: acc.text, toolCalls: acc.calls, usage: { inputTokens: inT, outputTokens: outT, totalTokens: u?.totalTokenCount ?? inT + outT }, finishReason: finish, model, timing, raw };
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    const m = model ?? this.config.embeddingModel ?? 'text-embedding-004';
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const root = /\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`;
    const j = (await postJson(
      `${root}/models/${encodeURIComponent(m)}:batchEmbedContents`,
      { requests: texts.map((t) => ({ model: `models/${m}`, content: { parts: [{ text: t }] } })) },
      this.headers(),
      { signal, redactor: this.redactor, provider: this.config.name },
    )) as { embeddings?: Array<{ values: number[] }> };
    return (j.embeddings ?? []).map((e) => e.values);
  }
}
