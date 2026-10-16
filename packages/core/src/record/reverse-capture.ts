import type { DebuggerExchange } from '../debugger/proxy.js';
import type { RecordedExchange } from './recorder.js';

/**
 * The reverse proxy ("Reverse proxy for one API", `record.*`) is one of the HTTP Debugger's capture modes: what it
 * forwards goes into the same exchange store and grid as the forward proxy's traffic, marked `source: 'reverse'`, so
 * filters, selection, Create flow, Save to collection, HAR export and History work the same. These turn one form into
 * the other (the recorder keeps its own light record; the grid keeps DebuggerExchanges).
 */
/** What the grid's Application column says for a reverse-proxied exchange (and what its Application filter picks). */
export const REVERSE_PROXY_APPLICATION = 'Reverse proxy';

const headerMap = (pairs: Array<[string, string]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const key = k.toLowerCase();
    out[key] = key in out ? `${out[key]}${key === 'set-cookie' ? '\n' : ', '}${v}` : v;
  }
  return out;
};

const bytesOf = (text: string | undefined, headers: Record<string, string>): number => {
  const declared = Number(headers['content-length']);
  return Number.isFinite(declared) && declared >= 0 ? declared : text ? Buffer.byteLength(text) : 0;
};

/** A reverse-proxied exchange as the Debugger keeps it: the target's URL, `source: 'reverse'`. */
export function debuggerExchangeFromRecorded(rx: RecordedExchange, target: string): DebuggerExchange {
  const base = target.replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(base).host;
  } catch {
    host = base;
  }
  const requestHeaders = headerMap(rx.requestHeaders);
  const responseHeaders = rx.status ? headerMap(rx.responseHeaders) : undefined;
  return {
    id: rx.id,
    startedAt: rx.time,
    kind: 'http',
    source: 'reverse',
    method: rx.method,
    url: base + rx.path,
    host,
    clientPort: 0,
    // the grid's Application column and filter: the program is not known behind a reverse proxy, the mode is
    application: REVERSE_PROXY_APPLICATION,
    requestHeaders,
    ...(rx.requestBody !== undefined ? { requestBody: rx.requestBody } : {}),
    requestBodyBytes: bytesOf(rx.requestBody, requestHeaders),
    ...(rx.truncated ? { requestBodyTruncated: true, responseBodyTruncated: true } : {}),
    ...(rx.status ? { status: rx.status, statusText: rx.statusText } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(rx.responseBody !== undefined ? { responseBody: rx.responseBody } : {}),
    responseBodyBytes: responseHeaders ? bytesOf(rx.responseBody, responseHeaders) : 0,
    ...(responseHeaders?.['content-type'] ? { contentType: responseHeaders['content-type'] } : {}),
    durationMs: rx.durationMs,
    ...(rx.error ? { error: rx.error } : {}),
  };
}

/** A Debugger exchange as the recorder's record (path from the target's origin): what recordingToCollection reads. */
export function recordedFromDebuggerExchange(e: DebuggerExchange, target: string): RecordedExchange {
  const base = target.replace(/\/+$/, '');
  const path = e.url.startsWith(base)
    ? e.url.slice(base.length) || '/'
    : (() => {
        try {
          const u = new URL(e.url);
          return u.pathname + u.search;
        } catch {
          return e.url;
        }
      })();
  return {
    id: e.id,
    time: e.startedAt,
    method: e.method,
    path,
    requestHeaders: Object.entries(e.requestHeaders),
    ...(e.requestBody !== undefined ? { requestBody: e.requestBody } : {}),
    status: e.status ?? 0,
    statusText: e.statusText ?? '',
    responseHeaders: Object.entries(e.responseHeaders ?? {}),
    ...(e.responseBody !== undefined ? { responseBody: e.responseBody } : {}),
    durationMs: e.durationMs ?? 0,
    ...(e.requestBodyTruncated || e.responseBodyTruncated ? { truncated: true } : {}),
    ...(e.error ? { error: e.error } : {}),
  };
}
