import { formatBytes, type DecodedJwt } from '@testpion/shared';
import type { HttpRequestSpec } from '../../types';
import type { Frame, GrpcCall, StreamEvent } from '../DebuggerTools';

/** The Debugger's shared shapes and helpers: an exchange as the window gets it, the session's numbers, what to copy and send again. */
export interface Exchange {
  id: string;
  /** In the list: the place in the session (#) and the seconds since its first request (Offset). */
  seq?: number;
  offsetSec?: number;
  startedAt: string;
  kind: 'http' | 'tunnel' | 'websocket';
  method: string;
  url: string;
  host: string;
  clientPort: number;
  application?: string;
  /** The program's process id, and the server's address (ip:port). */
  pid?: number;
  serverAddress?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyBytes: number;
  requestBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBytes: number;
  responseBodyTruncated?: boolean;
  /** DBG-4: captured inside a decrypted tunnel; still streaming; WebSocket frames; Server-Sent Events. */
  tls?: boolean;
  open?: boolean;
  frames?: Frame[];
  /** DBG-5: HTTP/2, the connection and stream, a gRPC call, trailers; in the list only counts of frames and events. */
  httpVersion?: '1.1' | '2';
  connectionId?: string;
  streamId?: number;
  grpc?: GrpcCall;
  trailers?: Record<string, string>;
  frameCount?: number;
  eventCount?: number;
  events?: StreamEvent[];
  contentType?: string;
  /** Until the request was sent whole (the Timeline's Sending). */
  sendMs?: number;
  waitMs?: number;
  durationMs?: number;
  error?: string;
  bookmarked?: boolean;
  /** Rules (DBG-3): the row's colour, the rules that acted, where a redirect sent it, a reply rule answered, a breakpoint edited it. */
  highlight?: string;
  /** A highlight rule's text colours per theme, bold, whole row. */
  highlightStyle?: { dark?: string; light?: string; bold?: boolean; row?: boolean };
  rules?: string[];
  redirectedTo?: string;
  repliedByRule?: boolean;
  edited?: boolean;
  /** The Auth inspector's reading (debug.exchange only). */
  auth?: { scheme: string; user?: string; jwt?: DecodedJwt; cookies: string[]; setCookies: string[]; note?: string };
}

export interface Stats {
  total: number;
  bytes: number;
  errors: number;
  firstAt?: string;
  lastAt?: string;
  timeline: Array<{ t: string; count: number; errors: number }>;
  statuses: Record<string, number>;
  hosts: Array<{ name: string; count: number; bytes: number; ms: number }>;
  contentTypes: Array<{ name: string; count: number; bytes: number }>;
  applications: Array<{ name: string; count: number; bytes: number }>;
  largest: Array<{ id: string; method: string; url: string; bytes: number }>;
  slowest: Array<{ id: string; method: string; url: string; ms?: number }>;
}

export function toRequest(e: Exchange): HttpRequestSpec {
  const headers = Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|connection|proxy-.*|accept-encoding)$/i.test(k))
    .map(([key, value]) => ({ key, value, enabled: true }));
  const ct = e.requestHeaders['content-type'] ?? '';
  const body = e.requestBody ? ({ type: /json/i.test(ct) ? 'json' : /xml/i.test(ct) ? 'xml' : 'text', content: e.requestBody } as HttpRequestSpec['body']) : undefined;
  return { method: e.method, url: e.url, headers, body };
}

export const curlOf = (e: Exchange) =>
  `curl -X ${e.method} '${e.url}'${Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|proxy-.*)$/i.test(k))
    .map(([k, v]) => ` \\\n  -H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join('')}${e.requestBody ? ` \\\n  --data '${e.requestBody.replace(/'/g, "'\\''")}'` : ''}`;

/** The exchange as it went over the wire (headers as received; bodies as kept), the Raw inspector. */
export function rawOf(e: Exchange): { request: string; response: string } {
  let path = e.url;
  try {
    const u = new URL(e.url);
    path = e.kind === 'tunnel' ? u.host : `${u.pathname}${u.search}`;
  } catch {
    /* as is */
  }
  const lines = (h?: Record<string, string>) =>
    Object.entries(h ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
  const request = `${e.method} ${path} HTTP/1.1\r\n${lines(e.requestHeaders)}\r\n\r\n${e.requestBody ?? (e.requestBodyBytes ? `(${formatBytes(e.requestBodyBytes)} not kept)` : '')}`;
  const response = e.error
    ? `(no response: ${e.error})`
    : e.status
      ? `HTTP/1.1 ${e.status} ${e.statusText ?? ''}\r\n${lines(e.responseHeaders)}\r\n\r\n${e.responseBody ?? (e.responseBodyBytes ? `(${formatBytes(e.responseBodyBytes)} of ${e.contentType ?? 'binary'} not kept)` : '')}`
      : '(no response yet)';
  return { request, response };
}

/** A hex dump of the first 64 KB of a text, 16 bytes a line, the Hex inspector. */
export function hexDump(text: string): string {
  const all = new TextEncoder().encode(text);
  const bytes = all.subarray(0, 64 * 1024);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    out.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return out.join('\n') + (bytes.length < all.length ? '\n… (the first 64 KB)' : '');
}

/**
 * The HTTP Debugger (planning/http-debugger.md): other programs send through TestPion's proxy; every exchange is
 * listed as it happens, with the program that sent it, and opens whole: headers, bodies, raw, hex, auth, timing.
 * From a row: open it as a request, resend it, copy it as cURL, bookmark it, delete it, ask the assistant about it.
 * Capture helpers start a browser or a terminal through the proxy, or switch the system proxy. Sessions are HAR files
 * in the workspace's debugger/ folder (AutoSave every minute while capturing). Statistics and an overview of the session.
 */

/** The size of a header block as sent: `name: value\r\n` per line (the start line not counted). */
export const headerBytes = (h?: Record<string, string>) => Object.entries(h ?? {}).reduce((n, [k, v]) => n + k.length + 2 + v.length + 2, 0);
/** Kilobytes with three decimals, as the grid shows sizes. */
export const kb = (bytes: number | undefined) => (bytes === undefined ? '' : (bytes / 1024).toFixed(3));
/** Speed in KB/s of the response body (empty while it streams). */
export const speedOf = (e: Pick<Exchange, 'responseBodyBytes' | 'durationMs' | 'waitMs'>) => {
  const ms = (e.durationMs ?? 0) - (e.waitMs ?? 0);
  if (e.durationMs === undefined) return '';
  return (((e.responseBodyBytes + 0) / 1024 / Math.max(ms, 1)) * 1000).toFixed(3);
};
/** The response's version and status line. */
export const versionOf = (e: Pick<Exchange, 'httpVersion' | 'kind'>) => (e.kind === 'tunnel' ? 'TUNNEL' : e.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1');
/** A request a TestPion mock server received (the Incoming tab). */
export interface IncomingRequest {
  id: string;
  time: string;
  collectionId: string;
  server?: string;
  method: string;
  path: string;
  status: number;
  example?: string;
  forwarded?: boolean;
}
