import { maskSensitiveText, type Redactor } from '../util/redact.js';
import { shortId } from '../util/ids.js';
import type { DebuggerExchange } from './proxy.js';
import type { DebuggerSseEvent, WebSocketFrame } from './frames.js';

/**
 * The HTTP Debugger's sessions on disk are HAR 1.2 (every HTTP tool opens it) with TestPion's extras in `_testpion`
 * (the program, the tunnel kind, bookmarks). Values pass the redactor on the way out: a session file may be shared.
 */
interface HarLog {
  log: { version: string; creator: { name: string; version: string }; entries: HarEntry[] };
}

interface HarEntry {
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

/** What writing a HAR needs of a redactor (the app's, or the stricter one of `strictHarRedactor`). */
export type HarRedactor = Pick<Redactor, 'redactHeaders' | 'redactUrl' | 'redactString'>;

/** One exchange as a HAR entry; values pass the redactor. */
export function harEntry(e: DebuggerExchange, redactor: HarRedactor): HarEntry {
  const headers = (h?: Record<string, string>) => Object.entries(redactor.redactHeaders(h ?? {})).map(([name, value]) => ({ name, value }));
  return {
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
  };
}

export function exchangesToHar(exchanges: DebuggerExchange[], redactor: HarRedactor, version = '1'): HarLog {
  return { log: { version: '1.2', creator: { name: 'TestPion HTTP Debugger', version }, entries: exchanges.map((e) => harEntry(e, redactor)) } };
}

/**
 * A redactor for a file the user did not ask for (the AutoSave): everything `redactor` masks, plus the credential-bearing
 * headers whatever the user's field list says (Authorization, Cookie, Set-Cookie, API keys) and the tokens found by their
 * shape in every value (JWTs, Bearer and Basic schemes, `access_token=`, provider keys, private keys).
 */
export function strictHarRedactor(redactor: HarRedactor): HarRedactor {
  const always = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']);
  // a token under a well-known JSON key is masked whatever its shape (the shape detector reads `access_token=...`, not `"access_token":"..."`)
  const jsonToken = /("(?:access_?token|refresh_?token|id_?token|auth_?token|token|password|passwd|secret|client_?secret|api_?key)"\s*:\s*")([^"\\]{4,})(")/gi;
  const mask = (v: string) => maskSensitiveText(redactor.redactString(v), { pii: false }).replace(jsonToken, '$1[REDACTED]$3');
  return {
    redactString: mask,
    redactUrl: (u) => maskSensitiveText(redactor.redactUrl(u), { pii: false }),
    redactHeaders: (h) => Object.fromEntries(Object.entries(redactor.redactHeaders(h)).map(([k, v]) => [k, always.has(k.toLowerCase()) ? '***' : mask(v)])),
  };
}

/**
 * The HAR as text in pieces of about `pieceBytes`, built a few exchanges at a time: after `sliceMs` of work it yields to the
 * event loop (`pause`, setImmediate by default), so a session of thousands of exchanges is never one long block on the main
 * thread. The pieces joined are the same document `JSON.stringify(exchangesToHar(...))` gives (compact).
 */
export async function* harPieces(
  exchanges: DebuggerExchange[],
  redactor: HarRedactor,
  version = '1',
  o: { sliceMs?: number; pieceBytes?: number; pause?: () => Promise<void> } = {},
): AsyncGenerator<string> {
  const sliceMs = o.sliceMs ?? 5;
  const pieceBytes = o.pieceBytes ?? 128 * 1024;
  const pause = o.pause ?? (() => new Promise<void>((r) => setImmediate(r)));
  yield `{"log":{"version":"1.2","creator":${JSON.stringify({ name: 'TestPion HTTP Debugger', version })},"entries":[`;
  let piece = '';
  let slice = performance.now();
  let first = true;
  for (const e of exchanges) {
    piece += (first ? '' : ',') + JSON.stringify(harEntry(e, redactor));
    first = false;
    if (piece.length >= pieceBytes) {
      yield piece;
      piece = '';
    }
    if (performance.now() - slice > sliceMs) {
      await pause();
      slice = performance.now();
    }
  }
  if (piece) yield piece;
  yield ']}}';
}

/** A HAR file (ours or another tool's) as exchanges, for opening a saved session. */
export function exchangesFromHar(har: unknown): DebuggerExchange[] {
  // a HAR file is someone's file: any field may be missing or of another type (a hand edit, another tool, a newer
  // version). Each is read for the type it must have, else left out: the session opens, never a TypeError from deep inside.
  const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  const list = <T>(v: unknown): T[] | undefined => (Array.isArray(v) ? (v.filter((x) => obj(x)) as T[]) : undefined);
  const entries = obj(obj(har)?.log)?.entries;
  if (!Array.isArray(entries)) return [];
  const flat = (h: unknown) =>
    Object.fromEntries(
      (Array.isArray(h) ? h : []).filter((x) => typeof obj(x)?.name === 'string').map((x: { name: string; value?: unknown }) => [x.name.toLowerCase(), x.value == null ? '' : String(x.value)]),
    );
  return entries
    .filter((x) => typeof obj(obj(x)?.request)?.url === 'string')
    .map((x: Record<string, any>) => {
      const t = obj(x._testpion);
      const req = x.request as Record<string, any>;
      const url = req.url as string;
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        host = url;
      }
      // until the first byte of the answer: sending plus waiting (-1 is HAR's "not known")
      const timings = obj(x.timings);
      const send = Math.max(0, num(timings?.send) ?? 0);
      const wait = send + Math.max(0, num(timings?.wait) ?? 0);
      const total = num(x.time) ?? wait + Math.max(0, num(timings?.receive) ?? 0);
      const res = obj(x.response) ?? {};
      const content = obj(res.content);
      const postText = str(obj(req.postData)?.text);
      const comment = str(x.comment);
      const bodySize = num(req.bodySize);
      const httpVersion = str(req.httpVersion);
      const serverAddress = str(t?.serverAddress) ?? str(x.serverIPAddress);
      const kind = str(t?.kind);
      const responseHeaders = flat(res.headers);
      return {
        id: str(t?.id) || shortId('dbg-'),
        startedAt: str(x.startedDateTime) ?? new Date(0).toISOString(),
        kind: kind === 'tunnel' || kind === 'websocket' ? kind : 'http',
        method: str(req.method) || 'GET',
        url,
        host,
        clientPort: num(t?.clientPort) ?? 0,
        application: str(t?.application) ?? (comment?.startsWith('application: ') ? comment.slice(13) : undefined),
        requestHeaders: flat(req.headers),
        requestBody: postText || undefined,
        requestBodyBytes: bodySize !== undefined && bodySize >= 0 ? bodySize : (postText?.length ?? 0),
        status: num(res.status) || undefined,
        statusText: str(res.statusText),
        responseHeaders,
        responseBody: str(content?.text) || undefined,
        responseBodyBytes: num(content?.size) ?? num(res.bodySize) ?? 0,
        responseBodyTruncated: bool(t?.truncated),
        contentType: str(content?.mimeType) || responseHeaders['content-type'],
        sendMs: send,
        waitMs: Math.max(0, wait),
        durationMs: Math.max(0, total),
        ...(httpVersion === 'HTTP/2' || httpVersion === 'h2' ? { httpVersion: '2' as const } : {}),
        ...(serverAddress ? { serverAddress } : {}),
        ...(num(t?.pid) ? { pid: num(t?.pid) } : {}),
        ...(str(t?.user) ? { user: str(t?.user) } : {}),
        ...(obj(t?.highlightStyle) ? { highlightStyle: obj(t?.highlightStyle) as DebuggerExchange['highlightStyle'] } : {}),
        error: str(t?.error),
        bookmarked: bool(t?.bookmarked),
        tls: bool(t?.tls),
        frames: list<NonNullable<DebuggerExchange['frames']>[number]>(t?.frames),
        events: list<NonNullable<DebuggerExchange['events']>[number]>(t?.events),
        highlight: str(t?.highlight),
        rules: Array.isArray(t?.rules) ? (t.rules as unknown[]).filter((r): r is string => typeof r === 'string') : undefined,
      };
    });
}
