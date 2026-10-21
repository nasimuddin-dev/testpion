/**
 * Reading a RAG sample out of a target's response (planning/rag-testing.md §4a): the mapping is JSONPath into the
 * response document, so the same response always gives the same sample. The document is what a check of that step would
 * see: the parsed JSON body; for a server-sent event stream `{ events: [{ event, id, data }] }` with each event's data
 * parsed as JSON when it is JSON; for a WebSocket `{ connected, received, messages }`; the response text otherwise.
 */
import type { RagDoc, RagMapping, RagSample, RagToolCallRef } from '@testpion/shared';
import { queryAll } from '../../util/jsonpath.js';
import { SseParser } from '../../protocols/http/sse.js';

/** What the mapping reads: the document, and the plain text of the response (`$text`). */
export interface RagResponse {
  doc: unknown;
  text: string;
  kind: 'json' | 'sse' | 'text';
}

const isEventStream = (headers?: Array<[string, string]>) => !!headers?.some(([k, v]) => k.toLowerCase() === 'content-type' && /text\/event-stream/i.test(v));

const asData = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** The response document of a step's result (see the module comment). */
export function responseOf(r: { body: unknown; text: string; headers?: Array<[string, string]> }): RagResponse {
  if (isEventStream(r.headers)) {
    const parser = new SseParser();
    // a stream that ends without its last blank line still ends its last event
    const events = parser.push(`${r.text.replace(/\r?\n$/, '')}\n\n`, 0).map((e) => ({ event: e.event, ...(e.id !== undefined ? { id: e.id } : {}), data: asData(e.data) }));
    if (events.length) return { doc: { events }, text: r.text, kind: 'sse' };
  }
  if (r.body !== null && typeof r.body === 'object') return { doc: r.body, text: r.text, kind: 'json' };
  return { doc: { text: r.text }, text: r.text, kind: 'text' };
}

const MAX_DOCS = 100;
const MAX_DOC_CHARS = 32_000;

const textOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined || v === null) return undefined;
  return JSON.stringify(v);
};

const numberOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** The values a path selects ($text is the response text). */
function select(r: RagResponse, path: string): unknown[] {
  const p = path.trim();
  if (p === '$text') return [r.text];
  return queryAll(r.doc, p);
}

const firstOf = (v: unknown[]) => (v.length ? v[0] : undefined);

/** The names an unmapped context field is looked up under (a mapping that names a path never uses these). */
const GUESS = {
  text: ['text', 'content', 'page_content', 'pageContent', 'chunk', 'passage', 'snippet', 'body'],
  id: ['id', 'doc_id', 'docId', 'document_id', 'documentId', '_id', 'source_id'],
  score: ['score', 'relevance', 'similarity'],
  source: ['source', 'url', 'file', 'filename', 'title'],
  image: ['image', 'image_url', 'imageUrl', 'image_data', 'image_base64', 'img'],
} as const;

/** The names a tool call's fields are looked up under when the mapping names no path (OpenAI, Anthropic, LangChain and MCP spellings). */
const TOOL_GUESS = { name: ['name', 'tool', 'tool_name', 'toolName', 'function.name', 'action'], arguments: ['arguments', 'args', 'input', 'tool_input', 'toolInput', 'function.arguments', 'parameters'] } as const;

const dotted = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);

/** The tool calls the mapping points at; an argument string holding JSON (OpenAI) is parsed. */
function toolCallsOf(r: RagResponse, m: RagMapping, warnings: string[]): RagToolCallRef[] | undefined {
  if (!m.toolCalls) return undefined;
  let items = select(r, m.toolCalls);
  if (items.length === 1 && Array.isArray(items[0])) items = items[0] as unknown[];
  if (!items.length) {
    warnings.push(`The tool calls path ${m.toolCalls} matched nothing (the system made no tool calls in this response).`);
    return [];
  }
  const out: RagToolCallRef[] = [];
  for (const item of items.slice(0, 100)) {
    const pick = (p: string | undefined, guess: readonly string[]): unknown => {
      if (p !== undefined && p.trim() !== '') return p.trim() === '$' ? item : firstOf(queryAll(item, p));
      for (const g of guess) {
        const v = dotted(item, g);
        if (v !== undefined && v !== null) return v;
      }
      return undefined;
    };
    const name = pick(m.toolCall?.name, TOOL_GUESS.name);
    if (typeof name !== 'string' || !name) {
      warnings.push('A tool call has no name (map the name of a tool call).');
      continue;
    }
    let args = pick(m.toolCall?.arguments, TOOL_GUESS.arguments);
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = undefined;
      }
    }
    out.push({ name, arguments: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {} });
  }
  return out;
}

function field(item: unknown, path: string | undefined, guess: readonly string[]): unknown {
  if (path !== undefined && path.trim() !== '') return path.trim() === '$' ? item : firstOf(queryAll(item, path));
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;
  for (const k of guess) if (o[k] !== undefined && o[k] !== null) return o[k];
  const meta = o.metadata;
  if (meta && typeof meta === 'object') for (const k of guess) if ((meta as Record<string, unknown>)[k] !== undefined) return (meta as Record<string, unknown>)[k];
  return undefined;
}

/** Problems that stop a mapping from being used (the Connect dialog and `testpion rag` show them). */
export function mappingProblems(m: RagMapping | undefined): string[] {
  if (!m || typeof m !== 'object') return ['The target has no mapping.'];
  const out: string[] = [];
  if (typeof m.answer !== 'string' || !m.answer.trim()) out.push('The mapping has no answer path: click the answer in the sample response and choose "The answer".');
  for (const [k, v] of Object.entries({ contexts: m.contexts, latencyMs: m.latencyMs, toolCalls: m.toolCalls, conversationId: m.conversationId, 'usage.input': m.usage?.input, 'usage.output': m.usage?.output, 'usage.total': m.usage?.total }))
    if (v !== undefined && (typeof v !== 'string' || !v.trim().startsWith('$'))) out.push(`${k} must be a JSONPath starting with $ (got ${JSON.stringify(v)}).`);
  return out;
}

/** Read the sample: the answer, the contexts, the usage and the latency the mapping points at. */
export function applyMapping(r: RagResponse, m: RagMapping): RagSample {
  const warnings: string[] = [];
  const answers = select(r, m.answer).filter((v) => v !== undefined && v !== null);
  let answer = '';
  if (!answers.length) warnings.push(`The answer path ${m.answer} matched nothing in the response.`);
  else if (answers.length === 1) answer = textOf(answers[0]) ?? '';
  // several matches (the pieces of a streamed answer): joined in order
  else answer = answers.map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')).join('');

  const contexts: RagDoc[] = [];
  if (m.contexts) {
    let items = select(r, m.contexts);
    // the path named the list itself (`$.sources`): its items
    if (items.length === 1 && Array.isArray(items[0])) items = items[0] as unknown[];
    if (!items.length) warnings.push(`The contexts path ${m.contexts} matched nothing (no retrieved contexts in this response).`);
    if (items.length > MAX_DOCS) warnings.push(`${items.length} contexts came back; the first ${MAX_DOCS} are scored.`);
    items.slice(0, MAX_DOCS).forEach((item, i) => {
      const text = textOf(field(item, m.context?.text, GUESS.text)) ?? '';
      const image = textOf(field(item, m.context?.image, m.context?.image ? [] : GUESS.image));
      if (!text && !image) warnings.push(`Context ${i + 1} has no text${m.context?.text ? ` at ${m.context.text}` : ' (map the text of a context)'}.`);
      const id = textOf(field(item, m.context?.id, GUESS.id)) ?? `doc-${i + 1}`;
      const score = numberOf(field(item, m.context?.score, GUESS.score));
      const source = textOf(field(item, m.context?.source, GUESS.source));
      const clipped = text.length > MAX_DOC_CHARS;
      if (clipped) warnings.push(`Context ${id} is ${text.length} characters; the first ${MAX_DOC_CHARS} are scored.`);
      contexts.push({ id, text: clipped ? text.slice(0, MAX_DOC_CHARS) : text, ...(score !== undefined ? { score } : {}), ...(source ? { source } : {}), ...(image ? { image } : {}) });
    });
  }

  const num = (path?: string) => (path ? numberOf(firstOf(select(r, path))) : undefined);
  const input = num(m.usage?.input);
  const output = num(m.usage?.output);
  const total = num(m.usage?.total) ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
  const usage = input !== undefined || output !== undefined || total !== undefined ? { inputTokens: input, outputTokens: output, totalTokens: total } : undefined;
  const latencyMs = num(m.latencyMs);
  const toolCalls = toolCallsOf(r, m, warnings);
  const conversationId = m.conversationId ? textOf(firstOf(select(r, m.conversationId))) : undefined;
  return { answer, contexts, ...(usage ? { usage } : {}), ...(latencyMs !== undefined ? { latencyMs } : {}), ...(toolCalls ? { toolCalls } : {}), ...(conversationId ? { conversationId } : {}), warnings };
}
