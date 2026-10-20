/**
 * RAG testing, the parts every host shares (planning/rag-testing.md): the target (a request to any protocol plus the
 * mapping that reads an answer and its retrieved contexts out of the response) and the helpers the window's click-to-map
 * uses. Browser-safe data and string functions only; the mapping is applied by the engine (core eval/rag/mapping.ts).
 */

/** How the fields of ONE retrieved context are found, as JSONPath relative to the context item (`$` is the item itself). */
export interface RagFieldPaths {
  text?: string;
  id?: string;
  score?: string;
  source?: string;
}

/**
 * How to read a RAG sample out of the response of a target: JSONPath into the response document. Deterministic: the
 * same response always gives the same sample. Special paths: `$text` is the response text.
 */
export interface RagMapping {
  /** Where the answer is. A path that matches several strings (an SSE stream's deltas) is joined in order. */
  answer: string;
  /** Where the list of retrieved contexts is (`$.sources[*]` or the array itself, `$.sources`). */
  contexts?: string;
  /** Where each field of one context is, relative to the context item. */
  context?: RagFieldPaths;
  /** Token counts the system reports. */
  usage?: { input?: string; output?: string; total?: string };
  /** A latency in milliseconds the system reports; without it TestPion's own timing is used. */
  latencyMs?: string;
}

/**
 * How a target is limited, so an evaluation cannot overload the system under test: the most calls in flight, the most
 * requests per minute, the time one call may take, and how often a failed call is tried again.
 */
export interface RagLimits {
  concurrency?: number;
  requestsPerMinute?: number;
  timeoutMs?: number;
  retries?: number;
}

/**
 * The judge of an evaluation's judged metrics. `provider` / `model` is the single judge (unset: the AI settings' large
 * model; never a silent mock); the other fields are the options of the judge panel (planning/rag-testing.md §4c).
 */
export interface RagJudgeSetup {
  provider?: string;
  model?: string;
  /** Stop judging once the run has spent this much (USD, from the price table) or made this many model calls. */
  maxCostUsd?: number;
  maxCalls?: number;
  /** A jury: each of these judges the sample, and `aggregate` combines their scores (default majority). */
  judges?: Array<{ provider?: string; model?: string }>;
  aggregate?: 'majority' | 'mean' | 'min';
  /** Judge twice with the documents in the opposite order; when the two disagree on pass or fail the sample is a tie (not passed). */
  swap?: boolean;
  /** Judge n times with the cache bypassed: the score is the mean and the result reports the flip rate. */
  repeat?: number;
  /** Skip the judged answer metrics of a sample whose free retrieval metrics already failed. */
  shortCircuit?: boolean;
  /**
   * Split the answer into claims once (the shared `claims-v1` pass) and let faithfulness and answer-relevance judge those.
   * Default: only when three or more metrics read the claims, because with two the extra call costs more than it saves.
   */
  shareClaims?: boolean;
}

export type RagProtocol = 'http' | 'sse' | 'websocket' | 'grpc' | 'mcp';

export const RAG_PROTOCOLS: ReadonlyArray<{ id: RagProtocol; label: string }> = [
  { id: 'http', label: 'HTTP (JSON request and response)' },
  { id: 'sse', label: 'HTTP, streamed with server-sent events' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'grpc', label: 'gRPC' },
  { id: 'mcp', label: 'MCP tool' },
];

/**
 * A RAG system under test (a workspace item of `library/rag-targets.json`): one request of any protocol, written as a
 * step of a test file, and the mapping of its response. The question is `{{question}}` in the step (`{{questionJson}}`
 * is the same as a JSON string literal, `{{questionEscaped}}` is it escaped for the inside of one).
 */
export interface RagTarget {
  protocol: RagProtocol;
  /** The request, as a step of a test file (type http | websocket | grpc | mcp and its fields). */
  step: Record<string, unknown>;
  mapping: RagMapping;
  description?: string;
  /** The endpoint only answers questions and changes nothing: a production environment may call it without asking. */
  readOnly?: boolean;
  timeoutMs?: number;
  /** Concurrency, rate and retries of the calls an evaluation makes to it. */
  limits?: RagLimits;
}

/** One retrieved context as the metrics read it. */
export interface RagDoc {
  id: string;
  text: string;
  score?: number;
  source?: string;
}

/** What a target's response was read as. */
export interface RagSample {
  answer: string;
  contexts: RagDoc[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs?: number;
  /** What the mapping could not find (a path that matched nothing): shown with the sample. */
  warnings: string[];
}

/** The place in the mapping a clicked value is assigned to (the window's click-to-map menu). */
export type RagMapSlot = 'answer' | 'answer.pieces' | 'contexts' | 'context.text' | 'context.id' | 'context.score' | 'context.source' | 'usage.input' | 'usage.output' | 'usage.total' | 'latencyMs';

export const RAG_MAP_SLOTS: ReadonlyArray<{ slot: RagMapSlot; label: string; item?: true }> = [
  { slot: 'answer', label: 'The answer' },
  { slot: 'answer.pieces', label: 'The answer, streamed in pieces (join this field of every event)' },
  { slot: 'contexts', label: 'The list of retrieved contexts' },
  { slot: 'context.text', label: 'Context text', item: true },
  { slot: 'context.id', label: 'Context id', item: true },
  { slot: 'context.score', label: 'Context score', item: true },
  { slot: 'context.source', label: 'Context source', item: true },
  { slot: 'usage.input', label: 'Input tokens' },
  { slot: 'usage.output', label: 'Output tokens' },
  { slot: 'usage.total', label: 'Total tokens' },
  { slot: 'latencyMs', label: 'Latency (ms)' },
];

/** `$.sources[2].meta.id` → `$.sources[*].meta.id`: the same place in every item of a list. */
export const wildcardPath = (path: string) => path.replace(/\[\d+\]/g, '[*]');

/** The path of the list itself without its trailing wildcard: `$.sources[*]` → `$.sources`. */
const listBase = (listPath: string) => wildcardPath(listPath).replace(/\[\*\]$/, '');

/**
 * The path of a clicked value relative to the items of the list at `listPath`, or undefined when it is not inside one:
 * `relativeToList('$.sources[*]', '$.sources[3].meta.id')` → `$.meta.id`.
 */
export function relativeToList(listPath: string, clicked: string): string | undefined {
  const base = listBase(listPath);
  const c = wildcardPath(clicked);
  if (!c.startsWith(`${base}[*]`)) return undefined;
  const rest = c.slice(base.length + 3);
  return rest ? `$${rest}` : '$';
}

/** The mapping with a clicked value assigned to a slot. An item field outside the contexts list is refused with the reason. */
export function assignSlot(m: RagMapping, slot: RagMapSlot, clicked: string): { mapping: RagMapping } | { problem: string } {
  const path = clicked.trim();
  if (slot === 'answer') return { mapping: { ...m, answer: path } };
  if (slot === 'answer.pieces') return { mapping: { ...m, answer: wildcardPath(path) } };
  if (slot === 'contexts') {
    const list = wildcardPath(path);
    return { mapping: { ...m, contexts: list.endsWith('[*]') ? list : `${list}[*]` } };
  }
  if (slot === 'latencyMs') return { mapping: { ...m, latencyMs: path } };
  if (slot.startsWith('usage.')) return { mapping: { ...m, usage: { ...m.usage, [slot.slice(6)]: path } } };
  if (!m.contexts) return { problem: 'Choose the list of retrieved contexts first (click the list, then "The list of retrieved contexts"), then click a field inside one item.' };
  const rel = relativeToList(m.contexts, path);
  if (rel === undefined) return { problem: `That value is not inside the list ${m.contexts}. Click a field of one of the list's items.` };
  return { mapping: { ...m, context: { ...m.context, [slot.slice(8)]: rel } } };
}

/** A mapping with nothing assigned yet. */
export const emptyMapping = (): RagMapping => ({ answer: '' });

/** Starting steps for the protocols (the Connect dialog's templates): the question is `{{question}}`. */
export function ragStepTemplate(protocol: RagProtocol): string {
  switch (protocol) {
    case 'http':
      return `type: http
method: POST
url: "{{ragUrl}}/query"
headers:
  Content-Type: application/json
  # Authorization: "Bearer {{ragToken}}"
json:
  question: "{{question}}"
`;
    case 'sse':
      return `type: http
method: POST
url: "{{ragUrl}}/stream"
headers:
  Content-Type: application/json
  Accept: text/event-stream
json:
  question: "{{question}}"
`;
    case 'websocket':
      return `type: websocket
url: "{{ragUrl}}/ws"
waitMs: 3000
send:
  - { question: "{{question}}" }
`;
    case 'grpc':
      return `type: grpc
target: "localhost:50051"
method: rag.Rag/Ask
protos: [protos/rag.proto]
message: { question: "{{question}}" }
`;
    case 'mcp':
      return `type: mcp
server: my-rag-server
tool: search
arguments: { query: "{{question}}" }
`;
  }
}

/**
 * A metric name in the one form names are compared in: `LLMContextRecall` and `context_recall` and "Context Recall" are
 * `llm-context-recall` / `context-recall` (case ignored, CamelCase split, `_` and spaces become `-`). The engine's
 * registry and the window's picker both use it, so a name found in one is found in the other.
 */
export function normalizeMetricName(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}
