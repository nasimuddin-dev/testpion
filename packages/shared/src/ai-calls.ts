/**
 * AI traffic in the Debugger (FG-18): is this exchange a call to an LLM (OpenAI and compatible, Anthropic, Gemini, Ollama) or
 * an MCP JSON-RPC message, and what is in it: the model, the messages, the tools, the answer (a streamed one is put back together
 * from its SSE or NDJSON events), the token usage, a cost estimate and a prompt-cache hint. A small adapter per provider and a
 * tolerant parse: a field that is not where we expect it is left out, never an error. Pure, bounded, and everything it returns is
 * scrubbed of API keys and tokens (`scrubSecrets`), so a prompt that pastes a key does not show it.
 */
import { headerOf } from './debugger-inspect.js';
import { formatUsd } from './format.js';
import { aiCostOf, scrubSecrets, scrubValue, type AiCost, type AiUsage } from './ai-pricing.js';

export type AiProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'mcp';
export const AI_PROVIDER_NAME: Record<AiProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', ollama: 'Ollama', mcp: 'MCP' };

export interface AiToolCall {
  name: string;
  arguments?: unknown;
}
export interface AiMessage {
  role: string;
  text: string;
  toolCalls?: AiToolCall[];
}
export interface McpCall {
  method: string;
  /** For tools/call, resources/read and prompts/get: the tool, resource or prompt. */
  name?: string;
  arguments?: unknown;
  /** What came back, shortened. */
  result?: string;
  isError?: boolean;
  error?: string;
  /** For tools/list: the tool names. For initialize: the server. */
  tools?: string[];
  server?: string;
}

export interface AiCall {
  provider: AiProvider;
  /** chat, responses, completion, embeddings or generate; for MCP: mcp. */
  endpoint: string;
  model?: string;
  stream: boolean;
  system?: string;
  messages: AiMessage[];
  /** Names of the tools offered to the model. */
  tools: string[];
  /** The model's answer. */
  output?: { text: string; toolCalls: AiToolCall[]; stopReason?: string };
  usage?: AiUsage;
  cost?: AiCost;
  /** A sentence about the prompt cache, when there is something to say. */
  cacheHint?: string;
  /** Settings of the call: temperature, max tokens. */
  settings: Record<string, unknown>;
  /** The provider's error, from the response. */
  error?: string;
  /** MCP messages in this exchange, with their replies. */
  mcp?: McpCall[];
  /** The short text for a list column. */
  label: string;
  /** Notes about what could not be read or was shortened. */
  notes: string[];
}

export interface AiInput {
  method?: string;
  url?: string;
  host?: string;
  requestHeaders?: Record<string, string>;
  requestContentType?: string;
  requestBody?: string;
  responseBody?: string;
  status?: number;
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TEXT = 6000;
const MAX_MESSAGES = 60;
const MAX_OUTPUT = 40_000;
const short = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
const safe = (s: string, n = MAX_TEXT) => scrubSecrets(short(s, n));

/* ---------------------------------------------------------------- recognising a call */

const OPENAI_PATH = /\/(chat\/completions|responses|completions|embeddings)(?:[?#]|$)/i;
const GEMINI_PATH = /:(stream)?generateContent|:embedContent|:countTokens/i;
const OLLAMA_PATH = /\/api\/(chat|generate|embed|embeddings)(?:[?#]|$)/i;
const ANTHROPIC_PATH = /\/v1\/messages(?:\/count_tokens)?(?:[?#]|$)/i;

function providerOf(i: AiInput): AiProvider | undefined {
  const url = i.url ?? '';
  if (GEMINI_PATH.test(url)) return 'gemini';
  if (ANTHROPIC_PATH.test(url) && (/anthropic/i.test(url) || headerOf(i.requestHeaders, 'anthropic-version') !== undefined || headerOf(i.requestHeaders, 'x-api-key') !== undefined)) return 'anthropic';
  if (OLLAMA_PATH.test(url) && (/:11434\b|ollama/i.test(url) || /"model"/.test((i.requestBody ?? '').slice(0, 400)))) return 'ollama';
  if (OPENAI_PATH.test(url)) return 'openai';
  if (ANTHROPIC_PATH.test(url) && /"max_tokens"/.test(i.requestBody ?? '')) return 'anthropic';
  return undefined;
}

/** Cheap check for the list: the address or the first part of the body says it. No JSON is parsed. */
export function looksLikeAiCall(i: Pick<AiInput, 'url' | 'requestBody' | 'requestHeaders'>): boolean {
  if (providerOf(i)) return true;
  const b = i.requestBody;
  return !!b && b.length < MAX_BODY && /"jsonrpc"\s*:\s*"2\.0"/.test(b.slice(0, 400)) && /"method"\s*:\s*"(initialize|tools\/|resources\/|prompts\/|notifications\/|sampling\/|ping)/.test(b.slice(0, 2000));
}

/* ---------------------------------------------------------------- the response as events */

/** The JSON values of a response body: one object, a JSON array, SSE `data:` events, or NDJSON lines. */
function chunksOf(body: string | undefined): { chunks: unknown[]; streamed: boolean; events: string[] } {
  const none = { chunks: [] as unknown[], streamed: false, events: [] as string[] };
  if (!body || body.length > MAX_BODY) return none;
  const t = body.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const v = JSON.parse(t) as unknown;
      return { chunks: Array.isArray(v) && !isRpcBatch(v) ? v : [v], streamed: Array.isArray(v) && !isRpcBatch(v), events: [] };
    } catch {
      /* NDJSON next */
    }
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    const out: unknown[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* a cut-off last line */
      }
    }
    return { chunks: out, streamed: out.length > 1, events: [] };
  }
  if (/^(event|data|id|retry|:)/m.test(t.slice(0, 200))) {
    const chunks: unknown[] = [];
    const events: string[] = [];
    let event: string | undefined;
    for (const line of t.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const v = JSON.parse(d) as unknown;
          // a few providers put the event name only in the `event:` line
          if (event && obj(v) && obj(v)!.type === undefined) obj(v)!.type = event;
          chunks.push(v);
          events.push(event ?? str(obj(v)?.type) ?? 'data');
        } catch {
          /* not JSON */
        }
      } else if (!line.trim()) event = undefined;
    }
    return { chunks, streamed: true, events };
  }
  return none;
}
const isRpcBatch = (a: unknown[]) => a.length > 0 && a.every((x) => obj(x)?.jsonrpc === '2.0');

/* ---------------------------------------------------------------- requests, per provider */

const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  return arr(c)
    .map((p) => {
      const o = obj(p);
      if (!o) return typeof p === 'string' ? p : '';
      if (typeof o.text === 'string') return o.text;
      const t = str(o.type);
      if (t === 'tool_use') return `[tool call ${str(o.name) ?? ''}]`;
      if (t === 'tool_result') return `[tool result] ${textOf(o.content)}`;
      if (t === 'thinking') return '';
      if (o.functionCall) return `[tool call ${str(obj(o.functionCall)?.name) ?? ''}]`;
      if (o.functionResponse) return `[tool result ${str(obj(o.functionResponse)?.name) ?? ''}]`;
      if (t && /image|audio|file|input_image|input_audio|document/.test(t)) return `[${t.replace(/^input_/, '')}]`;
      if (o.inlineData || o.fileData) return '[file]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

const callsOfBlocks = (c: unknown): AiToolCall[] =>
  arr(c).flatMap((p) => {
    const o = obj(p);
    if (!o) return [];
    if (o.type === 'tool_use' && str(o.name)) return [{ name: o.name as string, arguments: scrubValue(o.input) }];
    if (obj(o.functionCall)?.name) return [{ name: obj(o.functionCall)!.name as string, arguments: scrubValue(obj(o.functionCall)!.args) }];
    return [];
  });

const parseArgs = (a: unknown): unknown => {
  if (typeof a !== 'string') return scrubValue(a);
  try {
    return scrubValue(JSON.parse(a));
  } catch {
    return safe(a, 1000);
  }
};

interface Request {
  model?: string;
  stream: boolean;
  system?: string;
  messages: AiMessage[];
  tools: string[];
  settings: Record<string, unknown>;
  endpoint: string;
  cached: boolean;
  promptChars: number;
}

function requestOf(provider: Exclude<AiProvider, 'mcp'>, url: string, body: Obj): Request {
  const settings: Record<string, unknown> = {};
  for (const k of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'reasoning_effort', 'tool_choice', 'seed']) if (body[k] !== undefined) settings[k] = body[k];
  const gen = obj(body.generationConfig) ?? obj(body.options);
  if (gen) for (const k of ['temperature', 'topP', 'maxOutputTokens', 'num_predict', 'top_p']) if (gen[k] !== undefined) settings[k] = gen[k];
  const messages: AiMessage[] = [];
  let system: string | undefined;
  let endpoint = 'chat';
  let model = str(body.model);
  let tools: string[] = [];
  const push = (role: string, content: unknown, calls?: AiToolCall[]) => {
    if (messages.length < MAX_MESSAGES) messages.push({ role, text: safe(textOf(content)), ...(calls?.length ? { toolCalls: calls } : {}) });
  };
  if (provider === 'openai') {
    endpoint = /embeddings/.test(url) ? 'embeddings' : /\/responses/.test(url) ? 'responses' : /\/chat\//.test(url) ? 'chat' : 'completion';
    if (typeof body.instructions === 'string') system = safe(body.instructions);
    const input = endpoint === 'responses' ? body.input : endpoint === 'embeddings' ? body.input : (body.messages ?? body.prompt);
    if (typeof input === 'string') push('user', input);
    else
      for (const m of arr(input)) {
        const o = obj(m);
        if (!o) {
          if (typeof m === 'string') push(endpoint === 'embeddings' ? 'input' : 'user', m);
          continue;
        }
        const role = str(o.role) ?? str(o.type) ?? 'user';
        const calls = arr(o.tool_calls).flatMap((c) => (obj(obj(c)?.function)?.name ? [{ name: obj(obj(c)!.function)!.name as string, arguments: parseArgs(obj(obj(c)!.function)!.arguments) }] : []));
        if (o.type === 'function_call') push('assistant', '', [{ name: str(o.name) ?? '?', arguments: parseArgs(o.arguments) }]);
        else if (o.type === 'function_call_output') push('tool', o.output);
        else if (role === 'system' || role === 'developer') system = system ? `${system}\n${safe(textOf(o.content))}` : safe(textOf(o.content));
        else push(role, o.content ?? o.text, calls);
      }
    tools = arr(body.tools).flatMap((t) => {
      const n = str(obj(obj(t)?.function)?.name) ?? str(obj(t)?.name) ?? str(obj(t)?.type);
      return n ? [n] : [];
    });
  } else if (provider === 'anthropic') {
    const sys = body.system;
    if (sys !== undefined) system = safe(textOf(sys));
    for (const m of arr(body.messages)) {
      const o = obj(m);
      if (o) push(str(o.role) ?? 'user', o.content, callsOfBlocks(o.content));
    }
    tools = arr(body.tools).flatMap((t) => (str(obj(t)?.name) ? [obj(t)!.name as string] : []));
  } else if (provider === 'gemini') {
    model = model ?? /models\/([^/:?]+)/.exec(url)?.[1];
    if (body.systemInstruction ?? body.system_instruction) system = safe(textOf(obj(body.systemInstruction ?? body.system_instruction)?.parts));
    if (/embedContent/.test(url)) endpoint = 'embeddings';
    for (const c of arr(body.contents)) {
      const o = obj(c);
      if (o) push(str(o.role) ?? 'user', o.parts, callsOfBlocks(o.parts));
    }
    if (body.content) push('input', obj(body.content)?.parts);
    tools = arr(body.tools).flatMap((t) => arr(obj(t)?.functionDeclarations ?? obj(t)?.function_declarations).flatMap((f) => (str(obj(f)?.name) ? [obj(f)!.name as string] : [])));
  } else {
    endpoint = /generate/.test(url) ? 'generate' : /embed/.test(url) ? 'embeddings' : 'chat';
    if (typeof body.system === 'string') system = safe(body.system);
    if (typeof body.prompt === 'string') push('user', body.prompt);
    if (typeof body.input === 'string') push('input', body.input);
    for (const m of arr(body.messages)) {
      const o = obj(m);
      if (!o) continue;
      const calls = arr(o.tool_calls).flatMap((c) => (obj(obj(c)?.function)?.name ? [{ name: obj(obj(c)!.function)!.name as string, arguments: scrubValue(obj(obj(c)!.function)!.arguments) }] : []));
      push(str(o.role) ?? 'user', o.content, calls);
    }
    tools = arr(body.tools).flatMap((t) => (str(obj(obj(t)?.function)?.name) ? [obj(obj(t)!.function)!.name as string] : []));
  }
  // chars of everything sent, for the cache hint (no tokenizer here)
  const promptChars = (system?.length ?? 0) + messages.reduce((n, m) => n + m.text.length, 0);
  const streamDefault = provider === 'ollama' && endpoint !== 'embeddings';
  const stream = body.stream === undefined ? streamDefault || /streamGenerateContent/.test(url) : body.stream === true;
  return { model, stream, system, messages, tools, settings, endpoint, cached: /"cache_control"|cachedContent|"prompt_cache_key"/.test(JSON.stringify(body).slice(0, 200_000)), promptChars };
}

/* ---------------------------------------------------------------- the answer, per provider */

interface Answer {
  text: string;
  toolCalls: AiToolCall[];
  stopReason?: string;
  model?: string;
  usage?: AiUsage;
  error?: string;
}

function usageOf(provider: AiProvider, u: Obj | undefined): AiUsage | undefined {
  if (!u) return undefined;
  const out: AiUsage = {};
  const set = (k: keyof AiUsage, v: unknown) => {
    const n = num(v);
    if (n !== undefined) out[k] = n;
  };
  if (provider === 'gemini') {
    set('inputTokens', u.promptTokenCount);
    set('outputTokens', u.candidatesTokenCount);
    set('totalTokens', u.totalTokenCount);
    set('cachedInputTokens', u.cachedContentTokenCount);
    set('reasoningTokens', u.thoughtsTokenCount);
  } else if (provider === 'ollama') {
    set('inputTokens', u.prompt_eval_count);
    set('outputTokens', u.eval_count);
  } else {
    set('inputTokens', u.prompt_tokens ?? u.input_tokens);
    set('outputTokens', u.completion_tokens ?? u.output_tokens);
    set('totalTokens', u.total_tokens);
    set('cachedInputTokens', obj(u.prompt_tokens_details)?.cached_tokens ?? obj(u.input_tokens_details)?.cached_tokens ?? u.cache_read_input_tokens);
    set('cacheWriteTokens', u.cache_creation_input_tokens);
    set('reasoningTokens', obj(u.completion_tokens_details)?.reasoning_tokens ?? obj(u.output_tokens_details)?.reasoning_tokens);
  }
  if (out.totalTokens === undefined && (out.inputTokens !== undefined || out.outputTokens !== undefined)) out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0) + (provider === 'anthropic' ? (out.cachedInputTokens ?? 0) + (out.cacheWriteTokens ?? 0) : 0);
  return Object.keys(out).length ? out : undefined;
}

/** The answer put together from the response's JSON values: whole responses and streamed deltas are both read. */
function answerOf(provider: Exclude<AiProvider, 'mcp'>, chunks: unknown[]): Answer {
  const a: Answer = { text: '', toolCalls: [] };
  const partial = new Map<string, { name: string; args: string }>(); // bounded: one entry per tool call of one response
  let usage: Obj | undefined;
  const addCall = (key: string, name?: string, args?: string) => {
    const p = partial.get(key) ?? { name: '', args: '' };
    if (name) p.name = name;
    if (args) p.args += args;
    partial.set(key, p);
  };
  for (const c of chunks.slice(0, 20_000)) {
    const o = obj(c);
    if (!o) continue;
    const err = obj(o.error) ?? (typeof o.error === 'string' ? { message: o.error } : undefined);
    if (err && !a.error) a.error = safe(str(err.message) ?? JSON.stringify(err), 500);
    a.model = str(o.model) ?? str(obj(o.message)?.model) ?? str(o.modelVersion) ?? a.model;
    if (provider === 'openai') {
      if (o.type === 'response.output_text.delta' && typeof o.delta === 'string') a.text += o.delta;
      else if (o.type === 'response.completed' || o.type === 'response.incomplete') {
        const r = obj(o.response);
        a.model = str(r?.model) ?? a.model;
        usage = obj(r?.usage) ?? usage;
        if (!a.text) fromResponsesOutput(a, r?.output);
        a.stopReason = str(r?.status) ?? a.stopReason;
      } else if (Array.isArray(o.output) && !o.type?.toString().startsWith('response.')) {
        fromResponsesOutput(a, o.output);
        a.stopReason = str(o.status) ?? a.stopReason;
      }
      for (const ch of arr(o.choices)) {
        const co = obj(ch);
        if (!co) continue;
        const m = obj(co.delta) ?? obj(co.message);
        if (typeof m?.content === 'string') a.text += m.content;
        else if (Array.isArray(m?.content)) a.text += textOf(m!.content);
        if (typeof co.text === 'string') a.text += co.text;
        for (const t of arr(m?.tool_calls)) {
          const to = obj(t);
          const f = obj(to?.function);
          if (to) addCall(String(to.index ?? to.id ?? partial.size), str(f?.name), str(f?.arguments));
        }
        a.stopReason = str(co.finish_reason) ?? a.stopReason;
      }
      usage = obj(o.usage) ?? usage;
    } else if (provider === 'anthropic') {
      const t = str(o.type);
      if (t === 'message_start') {
        a.model = str(obj(o.message)?.model) ?? a.model;
        usage = { ...obj(obj(o.message)?.usage) };
      } else if (t === 'content_block_start') {
        const b = obj(o.content_block);
        if (b?.type === 'tool_use' || b?.type === 'server_tool_use') addCall(String(o.index), str(b.name));
        else if (b?.type === 'text' && typeof b.text === 'string') a.text += b.text;
      } else if (t === 'content_block_delta') {
        const d = obj(o.delta);
        if (d?.type === 'text_delta' && typeof d.text === 'string') a.text += d.text;
        else if (d?.type === 'input_json_delta') addCall(String(o.index), undefined, str(d.partial_json));
      } else if (t === 'message_delta') {
        a.stopReason = str(obj(o.delta)?.stop_reason) ?? a.stopReason;
        usage = { ...usage, ...obj(o.usage) };
      } else if (t === 'message' || Array.isArray(o.content)) {
        a.text += textOf((o.content as unknown[]).filter((b) => obj(b)?.type === 'text'));
        a.toolCalls.push(...callsOfBlocks(o.content));
        a.stopReason = str(o.stop_reason) ?? a.stopReason;
        usage = obj(o.usage) ?? usage;
      } else if (t === 'error') a.error = safe(str(obj(o.error)?.message) ?? 'error event', 500);
    } else if (provider === 'gemini') {
      for (const cand of arr(o.candidates)) {
        const co = obj(cand);
        const parts = arr(obj(co?.content)?.parts);
        a.text += textOf(parts.filter((p) => typeof obj(p)?.text === 'string' && !obj(p)?.thought));
        a.toolCalls.push(...callsOfBlocks(parts));
        a.stopReason = str(co?.finishReason) ?? a.stopReason;
      }
      const emb = arr(obj(o.embedding)?.values);
      if (emb.length) a.text = `an embedding of ${emb.length} numbers`;
      if (o.usageMetadata) usage = obj(o.usageMetadata);
    } else {
      const m = obj(o.message);
      if (typeof m?.content === 'string') a.text += m.content;
      if (typeof o.response === 'string') a.text += o.response;
      for (const t of arr(m?.tool_calls)) {
        const f = obj(obj(t)?.function);
        if (f?.name) a.toolCalls.push({ name: f.name as string, arguments: scrubValue(f.arguments) });
      }
      if (o.done === true) {
        a.stopReason = str(o.done_reason) ?? 'stop';
        usage = { prompt_eval_count: o.prompt_eval_count, eval_count: o.eval_count };
      }
      if (Array.isArray(o.embeddings)) a.text = `${o.embeddings.length} embedding(s)`;
    }
  }
  for (const p of partial.values()) if (p.name) a.toolCalls.push({ name: p.name, arguments: parseArgs(p.args || undefined) });
  a.text = safe(a.text, MAX_OUTPUT);
  a.usage = usageOf(provider, usage);
  return a;
}

function fromResponsesOutput(a: Answer, output: unknown): void {
  for (const it of arr(output)) {
    const o = obj(it);
    if (o?.type === 'message') a.text += textOf(o.content);
    else if (o?.type === 'function_call' && str(o.name)) a.toolCalls.push({ name: o.name as string, arguments: parseArgs(o.arguments) });
  }
}

/* ---------------------------------------------------------------- MCP */

const rpcId = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

function mcpOf(i: AiInput): McpCall[] | undefined {
  const req = chunksOf(i.requestBody).chunks.flatMap((c) => (isRpcBatch(arr(c)) || Array.isArray(c) ? (c as unknown[]) : [c]));
  const calls = req.map(obj).filter((o): o is Obj => !!o && typeof o.method === 'string');
  if (!calls.length) return undefined;
  const replies = new Map<string, Obj>(); // bounded: one entry per message of one response
  for (const c of chunksOf(i.responseBody).chunks.flatMap((c) => (Array.isArray(c) ? c : [c]))) {
    const o = obj(c);
    const id = rpcId(o?.id);
    if (o && id !== undefined && (o.result !== undefined || o.error !== undefined)) replies.set(id, o);
  }
  return calls.slice(0, 100).map((c): McpCall => {
    const method = c.method as string;
    const p = obj(c.params);
    const out: McpCall = { method };
    if (method === 'tools/call' || method === 'prompts/get') out.name = str(p?.name);
    else if (method === 'resources/read') out.name = str(p?.uri);
    if (p?.arguments !== undefined) out.arguments = scrubValue(p.arguments);
    const r = replies.get(rpcId(c.id) ?? '\0');
    if (r?.error) out.error = safe(str(obj(r.error)?.message) ?? JSON.stringify(r.error), 500);
    else if (r) {
      const res = obj(r.result);
      if (method === 'tools/list') out.tools = arr(res?.tools).flatMap((t) => (str(obj(t)?.name) ? [obj(t)!.name as string] : []));
      else if (method === 'initialize') out.server = [str(obj(res?.serverInfo)?.name), str(obj(res?.serverInfo)?.version)].filter(Boolean).join(' ') || undefined;
      else {
        out.isError = res?.isError === true || undefined;
        const text = textOf(res?.content ?? res?.contents ?? res?.messages);
        if (text) out.result = safe(text, 2000);
      }
    }
    return out;
  });
}

/* ---------------------------------------------------------------- the whole call */

function parseJson(s: string | undefined): Obj | undefined {
  if (!s || s.length > MAX_BODY) return undefined;
  try {
    return obj(JSON.parse(s));
  } catch {
    return undefined;
  }
}

const tokensText = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The AI call in an exchange, or undefined when it is not one (or the body cannot be read). */
export function aiCallOf(i: AiInput): AiCall | undefined {
  const provider = providerOf(i);
  if (provider) {
    const body = parseJson(i.requestBody);
    if (!body) return undefined;
    const rq = requestOf(provider as Exclude<AiProvider, 'mcp'>, i.url ?? '', body);
    const rs = chunksOf(i.responseBody);
    const ans = rs.chunks.length ? answerOf(provider as Exclude<AiProvider, 'mcp'>, rs.chunks) : undefined;
    const model = ans?.model ?? rq.model;
    const notes: string[] = [];
    if (i.responseBody === undefined) notes.push('The response was not kept, so there is no answer, usage or cost.');
    else if (!rs.chunks.length) notes.push('The response body is not JSON or an event stream, so the answer could not be read.');
    if (rq.messages.length >= MAX_MESSAGES) notes.push(`Only the first ${MAX_MESSAGES} messages are shown.`);
    const usage = ans?.usage;
    const call: AiCall = {
      provider,
      endpoint: rq.endpoint,
      ...(model ? { model } : {}),
      stream: rs.streamed || rq.stream,
      ...(rq.system ? { system: rq.system } : {}),
      messages: rq.messages,
      tools: rq.tools.slice(0, 200),
      settings: rq.settings,
      label: `${AI_PROVIDER_NAME[provider]}${model ? ` ${model}` : ''}`,
      notes,
    };
    if (ans) {
      call.output = { text: ans.text, toolCalls: ans.toolCalls, ...(ans.stopReason ? { stopReason: ans.stopReason } : {}) };
      if (ans.error) call.error = ans.error;
    }
    if (usage) {
      call.usage = usage;
      const cost = aiCostOf(provider, model, usage);
      if (cost) call.cost = cost;
      call.cacheHint = cacheHint(provider, usage, rq);
    }
    if (!call.error && (i.status ?? 200) >= 400 && i.responseBody) call.error = safe(str(obj(parseJson(i.responseBody)?.error)?.message) ?? `HTTP ${i.status}`, 500);
    if (!call.cacheHint) delete call.cacheHint;
    return call;
  }
  if (!looksLikeAiCall(i)) return undefined;
  const mcp = mcpOf(i);
  if (!mcp) return undefined;
  const named = mcp.filter((c) => c.method === 'tools/call');
  const first = mcp[0]!;
  return {
    provider: 'mcp',
    endpoint: 'mcp',
    stream: /^(event|data):/m.test((i.responseBody ?? '').slice(0, 100)),
    messages: [],
    tools: named.flatMap((c) => (c.name ? [c.name] : [])),
    settings: {},
    mcp,
    label: mcp.length === 1 ? `MCP ${first.method}${first.name ? ` ${first.name}` : ''}` : `MCP ${mcp.length} messages${named.length ? ` (${named.length} tool call${named.length === 1 ? '' : 's'})` : ''}`,
    notes: [],
  };
}

function cacheHint(provider: AiProvider, u: AiUsage, rq: Request): string | undefined {
  const read = u.cachedInputTokens ?? 0;
  if (read > 0) {
    const of = u.inputTokens !== undefined ? ` of ${tokensText(provider === 'anthropic' ? u.inputTokens + read + (u.cacheWriteTokens ?? 0) : u.inputTokens)} input tokens` : '';
    return `${tokensText(read)}${of} came from the prompt cache (billed at a lower rate).`;
  }
  if ((u.cacheWriteTokens ?? 0) > 0) return `${tokensText(u.cacheWriteTokens!)} tokens were written to the prompt cache: the next call with the same start can read them.`;
  // about 4 characters a token; caches start at roughly 1,024 tokens
  if (rq.promptChars > 4500 && !rq.cached) return provider === 'anthropic' ? 'A long prompt and nothing was cached: marking the stable start with cache_control would make repeat calls cheaper.' : 'A long prompt and nothing came from the cache: keep the stable part (instructions, tools) first so repeat calls can reuse it.';
  return undefined;
}

/**
 * The short text for the grid: `OpenAI gpt-4o`, `MCP tools/call get_weather`; undefined when the exchange is not AI traffic. Cheap: the
 * provider comes from the address and the model from a pattern over the start of the body, so a megabyte prompt is not parsed per row.
 */
export function aiLabelOf(i: AiInput): string | undefined {
  const provider = providerOf(i);
  if (provider) {
    const model = /models\/([^/:?]+)/.exec(i.url ?? '')?.[1] ?? /"model"\s*:\s*"([^"]{1,80})"/.exec((i.requestBody ?? '').slice(0, 20_000))?.[1];
    return `${AI_PROVIDER_NAME[provider]}${model ? ` ${model}` : ''}`;
  }
  if (!looksLikeAiCall(i)) return undefined;
  return (i.requestBody?.length ?? 0) < 50_000 ? aiCallOf({ ...i, responseBody: undefined })?.label : 'MCP';
}

/** The call as text a person or a model reads. */
export function aiCallText(c: AiCall): string {
  const lines: string[] = [c.label + (c.stream ? ' (streamed)' : '')];
  if (c.usage) lines.push(`Tokens: ${c.usage.inputTokens ?? '?'} in, ${c.usage.outputTokens ?? '?'} out${c.usage.cachedInputTokens ? `, ${c.usage.cachedInputTokens} cached` : ''}${c.cost ? `; ${c.cost.usd === 0 ? 'free' : `about ${formatUsd(c.cost.usd)}`} (estimate)` : ''}`);
  if (c.cacheHint) lines.push(`Cache: ${c.cacheHint}`);
  if (c.system) lines.push(`System: ${c.system}`);
  for (const m of c.messages) lines.push(`${m.role}: ${m.text}${m.toolCalls?.length ? ` -> ${m.toolCalls.map((t) => t.name).join(', ')}` : ''}`);
  if (c.tools.length) lines.push(`Tools: ${c.tools.join(', ')}`);
  if (c.output) lines.push(`Answer${c.output.stopReason ? ` (${c.output.stopReason})` : ''}: ${c.output.text}${c.output.toolCalls.length ? `\nTool calls: ${c.output.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join('; ')}` : ''}`);
  for (const m of c.mcp ?? []) lines.push(`${m.method}${m.name ? ` ${m.name}` : ''}${m.arguments !== undefined ? ` ${JSON.stringify(m.arguments)}` : ''}${m.tools ? ` -> ${m.tools.join(', ')}` : ''}${m.server ? ` -> ${m.server}` : ''}${m.error ? ` -> error: ${m.error}` : m.result ? ` -> ${m.isError ? 'tool error: ' : ''}${m.result}` : ''}`);
  if (c.error) lines.push(`Error: ${c.error}`);
  lines.push(...c.notes);
  return lines.join('\n');
}
