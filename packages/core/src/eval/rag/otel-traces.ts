/**
 * Traces of an AI application as dataset records (planning/ai-research-2026-11-11.md N-4): what users really asked, what
 * the system answered, what it retrieved and which tools it called, read from an OpenTelemetry export (OTLP/JSON: a file
 * with `resourceSpans`, or one such object a line). A record holds `question`, `answer`, `contexts` and `tool_calls`, so
 * it can be scored as it is (no call of the system), added to an evaluation, or used as the reference of a later run.
 *
 * The GenAI semantic conventions are still marked Development and were renamed more than once, and several SDKs write
 * their own names, so every field is read under all the spellings in use:
 *  - messages: `gen_ai.input.messages` / `gen_ai.output.messages` (JSON), the older `gen_ai.prompt` / `gen_ai.completion`
 *    (JSON, or indexed `gen_ai.prompt.0.content` …), span events (`gen_ai.user.message`, `gen_ai.choice` …), and
 *    OpenInference (`llm.input_messages.0.message.content`, `input.value`, `output.value`);
 *  - tools: spans with `gen_ai.tool.name` (operation `execute_tool`) or OpenInference `tool.name`, and tool calls inside
 *    an output message;
 *  - retrieval: OpenInference `retrieval.documents.N.document.content` (id, score).
 * Only data is read; nothing in a trace is executed. A trace without a question and an answer is skipped and counted.
 */
type Rec = Record<string, unknown>;

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: bigint;
  end: bigint;
  attrs: Rec;
  events: Array<{ name: string; attrs: Rec }>;
  error: boolean;
}

export interface TraceImport {
  records: Rec[];
  notes: string[];
  traces: number;
  skipped: number;
}

/** An OTLP attribute value (`{ stringValue }`, `{ intValue }`, `{ arrayValue }` …) as a plain value. */
function anyValue(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const o = v as Rec;
  if ('stringValue' in o) return o.stringValue;
  if ('intValue' in o) return Number(o.intValue);
  if ('doubleValue' in o) return Number(o.doubleValue);
  if ('boolValue' in o) return o.boolValue;
  if ('arrayValue' in o) return (((o.arrayValue as Rec)?.values as unknown[]) ?? []).map(anyValue);
  if ('kvlistValue' in o) return attrsOf((o.kvlistValue as Rec)?.values);
  return undefined;
}
const attrsOf = (list: unknown): Rec => (Array.isArray(list) ? Object.fromEntries(list.filter((a): a is Rec => !!a && typeof a === 'object').map((a) => [String(a.key), anyValue(a.value)])) : list && typeof list === 'object' ? (list as Rec) : {});
const nanos = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0'));
  } catch {
    return 0n;
  }
};

function spansOf(batches: Rec[]): Span[] {
  const out: Span[] = [];
  for (const b of batches)
    for (const rs of (b.resourceSpans as Rec[] | undefined) ?? [])
      for (const ss of ((rs.scopeSpans ?? rs.instrumentationLibrarySpans) as Rec[] | undefined) ?? [])
        for (const s of (ss.spans as Rec[] | undefined) ?? []) {
          if (!s.traceId || !s.spanId) continue;
          out.push({
            traceId: String(s.traceId),
            spanId: String(s.spanId),
            ...(s.parentSpanId ? { parentSpanId: String(s.parentSpanId) } : {}),
            name: String(s.name ?? ''),
            start: nanos(s.startTimeUnixNano),
            end: nanos(s.endTimeUnixNano),
            attrs: attrsOf(s.attributes),
            events: ((s.events as Rec[] | undefined) ?? []).map((e) => ({ name: String(e.name ?? ''), attrs: attrsOf(e.attributes) })),
            error: (s.status as Rec | undefined)?.code === 2 || (s.status as Rec | undefined)?.code === 'STATUS_CODE_ERROR',
          });
        }
  return out;
}

interface Msg {
  role: string;
  content: string;
  toolCalls?: Array<{ name: string; arguments: Rec }>;
}

const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
};
const argsOf = (v: unknown): Rec => {
  const p = json(v);
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Rec) : {};
};

/** The text of a message's content: a string, or the text parts of a list of parts ({ type: text, content | text }). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && ((p as Rec).type === undefined || (p as Rec).type === 'text') ? String((p as Rec).content ?? (p as Rec).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  return content === undefined || content === null ? '' : typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function msgOf(m: unknown): Msg | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = ((m as Rec).message as Rec | undefined) ?? (m as Rec);
  const parts = Array.isArray(o.parts) ? (o.parts as Rec[]) : Array.isArray(o.content) ? (o.content as Rec[]) : [];
  const calls = [
    ...((o.tool_calls ?? o.toolCalls ?? []) as Rec[]).map((c) => ({ name: String((c.function as Rec | undefined)?.name ?? c.name ?? ''), arguments: argsOf((c.function as Rec | undefined)?.arguments ?? c.arguments) })),
    ...parts.filter((p) => p && typeof p === 'object' && p.type === 'tool_call').map((p) => ({ name: String(p.name ?? ''), arguments: argsOf(p.arguments) })),
  ].filter((c) => c.name);
  const role = String(o.role ?? '').toLowerCase();
  const content = textOf(o.parts ?? o.content ?? o.text ?? '');
  if (!role && !content) return undefined;
  return { role: role === 'human' ? 'user' : role === 'ai' || role === 'model' ? 'assistant' : role || 'user', content, ...(calls.length ? { toolCalls: calls } : {}) };
}

/** Indexed attributes (`prefix.0.role`, `prefix.0.content`, `prefix.1.…`) as messages. */
function indexed(attrs: Rec, prefix: string): Msg[] {
  const rows = new Map<number, Rec>();
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith(prefix + '.')) continue;
    const m = /^(\d+)\.(.+)$/.exec(k.slice(prefix.length + 1));
    if (!m) continue;
    const row = rows.get(Number(m[1])) ?? {};
    row[m[2]!.replace(/^message\./, '')] = v;
    rows.set(Number(m[1]), row);
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => msgOf(r))
    .filter((m): m is Msg => !!m);
}

const list = (v: unknown): Msg[] => {
  const p = json(v);
  if (Array.isArray(p)) return p.map(msgOf).filter((m): m is Msg => !!m);
  if (typeof p === 'string' && p.trim()) return [{ role: '', content: p }];
  const one = msgOf(p);
  return one ? [one] : [];
};

/** The messages a chat span received and the ones it produced. */
function chatOf(s: Span): { input: Msg[]; output: Msg[] } | undefined {
  const a = s.attrs;
  let input = list(a['gen_ai.input.messages'] ?? a['gen_ai.prompt']);
  let output = list(a['gen_ai.output.messages'] ?? a['gen_ai.completion']);
  if (!input.length) input = indexed(a, 'gen_ai.prompt');
  if (!output.length) output = indexed(a, 'gen_ai.completion');
  if (!input.length) input = indexed(a, 'llm.input_messages');
  if (!output.length) output = indexed(a, 'llm.output_messages');
  if (!input.length || !output.length) {
    // the event form: one event a message
    const ev = (names: string[]) => s.events.filter((e) => names.includes(e.name));
    if (!input.length) input = ev(['gen_ai.system.message', 'gen_ai.user.message', 'gen_ai.assistant.message', 'gen_ai.tool.message']).map((e) => msgOf({ role: e.name.split('.')[1], ...e.attrs, content: e.attrs.content ?? e.attrs['gen_ai.event.content'] })).filter((m): m is Msg => !!m);
    if (!output.length) output = ev(['gen_ai.choice']).map((e) => msgOf(json(e.attrs.message) ?? { role: 'assistant', content: e.attrs.content ?? e.attrs['gen_ai.event.content'] })).filter((m): m is Msg => !!m);
  }
  if (!input.length && typeof a['input.value'] === 'string' && a['openinference.span.kind'] === 'LLM') input = list(a['input.value']);
  if (!output.length && typeof a['output.value'] === 'string' && a['openinference.span.kind'] === 'LLM') output = list(a['output.value']);
  if (!input.length && !output.length) return undefined;
  for (const m of input) if (!m.role) m.role = 'user';
  for (const m of output) if (!m.role || m.role === 'user') m.role = 'assistant';
  return { input, output };
}

function docsOf(s: Span): Array<{ id: string; text: string; score?: number }> {
  const rows = new Map<number, Rec>();
  for (const [k, v] of Object.entries(s.attrs)) {
    const m = /^retrieval\.documents\.(\d+)\.document\.(.+)$/.exec(k);
    if (!m) continue;
    const row = rows.get(Number(m[1])) ?? {};
    row[m[2]!] = v;
    rows.set(Number(m[1]), row);
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, r]) => ({ id: String(r.id ?? `doc-${i + 1}`), text: String(r.content ?? ''), ...(typeof r.score === 'number' ? { score: r.score } : {}) }))
    .filter((d) => d.text);
}

const MAX_TEXT = 8000;
const cut = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

/** Dataset records from OTLP/JSON trace batches: one record a trace (a conversation id groups nothing here: a trace is one exchange). */
export function importOtelTraces(batches: Rec[], o: { limit?: number; onlyErrors?: boolean } = {}): TraceImport {
  const byTrace = new Map<string, Span[]>();
  for (const s of spansOf(batches)) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  const records: Rec[] = [];
  let skipped = 0;
  let noMessages = 0;
  let withTools = 0;
  let withDocs = 0;
  for (const [traceId, spans] of byTrace) {
    if (o.limit !== undefined && records.length >= o.limit) break;
    spans.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const failed = spans.some((s) => s.error);
    if (o.onlyErrors && !failed) continue;
    const chats = spans.map((s) => ({ s, chat: chatOf(s) })).filter((x): x is { s: Span; chat: { input: Msg[]; output: Msg[] } } => !!x.chat);
    if (!chats.length) {
      skipped++;
      noMessages++;
      continue;
    }
    // the first model call holds what the user asked; the last one holds the answer the user got
    const first = chats[0]!;
    const last = chats[chats.length - 1]!;
    const users = first.chat.input.filter((m) => m.role === 'user' && m.content.trim());
    const question = users.at(-1)?.content ?? '';
    const answer = [...last.chat.output].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
    if (!question.trim() || !answer.trim()) {
      skipped++;
      continue;
    }
    const system = first.chat.input.find((m) => m.role === 'system')?.content;
    // the tools that ran: tool spans, else the calls the model asked for
    const toolSpans = spans.filter((s) => s.attrs['gen_ai.tool.name'] !== undefined || s.attrs['gen_ai.operation.name'] === 'execute_tool' || s.attrs['openinference.span.kind'] === 'TOOL');
    const tools = toolSpans.length
      ? toolSpans.map((s) => ({ name: String(s.attrs['gen_ai.tool.name'] ?? s.attrs['tool.name'] ?? s.name.replace(/^execute_tool\s+/, '')), arguments: argsOf(s.attrs['gen_ai.tool.call.arguments'] ?? s.attrs['tool.parameters'] ?? s.attrs['input.value']) }))
      : chats.flatMap((c) => c.chat.output.flatMap((m) => m.toolCalls ?? []));
    const docs = spans.flatMap(docsOf);
    const sum = (keys: string[]) => chats.reduce((n, c) => n + (keys.map((k) => Number(c.s.attrs[k])).find((v) => Number.isFinite(v)) ?? 0), 0);
    const inputTokens = sum(['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.token_count.prompt']);
    const outputTokens = sum(['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.token_count.completion']);
    const model = String(last.s.attrs['gen_ai.response.model'] ?? last.s.attrs['gen_ai.request.model'] ?? last.s.attrs['llm.model_name'] ?? '');
    const begin = spans[0]!.start;
    const end = spans.reduce((m, s) => (s.end > m ? s.end : m), 0n);
    const conversation = spans.map((s) => s.attrs['gen_ai.conversation.id'] ?? s.attrs['session.id']).find((v) => v !== undefined);
    // earlier turns of the same conversation that the model was shown: kept as a transcript
    const history = first.chat.input.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (tools.length) withTools++;
    if (docs.length) withDocs++;
    records.push({
      id: traceId,
      question: cut(question),
      answer: cut(answer),
      ...(docs.length ? { contexts: docs.slice(0, 50).map((d) => ({ ...d, text: cut(d.text) })) } : {}),
      ...(tools.length ? { tool_calls: tools.slice(0, 100) } : {}),
      ...(history.length > 1 ? { turns: [...history.map((m) => ({ role: m.role, content: cut(m.content) })), { role: 'assistant', content: cut(answer) }] } : {}),
      ...(system ? { system: cut(system) } : {}),
      ...(model ? { model } : {}),
      ...(conversation !== undefined ? { conversation_id: String(conversation) } : {}),
      ...(end > begin ? { latency_ms: Number((end - begin) / 1_000_000n) } : {}),
      ...(inputTokens || outputTokens ? { input_tokens: inputTokens, output_tokens: outputTokens } : {}),
      tags: ['trace', ...(failed ? ['error'] : [])],
    });
  }
  const notes: string[] = [];
  if (noMessages) notes.push(`${noMessages} trace${noMessages === 1 ? ' has' : 's have'} no model call with its messages recorded: turn on content capture in the instrumentation (for the OpenTelemetry GenAI instrumentations, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true).`);
  if (skipped - noMessages > 0) notes.push(`${skipped - noMessages} trace${skipped - noMessages === 1 ? ' was' : 's were'} left out: no user question or no answer in words.`);
  if (records.length) notes.push(`${records.length} record${records.length === 1 ? '' : 's'}: ${withDocs} with retrieved documents, ${withTools} with tool calls. A record has the answer the system gave: score it as it is, and add a "reference" where you know the right answer.`);
  notes.push('Traces hold what real users typed: read the records and remove personal data before you commit the file.');
  return { records, notes, traces: byTrace.size, skipped };
}
