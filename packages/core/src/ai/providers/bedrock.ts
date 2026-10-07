import type { ProviderConfig } from '../../model/types.js';
import type { ChatMessage, ChatRequest, ChatResponse, LlmProvider, ToolCall } from '../types.js';
import { configuredHeaders, doFetch } from '../http.js';
import { signAwsV4 } from '../../protocols/http/signing.js';
import { ApsError } from '../../errors.js';
import type { Redactor } from '../../util/redact.js';

type Block = { text?: string; toolUse?: { toolUseId: string; name: string; input: unknown }; toolResult?: { toolUseId: string; content: Array<{ json?: unknown; text?: string }> } };
type ConverseResponse = {
  output?: { message?: { role: string; content?: Block[] } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

/** The region of a Bedrock endpoint (bedrock-runtime.<region>.amazonaws.com), if the URL names one. */
export function bedrockRegion(url: string): string | undefined {
  return /\bbedrock(?:-runtime)?(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/i.exec(url)?.[1];
}

/**
 * Credentials from the provider's key: `accessKeyId:secretAccessKey[:sessionToken]` signs requests with
 * AWS Signature V4; anything else is sent as a Bedrock API key (`Authorization: Bearer …`).
 */
export function bedrockCredentials(key: string | undefined): { accessKey: string; secretKey: string; sessionToken?: string } | { bearer: string } | undefined {
  if (!key) return undefined;
  const m = /^((?:AKIA|ASIA)[A-Z0-9]{12,}):([^:\s]+)(?::(\S+))?$/.exec(key.trim());
  return m ? { accessKey: m[1]!, secretKey: m[2]!, ...(m[3] ? { sessionToken: m[3] } : {}) } : { bearer: key.trim() };
}

/**
 * Amazon Bedrock through the Converse API (one request format for every model on Bedrock):
 * text, system prompts, tool use, usage. Streaming is not used: the whole answer arrives at once
 * (so time to first token equals the total time). Embeddings use Titan / Cohere InvokeModel.
 */
export class BedrockProvider implements LlmProvider {
  private region: string;

  constructor(
    readonly config: ProviderConfig,
    private apiKey: string | undefined,
    private redactor?: Redactor,
  ) {
    const region = config.region || bedrockRegion(config.baseUrl);
    if (!region) throw new ApsError('ConfigurationError', 'Set the AWS region of the Bedrock provider', { suggestions: ['e.g. us-east-1, or a base URL like https://bedrock-runtime.us-east-1.amazonaws.com'] });
    this.region = region;
  }

  private base(): string {
    return (this.config.baseUrl || `https://bedrock-runtime.${this.region}.amazonaws.com`).replace(/\/+$/, '');
  }

  /** Signed (SigV4) or bearer headers for one request; extra headers from the provider settings first. */
  private headers(method: string, url: string, body: string | undefined): Record<string, string> {
    const h = new Headers();
    for (const [k, v] of configuredHeaders(this.config)) h.set(k, v);
    if (body !== undefined) h.set('content-type', 'application/json');
    const cred = bedrockCredentials(this.apiKey);
    if (!cred) throw new ApsError('ConfigurationError', `${this.config.name} needs AWS credentials`, { suggestions: ['Enter accessKeyId:secretAccessKey (optionally :sessionToken) or a Bedrock API key as the provider key.'] });
    if ('bearer' in cred) h.set('authorization', `Bearer ${cred.bearer}`);
    else {
      this.redactor?.addSecret(cred.secretKey);
      this.redactor?.addSecret(cred.sessionToken);
      signAwsV4(method, new URL(url), h, body, { ...cred, region: this.region, service: 'bedrock' });
    }
    return Object.fromEntries(h.entries());
  }

  private async call(method: 'GET' | 'POST', url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const res = await doFetch(url, body, this.headers(method, url, text), { signal, redactor: this.redactor, provider: this.config.name, method });
    const raw = await res.text();
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApsError('ProtocolError', `${this.config.name} returned a non-JSON response`, { details: { body: raw.slice(0, 1000) } });
    }
  }

  private toWire(messages: ChatMessage[]) {
    const system = messages.filter((m) => m.role === 'system' && m.content).map((m) => ({ text: m.content }));
    const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
    const push = (role: 'user' | 'assistant', block: Block) => {
      // Converse wants alternating roles: consecutive blocks of one role share a message
      const last = out[out.length - 1];
      if (last?.role === role) last.content.push(block);
      else out.push({ role, content: [block] });
    };
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        let json: unknown;
        try {
          json = JSON.parse(m.content);
        } catch {
          /* text */
        }
        push('user', { toolResult: { toolUseId: m.toolCallId ?? 'tool', content: [json !== undefined && typeof json === 'object' && json !== null ? { json } : { text: m.content }] } });
      } else if (m.role === 'assistant') {
        if (m.content) push('assistant', { text: m.content });
        for (const t of m.toolCalls ?? []) push('assistant', { toolUse: { toolUseId: t.id, name: t.name, input: t.arguments } });
      } else push('user', { text: m.content });
    }
    return { system, messages: out };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const { system, messages } = this.toWire(req.messages);
    // no native JSON mode in Converse: ask for it (the answer is validated locally anyway)
    if (req.responseFormat && req.responseFormat.type !== 'text')
      system.push({ text: `Respond with JSON only, no prose or code fences.${req.responseFormat.schema ? ` It must match this JSON Schema: ${JSON.stringify(req.responseFormat.schema)}` : ''}` });
    const inferenceConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) inferenceConfig.temperature = req.temperature;
    if (req.topP !== undefined) inferenceConfig.topP = req.topP;
    if (req.maxTokens !== undefined) inferenceConfig.maxTokens = req.maxTokens;
    const body: Record<string, unknown> = { messages };
    if (system.length) body.system = system;
    if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig;
    if (req.tools?.length) body.toolConfig = { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema } } })) };
    const j = (await this.call('POST', `${this.base()}/model/${encodeURIComponent(req.model)}/converse`, body, req.signal)) as ConverseResponse;
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const b of j.output?.message?.content ?? []) {
      if (b.text) text += b.text;
      if (b.toolUse) toolCalls.push({ id: b.toolUse.toolUseId, name: b.toolUse.name, arguments: (b.toolUse.input ?? {}) as Record<string, unknown>, rawArguments: JSON.stringify(b.toolUse.input ?? {}) });
    }
    if (req.stream && text) req.onDelta?.(text);
    const totalMs = Date.now() - startedAt;
    const inT = j.usage?.inputTokens ?? 0;
    const outT = j.usage?.outputTokens ?? 0;
    return {
      text,
      toolCalls,
      usage: { inputTokens: inT, outputTokens: outT, totalTokens: j.usage?.totalTokens ?? inT + outT },
      finishReason: j.stopReason,
      model: req.model,
      timing: { startedAt, totalMs, ...(req.stream ? { firstTokenMs: totalMs } : {}) },
      raw: j,
    };
  }

  /** Foundation models with text output, from the Bedrock control plane (bedrock.<region>). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const runtime = this.base();
    // AWS endpoints: the control plane is bedrock.<region>; a custom endpoint (proxy, gateway) serves both
    const control = /bedrock-runtime/.test(runtime) ? runtime.replace('bedrock-runtime', 'bedrock') : runtime;
    const j = (await this.call('GET', `${control}/foundation-models?byOutputModality=TEXT`, undefined, signal)) as { modelSummaries?: Array<{ modelId: string }> };
    return (j.modelSummaries ?? []).map((m) => m.modelId);
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    const m = model ?? this.config.embeddingModel ?? 'amazon.titan-embed-text-v2:0';
    const url = `${this.base()}/model/${encodeURIComponent(m)}/invoke`;
    if (m.startsWith('cohere.')) {
      const j = (await this.call('POST', url, { texts, input_type: 'search_document' }, signal)) as { embeddings?: number[][] };
      return j.embeddings ?? [];
    }
    // Titan takes one text per call
    const out: number[][] = [];
    for (const t of texts) {
      const j = (await this.call('POST', url, { inputText: t }, signal)) as { embedding?: number[] };
      out.push(j.embedding ?? []);
    }
    return out;
  }
}
