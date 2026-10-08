import type { Redactor } from '../util/redact.js';
import { shortId } from '../util/ids.js';
import type { DebuggerExchange } from './proxy.js';
import type { DebuggerSseEvent, WebSocketFrame } from './frames.js';

/**
 * The HTTP Debugger's sessions on disk are HAR 1.2 (every HTTP tool opens it) with TestPion's extras in `_testpion`
 * (the program, the tunnel kind, bookmarks). Values pass the redactor on the way out: a session file may be shared.
 */
export interface HarLog {
  log: { version: string; creator: { name: string; version: string }; entries: HarEntry[] };
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    cookies: unknown[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: unknown[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  /** The server's IP address (HAR 1.2), without the port. */
  serverIPAddress?: string;
  comment?: string;
  _testpion?: {
    id: string;
    kind: DebuggerExchange['kind'];
    application?: string;
    clientPort?: number;
    bookmarked?: boolean;
    error?: string;
    truncated?: boolean;
    tls?: boolean;
    frames?: WebSocketFrame[];
    events?: DebuggerSseEvent[];
    highlight?: string;
    rules?: string[];
    /** The program's process id, the server's ip:port, a highlight rule's style. */
    pid?: number;
    user?: string;
    serverAddress?: string;
    highlightStyle?: DebuggerExchange['highlightStyle'];
  };
}

export function exchangesToHar(exchanges: DebuggerExchange[], redactor: Redactor, version = '1'): HarLog {
  const headers = (h?: Record<string, string>) => Object.entries(redactor.redactHeaders(h ?? {})).map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: '1.2',
      creator: { name: 'TestPion HTTP Debugger', version },
      entries: exchanges.map((e) => ({
        startedDateTime: e.startedAt,
        time: e.durationMs ?? 0,
        request: {
          method: e.method,
          url: redactor.redactUrl(e.url),
          httpVersion: e.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1',
          headers: headers(e.requestHeaders),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.requestBodyBytes,
          ...(e.requestBody ? { postData: { mimeType: e.requestHeaders['content-type'] ?? '', text: redactor.redactString(e.requestBody) } } : {}),
        },
        response: {
          status: e.status ?? 0,
          statusText: e.statusText ?? '',
          httpVersion: e.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1',
          headers: headers(e.responseHeaders),
          cookies: [],
          content: { size: e.responseBodyBytes, mimeType: e.contentType ?? '', text: e.responseBody ? redactor.redactString(e.responseBody) : '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: e.responseBodyBytes,
        },
        cache: {},
        // HAR's three phases: sending the request, waiting for the first byte of the answer, receiving it
        timings: {
          send: Math.min(e.sendMs ?? 0, e.waitMs ?? 0),
          wait: Math.max(0, (e.waitMs ?? 0) - Math.min(e.sendMs ?? 0, e.waitMs ?? 0)),
          receive: Math.max(0, (e.durationMs ?? 0) - (e.waitMs ?? 0)),
        },
        ...(e.serverAddress ? { serverIPAddress: e.serverAddress.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') } : {}),
        ...(e.application ? { comment: `application: ${e.application}` } : {}),
        _testpion: {
          id: e.id,
          kind: e.kind,
          application: e.application,
          clientPort: e.clientPort,
          bookmarked: e.bookmarked,
          error: e.error,
          truncated: e.responseBodyTruncated,
          tls: e.tls,
          frames: e.frames?.map((f) => ({ ...f, text: f.text && redactor.redactString(f.text) })),
          events: e.events?.map((ev) => ({ ...ev, data: redactor.redactString(ev.data) })),
          highlight: e.highlight,
          rules: e.rules,
          pid: e.pid,
          user: e.user,
          serverAddress: e.serverAddress,
          highlightStyle: e.highlightStyle,
        },
      })),
    },
  };
}

/** A HAR file (ours or another tool's) as exchanges, for opening a saved session. */
export function exchangesFromHar(har: unknown): DebuggerExchange[] {
  const entries = (har as Partial<HarLog>)?.log?.entries;
  if (!Array.isArray(entries)) return [];
  const flat = (h?: Array<{ name: string; value: string }>) => Object.fromEntries((h ?? []).filter((x) => x && typeof x.name === 'string').map((x) => [x.name.toLowerCase(), String(x.value ?? '')]));
  return entries
    .filter((x) => x && x.request && typeof x.request.url === 'string')
    .map((x) => {
      const t = x._testpion;
      let host = '';
      try {
        host = new URL(x.request.url).host;
      } catch {
        host = x.request.url;
      }
      // until the first byte of the answer: sending plus waiting (-1 is HAR's "not known")
      const send = Math.max(0, x.timings?.send ?? 0);
      const wait = send + Math.max(0, x.timings?.wait ?? 0);
      const total = typeof x.time === 'number' ? x.time : wait + Math.max(0, x.timings?.receive ?? 0);
      const res = x.response ?? ({} as HarEntry['response']);
      return {
        id: t?.id ?? shortId('dbg-'),
        startedAt: x.startedDateTime ?? new Date(0).toISOString(),
        kind: t?.kind ?? 'http',
        method: x.request.method ?? 'GET',
        url: x.request.url,
        host,
        clientPort: t?.clientPort ?? 0,
        application: t?.application ?? (x.comment?.startsWith('application: ') ? x.comment.slice(13) : undefined),
        requestHeaders: flat(x.request.headers),
        requestBody: x.request.postData?.text || undefined,
        requestBodyBytes: x.request.bodySize >= 0 ? x.request.bodySize : (x.request.postData?.text?.length ?? 0),
        status: res.status || undefined,
        statusText: res.statusText,
        responseHeaders: flat(res.headers),
        responseBody: res.content?.text || undefined,
        responseBodyBytes: res.content?.size ?? res.bodySize ?? 0,
        responseBodyTruncated: t?.truncated,
        contentType: res.content?.mimeType || flat(res.headers)['content-type'],
        sendMs: send,
        waitMs: Math.max(0, wait),
        durationMs: Math.max(0, total),
        ...(x.request.httpVersion === 'HTTP/2' || x.request.httpVersion === 'h2' ? { httpVersion: '2' as const } : {}),
        ...(t?.serverAddress || x.serverIPAddress ? { serverAddress: t?.serverAddress ?? x.serverIPAddress } : {}),
        ...(t?.pid ? { pid: t.pid } : {}),
        ...(t?.user ? { user: t.user } : {}),
        ...(t?.highlightStyle ? { highlightStyle: t.highlightStyle } : {}),
        error: t?.error,
        bookmarked: t?.bookmarked,
        tls: t?.tls,
        frames: t?.frames,
        events: t?.events,
        highlight: t?.highlight,
        rules: t?.rules,
      };
    });
}
