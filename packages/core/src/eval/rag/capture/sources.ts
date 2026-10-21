/**
 * The places a captured call can be read from: History entries, a saved Debugger session (HAR in debugger/, also named by
 * the History entry of kind `capture` that saved it), any HAR file of the workspace, and the results of an evaluation run.
 * Each reader gives CapturedCall rows: the method, URL, request body, status and response text, never headers or cookies
 * of the request (they are not needed and must not reach a dataset).
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ApsError } from '../../../errors.js';
import type { HistoryEntry } from '../../../model/types.js';
import type { DebuggerExchange } from '../../../debugger/proxy.js';
import { CAPTURE_SESSIONS_DIR } from '../../../debugger/capture-history.js';
import { historyResponse } from '../../../storage/history-compare.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import type { CapturedCall, CaptureSourceSpec } from './types.js';

type Rec = Record<string, unknown>;
const MAX_HAR_BYTES = 64 * 1024 * 1024;

type Reader = Pick<WorkspaceStore, 'meta' | 'path' | 'safePath' | 'runDir'> & { root: string };

/** A History entry of the HTTP kind as a call (its response body is read from the payload file). */
export function callOfHistory(store: Pick<WorkspaceStore, 'path'>, e: HistoryEntry): CapturedCall {
  // History keeps the request of a gRPC or an MCP call (the message, the arguments) but not what came back
  if (e.kind === 'grpc' || e.kind === 'mcp') {
    const r = (e.request ?? {}) as { target?: string; method?: string; message?: unknown; serverId?: string; tool?: string; args?: unknown };
    const grpc = e.kind === 'grpc';
    const body = grpc ? r.message : r.args;
    return {
      source: 'history',
      id: e.id,
      at: e.timestamp,
      protocol: grpc ? 'grpc' : 'mcp',
      method: grpc ? 'GRPC' : 'MCP',
      ...(grpc ? { operation: r.method ?? e.name, url: r.target ?? e.url } : { operation: r.tool, url: r.serverId }),
      ...(body !== undefined && body !== '' ? { requestBody: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      requestContentType: 'application/json',
      ok: grpc ? e.status === 'OK' : e.status === 'ok',
      ...(e.durationMs !== undefined ? { latencyMs: e.durationMs } : {}),
    };
  }
  const req = (e.request ?? {}) as { body?: { type?: string; content?: unknown }; headers?: Array<{ key: string; value: string }> };
  const body = req.body && typeof req.body.content === 'string' ? req.body.content : undefined;
  const ct = (req.headers ?? []).find((h) => /^content-type$/i.test(h.key))?.value;
  const res = historyResponse(store as WorkspaceStore, e);
  return {
    source: 'history',
    id: e.id,
    at: e.timestamp,
    method: e.method,
    url: e.url,
    ...(body !== undefined ? { requestBody: body } : {}),
    ...(ct ? { requestContentType: ct } : {}),
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(res.body !== undefined ? { responseText: res.body } : {}),
    responseHeaders: res.headers,
    ...(e.durationMs !== undefined ? { latencyMs: e.durationMs } : {}),
  };
}

/** The calls of a WebSocket message log: each sent message and the messages received before the next one. */
export function callsOfMessages(text: string, label: string, url?: string): CapturedCall[] {
  type Msg = { time?: unknown; at?: unknown; timestamp?: unknown; direction?: unknown; data?: unknown; text?: unknown; payload?: unknown };
  const toMs = (m: Msg): number | undefined => {
    const t = m.time ?? m.at ?? m.timestamp;
    if (typeof t === 'number') return t;
    const p = typeof t === 'string' ? Date.parse(t) : NaN;
    return Number.isFinite(p) ? p : undefined;
  };
  const dataOf = (m: Msg): string => {
    const d = m.data ?? m.text ?? m.payload;
    return typeof d === 'string' ? d : d === undefined ? '' : JSON.stringify(d);
  };
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  const msgs: Msg[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) msgs.push(...(arr.filter((x) => x && typeof x === 'object') as Msg[]));
    } catch (e) {
      throw new ApsError('ValidationError', `${label} is not a message log: ${(e as Error).message}`);
    }
  } else
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as Msg;
        if (m && typeof m === 'object') msgs.push(m);
      } catch {
        throw new ApsError('ValidationError', `${label} is not a message log (JSON Lines: one message per line)`);
      }
    }
  const out: CapturedCall[] = [];
  let cur: { sent: Msg; received: Msg[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const t0 = toMs(cur.sent);
    const last = cur.received.length ? toMs(cur.received[cur.received.length - 1]!) : undefined;
    const received = cur.received.map((m) => dataOf(m));
    out.push({
      source: 'messages',
      id: `${label}#${out.length + 1}`,
      protocol: 'websocket',
      method: 'WS',
      ...(url ? { url } : {}),
      ...(t0 !== undefined ? { at: new Date(t0).toISOString() } : {}),
      requestBody: dataOf(cur.sent),
      requestContentType: 'application/json',
      ok: received.length > 0,
      responseText: JSON.stringify({ connected: true, received: received.map(parse), messages: cur.received.map((m, i) => ({ direction: 'received', data: received[i] })) }),
      ...(t0 !== undefined && last !== undefined && last >= t0 ? { latencyMs: Math.round(last - t0) } : {}),
    });
    cur = undefined;
  };
  for (const m of msgs) {
    const dir = String(m.direction ?? '');
    if (dir === 'sent') {
      flush();
      cur = { sent: m, received: [] };
    } else if (dir === 'received' && cur) cur.received.push(m);
  }
  flush();
  return out;
}

function readMessages(store: Reader, rel: string, url?: string): CapturedCall[] {
  const file = store.safePath(rel);
  if (!existsSync(file)) throw new ApsError('ConfigurationError', `${rel} is not in the workspace`);
  if (statSync(file).size > MAX_HAR_BYTES) throw new ApsError('ValidationError', `${rel} is larger than ${MAX_HAR_BYTES / 1024 / 1024} MB`);
  return callsOfMessages(readFileSync(file, 'utf8'), rel, url);
}

/** A live Debugger exchange as a call (the window passes the exchanges it shows). */
export function callOfExchange(x: DebuggerExchange): CapturedCall {
  return {
    source: 'debugger',
    id: x.id,
    at: x.startedAt,
    method: x.method,
    url: x.url,
    ...(x.requestBody !== undefined ? { requestBody: x.requestBody } : {}),
    ...(x.requestHeaders && Object.entries(x.requestHeaders).find(([k]) => /^content-type$/i.test(k)) ? { requestContentType: Object.entries(x.requestHeaders).find(([k]) => /^content-type$/i.test(k))![1] } : {}),
    ...(x.status !== undefined ? { status: x.status } : {}),
    ...(x.responseBody !== undefined ? { responseText: x.responseBody } : {}),
    responseHeaders: Object.entries(x.responseHeaders ?? {}),
    ...(x.durationMs !== undefined ? { latencyMs: x.durationMs } : {}),
  };
}

/** The entries of a HAR document as calls. */
export function callsOfHar(text: string, source: 'debugger' | 'har', label: string): CapturedCall[] {
  let d: { log?: { entries?: Rec[] } };
  try {
    d = JSON.parse(text);
  } catch (e) {
    throw new ApsError('ValidationError', `${label} is not a HAR file: ${(e as Error).message}`);
  }
  const entries = d.log?.entries;
  if (!Array.isArray(entries)) throw new ApsError('ValidationError', `${label} is not a HAR file (no log.entries)`);
  return entries.map((e, i) => {
    const req = (e.request ?? {}) as Rec;
    const res = (e.response ?? {}) as Rec;
    const post = req.postData as { text?: string; mimeType?: string } | undefined;
    const content = res.content as { text?: string; encoding?: string } | undefined;
    const headers = Array.isArray(res.headers) ? (res.headers as Array<{ name: string; value: string }>).map((h) => [h.name, h.value] as [string, string]) : [];
    const status = Number(res.status);
    return {
      source,
      id: `${label}#${i + 1}`,
      ...(typeof e.startedDateTime === 'string' ? { at: e.startedDateTime } : {}),
      method: String(req.method ?? 'GET'),
      url: String(req.url ?? ''),
      ...(typeof post?.text === 'string' ? { requestBody: post.text } : {}),
      ...(post?.mimeType ? { requestContentType: post.mimeType } : {}),
      ...(status ? { status } : {}),
      ...(typeof content?.text === 'string' && content.encoding !== 'base64' ? { responseText: content.text } : {}),
      responseHeaders: headers,
      ...(typeof e.time === 'number' && e.time >= 0 ? { latencyMs: Math.round(e.time) } : {}),
    } satisfies CapturedCall;
  });
}

function readHar(store: Reader, rel: string, source: 'debugger' | 'har'): CapturedCall[] {
  const file = store.safePath(rel);
  if (!existsSync(file)) throw new ApsError('ConfigurationError', `${rel} is not in the workspace`);
  if (statSync(file).size > MAX_HAR_BYTES) throw new ApsError('ValidationError', `${rel} is larger than ${MAX_HAR_BYTES / 1024 / 1024} MB`);
  return callsOfHar(readFileSync(file, 'utf8'), source, rel);
}

/** A saved session by its name, its file (`debugger/x.har`) or the id of the History entry that saved it. */
function sessionFile(store: Reader, session: string): string {
  const h = store.meta.getHistory(session);
  if (h?.kind === 'capture') {
    const ref = h.capture?.ref;
    if (h.capture?.result === 'session' && ref && ref.kind === 'capture') return `${CAPTURE_SESSIONS_DIR}/${ref.name}`;
    throw new ApsError('ValidationError', `The capture "${h.name}" became ${h.capture?.result === 'flow' ? 'a flow' : 'a collection'}, not a saved session; its exchanges are not kept`, { suggestions: ['Save the session from the Debugger (Save session), then use it.'] });
  }
  const s = session.replace(/\\/g, '/').replace(/^debugger\//, '');
  return `${CAPTURE_SESSIONS_DIR}/${/\.har$/i.test(s) ? s : `${s}.har`}`;
}

async function readRun(store: Reader, run: string): Promise<CapturedCall[]> {
  const file = store.safePath('results.jsonl', store.runDir(run));
  if (!existsSync(file)) throw new ApsError('ConfigurationError', `No results for run "${run}"`, { suggestions: ['`testpion history list` shows the runs.'] });
  const out: CapturedCall[] = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: { id?: string; startedAt?: string; metadata?: { rag?: { query?: string; reference?: string; referenceIds?: string[]; sample?: { answer?: string; contexts?: Array<{ id: string; text: string; score?: number; source?: string }> } } } };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const rag = r.metadata?.rag;
    if (!rag?.query || typeof rag.sample?.answer !== 'string') continue;
    out.push({
      source: 'run',
      id: `${run}:${String(r.id ?? out.length + 1)}`,
      ...(r.startedAt ? { at: r.startedAt } : {}),
      sample: { question: rag.query, answer: rag.sample.answer, contexts: rag.sample.contexts ?? [], ...(rag.reference ? { reference: rag.reference } : {}), ...(rag.referenceIds?.length ? { referenceIds: rag.referenceIds } : {}) },
    });
  }
  return out;
}

/** Every call of a source, oldest first. */
export async function readCalls(store: Reader, spec: CaptureSourceSpec): Promise<CapturedCall[]> {
  let calls: CapturedCall[];
  if (spec.kind === 'calls') calls = spec.calls;
  else if (spec.kind === 'run') calls = await readRun(store, spec.run);
  else if (spec.kind === 'har') calls = readHar(store, spec.file, 'har');
  else if (spec.kind === 'messages') calls = readMessages(store, spec.file, spec.url);
  else if (spec.kind === 'debugger') calls = readHar(store, sessionFile(store, spec.session), 'debugger');
  else {
    const entries = spec.ids?.length
      ? spec.ids.map((id) => {
          const e = store.meta.getHistory(id);
          if (!e) throw new ApsError('ConfigurationError', `No History entry "${id}"`, { suggestions: ['`testpion history list` shows the entries.'] });
          return e;
        })
      : store.meta.listHistory({ limit: spec.limit ?? 2000, requests: true }).items;
    calls = entries.filter((e) => e.kind === 'http' || e.kind === 'grpc' || e.kind === 'mcp').map((e) => callOfHistory(store, e));
  }
  return calls.slice().sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

/** What the person can choose as a source: the saved sessions and the HAR files of the workspace (runs and History are listed by their own views). */
export function listCaptureSources(store: Pick<WorkspaceStore, 'path' | 'root'>): { sessions: string[]; hars: string[]; messages: string[] } {
  const sessions = existsSync(store.path(CAPTURE_SESSIONS_DIR)) ? readdirSync(store.path(CAPTURE_SESSIONS_DIR)).filter((f) => /\.har$/i.test(f)).sort() : [];
  const hars: string[] = [];
  for (const dir of ['datasets', 'imports', 'har']) {
    const d = store.path(dir);
    if (existsSync(d)) for (const f of readdirSync(d)) if (/\.har$/i.test(f)) hars.push(`${dir}/${f}`);
  }
  // WebSocket message logs: JSON Lines saved from the message log's down arrow
  const messages: string[] = [];
  for (const dir of ['messages', 'imports', 'har']) {
    const d = store.path(dir);
    if (existsSync(d)) for (const f of readdirSync(d)) if (/\.(jsonl|ndjson)$/i.test(f)) messages.push(`${dir}/${f}`);
  }
  return { sessions: sessions.map((f) => `${CAPTURE_SESSIONS_DIR}/${f}`), hars, messages };
}
