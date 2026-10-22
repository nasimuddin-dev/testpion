import { shortId, type ItemRef, type Redactor, type TestResult } from '@testpion/core';

/**
 * The Postman-style console (the window's bottom panel): what was sent, newest last, with the scripts' output. Every
 * entry names what it belongs to as refs (WF-16): the saved request it was sent from, its History entry, its trace, the
 * run and result it is part of, so the console links to them (and they back to it).
 */

export const CONSOLE_MAX = 500;
export const CONSOLE_BODY_CHARS = 16_000;

/** One line of the console. Values are redacted before they are stored. */
export interface ConsoleEntry {
  id: string;
  time: string;
  source: 'request' | 'run';
  /** Protocol; absent means HTTP. */
  kind?: 'graphql' | 'mcp' | 'websocket';
  /** The run's name (a run's request). */
  run?: string;
  name: string;
  method: string;
  url: string;
  status?: number | string;
  durationMs?: number;
  size?: number;
  request?: { headers: Array<[string, string]>; body?: string };
  response?: { headers: Array<[string, string]>; body?: string };
  logs: Array<{ phase: 'pre-request' | 'test'; message: string }>;
  error?: string;
  failedChecks?: number;
  /** What it belongs to: the saved request, its History entry, its trace, its run (and result). */
  refs?: ItemRef[];
}

/** What the console needs of the backend. */
interface ConsoleHost {
  consoleBuffer: ConsoleEntry[];
  /** The `console` event, batched: a run's test-ends reach the window a few at a time, not one event each. */
  consoleEvents: { push(e: ConsoleEntry): void };
}

/** A body for the console: kept up to 16,000 characters. */
export const clipConsole = (t: string | undefined) => (t && t.length > CONSOLE_BODY_CHARS ? `${t.slice(0, CONSOLE_BODY_CHARS)}… [${t.length - CONSOLE_BODY_CHARS} more characters]` : t);

/** The refs of an entry, without the empty ones. */
export function consoleRefs(o: { collectionId?: string; requestId?: string; historyId?: string; traceId?: string; runId?: string; resultId?: string }): ItemRef[] | undefined {
  const refs: ItemRef[] = [];
  if (o.collectionId && o.requestId) refs.push({ kind: 'request', collectionId: o.collectionId, requestId: o.requestId });
  if (o.historyId) refs.push({ kind: 'history', historyId: o.historyId });
  if (o.runId) refs.push({ kind: 'run', runId: o.runId, ...(o.resultId ? { resultId: o.resultId } : {}) });
  if (o.traceId) refs.push({ kind: 'trace', traceId: o.traceId });
  return refs.length ? refs : undefined;
}

export function pushConsole(be: ConsoleHost, e: ConsoleEntry): void {
  be.consoleBuffer.push(e);
  if (be.consoleBuffer.length > CONSOLE_MAX) be.consoleBuffer.splice(0, be.consoleBuffer.length - CONSOLE_MAX);
  be.consoleEvents.push(e);
}

/** Console entry for an MCP or WebSocket action; bodies are redacted and clipped. */
export function consoleProtocol(
  be: ConsoleHost,
  kind: 'mcp' | 'websocket',
  redactor: Redactor,
  e: {
    name: string;
    method: string;
    url: string;
    status?: string;
    durationMs?: number;
    request?: unknown;
    response?: unknown;
    error?: string;
    failedChecks?: number;
    logs?: string[];
    refs?: ItemRef[];
  },
): void {
  const body = (v: unknown) => (v === undefined ? undefined : clipConsole(typeof v === 'string' ? redactor.redactString(v) : JSON.stringify(redactor.redact(v), null, 2)));
  pushConsole(be, {
    id: shortId('c-'),
    time: new Date().toISOString(),
    source: 'request',
    kind,
    name: e.name,
    method: e.method,
    url: e.url,
    status: e.status,
    durationMs: e.durationMs,
    request: e.request !== undefined ? { headers: [], body: body(e.request) } : undefined,
    response: e.response !== undefined ? { headers: [], body: body(e.response) } : undefined,
    logs: (e.logs ?? []).map((message) => ({ phase: 'test' as const, message: redactor.redactString(message) })),
    error: e.error && redactor.redactString(e.error),
    failedChecks: e.failedChecks,
    refs: e.refs,
  });
}

/**
 * Requests made by runs (test runner, Collection Runner) appear in the console too, without bodies; each links to its
 * run's result, its trace, and (a collection run) the saved request.
 */
export function consoleFromResult(be: ConsoleHost, r: TestResult, run: { name: string; runId: string; collectionId?: string }, redactor: Redactor): void {
  if (r.type !== 'http' && r.type !== 'graphql') return;
  const m = (r.metadata ?? {}) as {
    url?: string;
    method?: string;
    size?: number;
    preRequestLogs?: string[];
    scriptLogs?: string[];
    sentRequests?: Array<{ method: string; url: string; status?: number; error?: string; durationMs?: number }>;
  };
  const status = r.checks.find((c) => c.type === 'status')?.actual;
  pushConsole(be, {
    id: r.id,
    time: new Date().toISOString(),
    source: 'run',
    run: run.name,
    name: r.name,
    method: m.method ?? (r.type === 'graphql' ? 'POST' : 'GET'),
    url: m.url ?? r.input ?? '',
    status: typeof status === 'number' ? status : r.error ? r.error.kind : r.status,
    durationMs: r.latencyMs,
    size: m.size,
    logs: [
      ...(m.preRequestLogs ?? []).map((message) => ({ phase: 'pre-request' as const, message: redactor.redactString(message) })),
      ...(m.scriptLogs ?? []).map((message) => ({ phase: 'test' as const, message: redactor.redactString(message) })),
      ...(m.sentRequests ?? []).map((s) => ({ phase: 'test' as const, message: `tp.sendRequest ${s.method} ${s.url} → ${s.error ? `error: ${s.error}` : `${s.status} (${s.durationMs} ms)`}` })),
    ],
    error: r.error?.message,
    failedChecks: r.checks.filter((c) => !c.passed).length,
    // a collection run's result id is "<request id>@<iteration>[#n]"
    refs: consoleRefs({ runId: run.runId, resultId: r.id, traceId: r.traceId, collectionId: run.collectionId, requestId: run.collectionId ? r.id.split('@')[0] : undefined }),
  });
}
