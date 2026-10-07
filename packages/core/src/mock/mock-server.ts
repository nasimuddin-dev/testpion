import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Collection, CollectionNode, SavedExample, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import { dynamicValue } from '../vars/dynamic.js';

/** One example the mock server can answer with. */
export interface MockRoute {
  method: string;
  /** Path pattern, e.g. `/patients/:id` (`:name` and `{{var}}` segments match anything). */
  path: string;
  /** Query parameters the example was saved with (used to pick between examples). */
  query: Record<string, string>;
  /** Request body the example was saved with (used to pick between examples). */
  body?: string;
  /** Request headers the example was saved with (for `x-mock-match-request-headers`). */
  headers?: Array<{ key: string; value: string }>;
  requestId: string;
  requestName: string;
  example: SavedExample;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The path part of a saved request URL: `{{baseUrl}}/patients/1?x=1` → `/patients/1` and `{x: '1'}`.
 * A leading scheme+host or `{{variable}}` host is dropped.
 */
export function mockPathOf(url: string): { path: string; query: Record<string, string> } {
  let rest = url.trim();
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  rest = rest.replace(/^\{\{[^}]+\}\}/, '');
  if (!rest.startsWith('/') && !rest.startsWith('?')) rest = rest.replace(/^[^/?#]*/, '');
  const [p, q = ''] = rest.split('#')[0]!.split('?');
  const query: Record<string, string> = {};
  for (const part of q.split('&').filter(Boolean)) {
    const i = part.indexOf('=');
    const k = decodeURIComponent(i < 0 ? part : part.slice(0, i));
    query[k] = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
  }
  const path = '/' + (p ?? '').split('/').filter(Boolean).join('/');
  return { path, query };
}

/** Every saved example of a collection, as routes (requests without examples are skipped). */
export function collectMockRoutes(collection: Collection): MockRoute[] {
  const out: MockRoute[] = [];
  const walk = (nodes: CollectionNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'folder') walk(n.items);
      else if (n.kind === 'http' && n.examples?.length) for (const ex of n.examples) out.push(route(n, ex));
    }
  };
  walk(collection.items);
  return out;
}

function route(n: SavedHttpRequest, ex: SavedExample): MockRoute {
  const { path, query } = mockPathOf(ex.request?.url ?? n.request.url);
  return {
    method: (ex.request?.method ?? n.request.method ?? 'GET').toUpperCase(),
    path,
    query,
    body: ex.request?.body?.trim() ? ex.request.body : undefined,
    headers: ex.request?.headers?.filter((h) => h.key && h.enabled !== false).map((h) => ({ key: h.key, value: h.value })),
    requestId: n.id,
    requestName: n.name,
    example: ex,
  };
}

const isWild = (seg: string) => seg.startsWith(':') || /^\{\{[^}]+\}\}$/.test(seg) || seg === '*';

/** Segments that look like ids (`42`, a UUID, a long hex string) in a saved URL. */
const isIdLike = (seg: string) => /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{12,}$/i.test(seg);

/**
 * Score how well a route path matches a request path: -1 = no match; higher = more literal segments.
 * In `loose` mode, id-like literal segments in the pattern match any value (without scoring).
 */
function pathScore(pattern: string, actual: string, loose = false): number {
  const a = pattern.split('/').filter(Boolean);
  const b = actual.split('/').filter(Boolean);
  if (a.length !== b.length) return -1;
  let score = 0;
  for (let i = 0; i < a.length; i++) {
    if (isWild(a[i]!)) continue;
    if (decodeURIComponent(a[i]!).toLowerCase() === decodeURIComponent(b[i]!).toLowerCase()) score += 10;
    else if (!(loose && isIdLike(a[i]!))) return -1;
  }
  return score;
}

/**
 * Pick the example for a request, like Postman's mock servers:
 * 1. method and path must match (`:id` / `{{var}}` segments match anything; literal segments score higher);
 * 2. `x-mock-response-name` or `x-mock-response-code` headers select an example;
 * 3. otherwise matching query parameters and request bodies score higher, and 2xx examples win ties;
 * 4. `x-mock-match-request-body: true` only accepts examples whose saved body matches, and
 *    `x-mock-match-request-headers: a, b` only those whose saved headers a and b match.
 */
export function matchMockRoute(routes: MockRoute[], req: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string | string[] | undefined>; body?: string }): MockRoute | undefined {
  // exact paths first; then saved ids (`/patients/1`) also answer other ids (`/patients/7`)
  return pick(routes, req, false) ?? pick(routes, req, true);
}

function pick(routes: MockRoute[], req: Parameters<typeof matchMockRoute>[1], loose: boolean): MockRoute | undefined {
  const method = req.method.toUpperCase();
  const h = (k: string) => {
    const v = req.headers?.[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const wantName = h('x-mock-response-name');
  const wantCode = h('x-mock-response-code');
  const strictBody = /^(true|1|yes)$/i.test(h('x-mock-match-request-body') ?? '');
  const matchHeaders = (h('x-mock-match-request-headers') ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  let best: { r: MockRoute; score: number } | undefined;
  for (const r of routes) {
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    let score = pathScore(r.path, req.path, loose);
    if (score < 0) continue;
    if (wantName !== undefined) {
      if (r.example.name.toLowerCase() !== wantName.toLowerCase()) continue;
    } else if (wantCode !== undefined) {
      if (String(r.example.status) !== wantCode) continue;
    }
    const q = req.query ?? {};
    for (const [k, v] of Object.entries(r.query)) score += q[k] === v ? 3 : k in q ? 1 : -1;
    const body = bodyMatch(r.body, req.body);
    if (strictBody && body !== 'equal' && body !== 'subset' && !(body === 'none' && !req.body?.trim())) continue;
    score += body === 'equal' ? 6 : body === 'subset' ? 4 : body === 'differs' ? -3 : 0;
    if (matchHeaders.length) {
      const saved = new Map((r.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
      if (!matchHeaders.every((name) => saved.get(name) === h(name))) continue;
    }
    if (r.example.status >= 200 && r.example.status < 300) score += 1;
    if (!best || score > best.score) best = { r, score };
  }
  return best?.r;
}

export interface MockServerOptions {
  port?: number;
  /** Only loopback addresses are allowed: a mock server is a development tool. */
  host?: string;
  /** Extra delay before every response, in ms. */
  delayMs?: number;
  onRequest?: (e: {
    method: string;
    path: string;
    status: number;
    example?: string;
    request?: string;
    forwarded?: boolean;
    /** What came in and went out (the Debugger's Incoming tab): the query string, the headers, the bodies, the time. */
    query?: string;
    headers?: Record<string, string>;
    body?: string;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    ms?: number;
  }) => void;
  /** Forward requests that match no example to this API (partial mocking); without it they get a 404. */
  fallbackUrl?: string;
}

const FORWARD_SKIP = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|host|content-length|accept-encoding|content-encoding)$/i;

/** Send an unmatched request on to the real API and relay its answer. */
async function forward(base: string, req: IncomingMessage, body: string | undefined, res: ServerResponse, cors: Record<string, string>): Promise<number> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !FORWARD_SKIP.test(k)) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
  const method = (req.method ?? 'GET').toUpperCase();
  const upstream = await fetch(base.replace(/\/+$/, '') + (req.url ?? '/'), { method, headers, body: method === 'GET' || method === 'HEAD' || !body ? undefined : body, redirect: 'manual' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  const out: Record<string, string> = { ...cors, 'x-mock-forwarded': 'true', 'content-length': String(buf.length) };
  upstream.headers.forEach((v, k) => {
    if (!FORWARD_SKIP.test(k) && !k.startsWith('access-control-')) out[k] = v;
  });
  res.writeHead(upstream.status, upstream.statusText, out);
  res.end(method === 'HEAD' ? undefined : buf);
  return upstream.status;
}

export interface MockServer {
  url: string;
  port: number;
  routes: MockRoute[];
  /** Replace the routes (after the collection's examples change). */
  update(collection: Collection): void;
  close(): Promise<void>;
}

const HOP_HEADERS = /^(content-length|transfer-encoding|connection|keep-alive|content-encoding)$/i;

/** Serve a collection's saved examples over HTTP on localhost. */
/** How a request body compares with the body an example was saved with. */
export function bodyMatch(saved: string | undefined, actual: string | undefined): 'none' | 'equal' | 'subset' | 'differs' {
  if (saved === undefined) return 'none';
  if (actual === undefined || !actual.trim()) return 'differs';
  const parse = (s: string) => {
    try {
      return { ok: true as const, v: JSON.parse(s) as unknown };
    } catch {
      return { ok: false as const };
    }
  };
  const a = parse(saved);
  const b = parse(actual);
  if (a.ok && b.ok) {
    if (deepEqual(a.v, b.v)) return 'equal';
    return contains(b.v, a.v) ? 'subset' : 'differs';
  }
  // form bodies: same fields in any order
  const form = (s: string) => new URLSearchParams(s.trim()).toString().split('&').sort().join('&');
  if (/^[^=&\s]+=/.test(saved.trim()) && /^[^=&\s]+=/.test(actual.trim())) return form(saved) === form(actual) ? 'equal' : 'differs';
  return saved.trim() === actual.trim() ? 'equal' : 'differs';
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Every field of `part` is in `whole` with the same value (objects recursively; arrays must be equal). */
function contains(whole: unknown, part: unknown): boolean {
  if (typeof part !== 'object' || part === null || Array.isArray(part)) return deepEqual(whole, part);
  if (typeof whole !== 'object' || whole === null || Array.isArray(whole)) return false;
  return Object.entries(part).every(([k, v]) => k in whole && contains((whole as Record<string, unknown>)[k], v));
}

const MAX_MATCH_BODY = 1024 * 1024;

/** Read the request body for matching (up to 1 MB; the rest is drained). */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    req.resume();
    return Promise.resolve(undefined);
  }
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      if (size < MAX_MATCH_BODY) chunks.push(c);
      size += c.length;
    });
    req.on('end', () => ok(Buffer.concat(chunks).subarray(0, MAX_MATCH_BODY).toString('utf8')));
    req.on('error', () => ok(undefined));
  });
}

/**
 * Dynamic variables in a saved example (`{{$randomFirstName}}`, `{{$guid}}`, `{{$timestamp}}` …) get a
 * fresh value on every response, like Postman's mock servers. Other `{{…}}` text is left as it is.
 */
export function fillDynamic(text: string): string {
  if (!text.includes('{{')) return text;
  return text.replace(/\{\{\s*(\$[\w.]+(?:\([^)]*\))?)\s*\}\}/g, (m, name: string) => {
    const v = dynamicValue(name);
    return v === undefined ? m : String(v);
  });
}

export async function startMockServer(collection: Collection, opts: MockServerOptions = {}): Promise<MockServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOCAL_HOSTS.has(host)) throw new ApsError('ConfigurationError', `The mock server only listens on localhost, not ${host}`);
  let routes = collectMockRoutes(collection);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://mock');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, cors);
      return res.end();
    }
    const t0 = Date.now();
    const query = Object.fromEntries(u.searchParams);
    const body = await readBody(req);
    const flatHeaders = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
    const seen = { method: req.method ?? 'GET', path: u.pathname, query: u.search, headers: flatHeaders, ...(body ? { body } : {}) };
    const r = matchMockRoute(routes, { method: req.method ?? 'GET', path: u.pathname, query, headers: req.headers, body });
    if (opts.delayMs) await new Promise((ok) => setTimeout(ok, opts.delayMs));
    if (!r && opts.fallbackUrl) {
      try {
        const status = await forward(opts.fallbackUrl, req, body, res, cors);
        opts.onRequest?.({ ...seen, status, forwarded: true, ms: Date.now() - t0 });
      } catch (e) {
        if (!res.headersSent) res.writeHead(502, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'fallback_failed', message: (e as Error).message, fallback: opts.fallbackUrl }));
        opts.onRequest?.({ ...seen, status: 502, forwarded: true, ms: Date.now() - t0 });
      }
      return;
    }
    if (!r) {
      const body = JSON.stringify(
        {
          error: 'no_matching_example',
          message: `No saved example matches ${req.method} ${u.pathname}`,
          available: routes.map((x) => `${x.method} ${x.path} → ${x.example.status} ${x.example.name}`),
        },
        null,
        2,
      );
      res.writeHead(404, { ...cors, 'content-type': 'application/json', 'x-mock-match': 'none' });
      res.end(body);
      opts.onRequest?.({ ...seen, status: 404, responseHeaders: { 'content-type': 'application/json' }, responseBody: body, ms: Date.now() - t0 });
      return;
    }
    const headers: Record<string, string> = { ...cors, 'x-mock-example': encodeURIComponent(r.example.name) };
    for (const { key, value } of r.example.headers) if (key && !HOP_HEADERS.test(key)) headers[key.toLowerCase()] = fillDynamic(value);
    res.writeHead(r.example.status, r.example.statusText || undefined, headers);
    const sent = req.method === 'HEAD' ? undefined : fillDynamic(r.example.body);
    res.end(sent);
    opts.onRequest?.({ ...seen, status: r.example.status, example: r.example.name, request: r.requestName, responseHeaders: headers, ...(sent ? { responseBody: sent } : {}), ms: Date.now() - t0 });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new ApsError('ConfigurationError', `Port ${opts.port} is already in use`, { suggestions: ['Pick another port, or 0 for any free port.'] }) : e),
    );
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const mock: MockServer = {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    get routes() {
      return routes;
    },
    update(c) {
      routes = collectMockRoutes(c);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return mock;
}
