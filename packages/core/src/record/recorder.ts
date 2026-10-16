import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApsError } from '../errors.js';
import type { BodyConfig, Collection, CollectionNode, HttpRequestSpec, KeyValue, SavedExample, SavedHttpRequest } from '../model/types.js';
import { shortId } from '../util/ids.js';
import type { Redactor } from '../util/redact.js';
import { externalizeSecrets, type SecretPlaceholder } from '../import/save-request.js';

/**
 * Record traffic: a reverse proxy on 127.0.0.1 that forwards every request to a target API (http or
 * https) and keeps each exchange, so a front end or any client pointed at the proxy shows what it
 * sends and receives. A recording becomes a collection (requests, responses as examples, secrets as
 * {{variables}}) to replay, test or mock.
 */
export interface RecordedExchange {
  id: string;
  time: string;
  method: string;
  /** Path and query, e.g. /v1/pets?limit=10 */
  path: string;
  requestHeaders: Array<[string, string]>;
  requestBody?: string;
  status: number;
  statusText: string;
  responseHeaders: Array<[string, string]>;
  responseBody?: string;
  durationMs: number;
  /** The body was bigger than the recording limit (it was still forwarded in full). */
  truncated?: boolean;
  error?: string;
}

export interface Recorder {
  url: string;
  port: number;
  target: string;
  exchanges: RecordedExchange[];
  close(): Promise<void>;
}

const HOP = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|host|content-length)$/i;
const MAX_FORWARD = 50 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_FORWARD) {
        reject(new ApsError('ValidationError', 'Request body larger than 50 MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const textOf = (buf: Buffer, contentType: string | undefined, max: number): { text?: string; truncated: boolean } => {
  if (!buf.length) return { truncated: false };
  if (contentType && !/json|text|xml|html|javascript|x-www-form-urlencoded|graphql|csv|yaml/i.test(contentType)) return { text: `(${buf.length} bytes of ${contentType})`, truncated: false };
  return { text: buf.subarray(0, max).toString('utf8'), truncated: buf.length > max };
};

/** Start recording. Only loopback addresses are used: this is a development tool. */
export async function startRecorder(opts: {
  target: string;
  port?: number;
  maxBodyBytes?: number;
  cors?: boolean;
  onExchange?: (e: RecordedExchange) => void;
  /** Keep the exchanges in `exchanges` (default). The app passes false: they go to the Debugger's store instead. */
  keep?: boolean;
}): Promise<Recorder> {
  let target: URL;
  try {
    target = new URL(opts.target);
  } catch {
    throw new ApsError('ValidationError', `"${opts.target}" is not a URL`, { suggestions: ['Use the API base URL, e.g. https://api.example.com'] });
  }
  if (!/^https?:$/.test(target.protocol)) throw new ApsError('ValidationError', 'The target must be an http or https URL');
  const base = target.toString().replace(/\/+$/, '');
  const maxBody = opts.maxBodyBytes ?? 256 * 1024;
  const cors = opts.cors !== false;
  const exchanges: RecordedExchange[] = [];
  let localOrigin = '';

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = performance.now();
    const corsHeaders: Record<string, string> = cors
      ? { 'access-control-allow-origin': String(req.headers.origin ?? '*'), 'access-control-allow-credentials': 'true', 'access-control-expose-headers': '*' }
      : {};
    // a browser's CORS preflight is answered here: the target may not allow the local origin
    if (cors && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, { ...corsHeaders, 'access-control-allow-methods': '*', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '*'), 'access-control-max-age': '600' });
      return res.end();
    }
    const path = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const requestHeaders = Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]]));
    const ex: RecordedExchange = { id: shortId('rx-'), time: new Date().toISOString(), method, path, requestHeaders, status: 0, statusText: '', responseHeaders: [], durationMs: 0 };
    try {
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const reqText = textOf(body, req.headers['content-type'], maxBody);
      ex.requestBody = reqText.text;
      const headers = new Headers();
      for (const [k, v] of requestHeaders) if (!HOP.test(k) && k.toLowerCase() !== 'accept-encoding' && k.toLowerCase() !== 'origin') headers.append(k, v);
      const upstream = await fetch(base + path, { method, headers, body: body.length ? body : undefined, redirect: 'manual' });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const out: Record<string, string | string[]> = { ...corsHeaders };
      upstream.headers.forEach((v, k) => {
        if (HOP.test(k) || k === 'content-encoding' || (cors && k.startsWith('access-control-'))) return;
        // redirects to the target come back through the proxy
        out[k] = k === 'location' && v.startsWith(base) ? localOrigin + v.slice(base.length) : v;
      });
      const setCookie = upstream.headers.getSetCookie?.() ?? [];
      if (setCookie.length) out['set-cookie'] = setCookie.map((c) => c.replace(/;\s*Domain=[^;]*/i, '').replace(/;\s*Secure/i, ''));
      ex.status = upstream.status;
      ex.statusText = upstream.statusText;
      ex.responseHeaders = [...upstream.headers.entries()].filter(([k]) => !HOP.test(k) && k !== 'content-encoding');
      const resText = textOf(buf, upstream.headers.get('content-type') ?? undefined, maxBody);
      ex.responseBody = resText.text;
      ex.truncated = reqText.truncated || resText.truncated || undefined;
      res.writeHead(upstream.status, upstream.statusText, { ...out, 'content-length': String(buf.length) });
      res.end(method === 'HEAD' ? undefined : buf);
    } catch (e) {
      ex.error = (e as Error).message;
      ex.status = 502;
      ex.statusText = 'Bad Gateway';
      if (!res.headersSent) res.writeHead(502, { ...corsHeaders, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_failed', message: ex.error, target: base }));
    } finally {
      ex.durationMs = Math.round(performance.now() - t0);
      if (opts.keep !== false) {
        exchanges.push(ex);
        if (exchanges.length > 5000) exchanges.shift();
      }
      opts.onExchange?.(ex);
    }
  };

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(new ApsError('ConfigurationError', e.code === 'EADDRINUSE' ? `Port ${opts.port} is in use` : e.message)));
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  localOrigin = `http://127.0.0.1:${port}`;
  return {
    url: localOrigin,
    port,
    target: base,
    exchanges,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Request headers worth keeping in a saved request (not browser noise or per-connection values). */
const KEEP_HEADER = (k: string) => !HOP.test(k) && !/^(accept-encoding|accept-language|origin|referer|cookie|user-agent|dnt|priority|cache-control|pragma|if-none-match|if-modified-since|sec-.*)$/i.test(k);

function bodyOf(text: string | undefined, contentType: string | undefined): BodyConfig | undefined {
  if (!text) return undefined;
  if (/json/i.test(contentType ?? '')) return { type: 'json', content: text };
  if (/x-www-form-urlencoded/i.test(contentType ?? ''))
    return { type: 'form-urlencoded', fields: [...new URLSearchParams(text)].map(([key, value]) => ({ key, value, enabled: true })) };
  if (/xml/i.test(contentType ?? '')) return { type: 'xml', content: text };
  return { type: 'text', content: text };
}

/**
 * A collection from recorded exchanges: one request per method + path (repeats add their other
 * responses as examples), grouped in folders by the first path segment, `{{baseUrl}}` for the target.
 * Tokens, keys and similar values become {{variables}} (listed in `placeholders`); cookies are dropped.
 */
export function recordingToCollection(
  exchanges: RecordedExchange[],
  opts: { name: string; target: string; redactor: Redactor },
): { collection: Collection; placeholders: SecretPlaceholder[]; requests: number } {
  const byKey = new Map<string, SavedHttpRequest>();
  const folders = new Map<string, { kind: 'folder'; id: string; name: string; items: CollectionNode[] }>();
  const root: CollectionNode[] = [];
  const placeholders: SecretPlaceholder[] = [];
  for (const ex of exchanges.filter((x) => !x.error && x.method !== 'OPTIONS')) {
    const [pathOnly, query = ''] = ex.path.split('?');
    const key = `${ex.method} ${pathOnly}`;
    const example: SavedExample = {
      id: shortId('ex-'),
      name: `${ex.status} ${ex.statusText}`.trim(),
      status: ex.status,
      statusText: ex.statusText || undefined,
      headers: ex.responseHeaders.filter(([k]) => /^content-type$/i.test(k)).map(([key, value]) => ({ key, value, enabled: true })),
      body: opts.redactor.redactString(ex.responseBody ?? ''),
      createdAt: ex.time,
    };
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.examples!.some((e) => e.status === ex.status)) existing.examples!.push(example);
      continue;
    }
    const contentType = ex.requestHeaders.find(([k]) => /^content-type$/i.test(k))?.[1];
    const headers: KeyValue[] = ex.requestHeaders.filter(([k, v]) => KEEP_HEADER(k) && !(/^accept$/i.test(k) && v === '*/*')).map(([key, value]) => ({ key, value, enabled: true }));
    const params: KeyValue[] = [...new URLSearchParams(query)].map(([key, value]) => ({ key, value, enabled: true }));
    const spec: HttpRequestSpec = { method: ex.method, url: `{{baseUrl}}${pathOnly}`, params, headers, body: bodyOf(ex.requestBody, contentType) };
    const { request, placeholders: ph } = externalizeSecrets(spec, opts.redactor);
    for (const p of ph) if (!placeholders.some((x) => x.variable === p.variable)) placeholders.push(p);
    const node: SavedHttpRequest = { kind: 'http', id: shortId('req-'), name: key, request, examples: [example], assertions: [{ type: 'status', expected: ex.status }] };
    byKey.set(key, node);
    const seg = pathOnly!.split('/').filter(Boolean)[0];
    if (seg && exchanges.length > 3) {
      let f = folders.get(seg);
      if (!f) {
        f = { kind: 'folder', id: shortId('fld-'), name: seg, items: [] };
        folders.set(seg, f);
        root.push(f);
      }
      f.items.push(node);
    } else root.push(node);
  }
  const collection: Collection = {
    schemaVersion: '1.0',
    id: shortId('col-'),
    name: opts.name,
    description: `Recorded from ${opts.target} on ${new Date().toISOString().slice(0, 10)}.`,
    version: 1,
    variables: [{ key: 'baseUrl', value: opts.target, enabled: true }],
    items: root,
    updatedAt: new Date().toISOString(),
  };
  return { collection, placeholders, requests: byKey.size };
}
