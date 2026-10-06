import type { Redactor } from '../util/redact.js';
import { shortId } from '../util/ids.js';
import type { DebuggerExchange } from './proxy.js';

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
  comment?: string;
  _testpion?: { id: string; kind: 'http' | 'tunnel'; application?: string; clientPort?: number; bookmarked?: boolean; error?: string; truncated?: boolean };
}

export function exchangesToHar(exchanges: DebuggerExchange[], redactor: Redactor, version = '1'): HarLog {
  const headers = (h?: Record<string, string>) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: redactor.isSensitiveKey(name) ? '***' : value }));
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
          httpVersion: 'HTTP/1.1',
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
          httpVersion: 'HTTP/1.1',
          headers: headers(e.responseHeaders),
          cookies: [],
          content: { size: e.responseBodyBytes, mimeType: e.contentType ?? '', text: e.responseBody ? redactor.redactString(e.responseBody) : '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: e.responseBodyBytes,
        },
        cache: {},
        timings: { send: 0, wait: e.waitMs ?? 0, receive: Math.max(0, (e.durationMs ?? 0) - (e.waitMs ?? 0)) },
        ...(e.application ? { comment: `application: ${e.application}` } : {}),
        _testpion: { id: e.id, kind: e.kind, application: e.application, clientPort: e.clientPort, bookmarked: e.bookmarked, error: e.error, truncated: e.responseBodyTruncated },
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
      const wait = x.timings?.wait ?? 0;
      const total = typeof x.time === 'number' ? x.time : wait + (x.timings?.receive ?? 0);
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
        waitMs: Math.max(0, wait),
        durationMs: Math.max(0, total),
        error: t?.error,
        bookmarked: t?.bookmarked,
      };
    });
}
