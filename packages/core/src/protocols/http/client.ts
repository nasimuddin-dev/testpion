import { assertUrlAllowed, getNetworkPolicy } from '../../net/policy.js';
import { ENGINE_VERSION } from '../../version.js';
import { baseDispatcher, makeDispatcher, proxyGeneration } from '../../net/proxy.js';
import { createWriteStream, openAsBlob, readFileSync, mkdirSync, type WriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { subscribe } from 'node:diagnostics_channel';
import { STATUS_CODES } from 'node:http';
import { endAndClose } from '../../storage/fsutil.js';
import { fetch as undiciFetch, FormData as UndiciFormData, type Dispatcher } from 'undici';
import type { BodyConfig, HttpRequestSpec, HttpResponseData, KeyValue, TimelinePhase } from '../../model/types.js';
import { ApsError, normalizeError } from '../../errors.js';
import { applyAuth, type AuthContext } from './auth.js';
import { digestAuthorization, parseDigestChallenge, signAwsV4, signOAuth1 } from './signing.js';
import { isEventStream, SseParser, type SseEvent } from './sse.js';
import { watchSend } from './socket-timing.js';

/** Events kept per SSE response (the stream itself can be endless). */
const MAX_SSE_EVENTS = 10_000;
import type { Redactor } from '../../util/redact.js';
import { shortId } from '../../util/ids.js';
import type { CookieJar } from '../../cookies/cookie-jar.js';

export const DEFAULT_MAX_PREVIEW = 2 * 1024 * 1024;

export interface HttpExecOptions extends AuthContext {
  signal?: AbortSignal;
  /** When set, the full response body is streamed to a file in this directory. */
  payloadDir?: string;
  maxPreviewBytes?: number;
  /** Receives decoded chunks while the body streams (SSE, chunked responses). */
  onChunk?: (chunk: string) => void;
  /** Called once the final response's status and headers have arrived, before the body is read. */
  onResponseStart?: (status: number, headers: Headers) => void;
  /** Receives each Server-Sent Event as it arrives (text/event-stream responses). */
  onSseEvent?: (event: SseEvent) => void;
  redactor?: Redactor;
  /** Skip body preview decoding entirely (load testing). */
  discardBody?: boolean;
  /** Workspace cookie jar: matching cookies are sent and Set-Cookie responses stored (also across redirects). */
  cookieJar?: CookieJar;
}

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  bodyPreview?: string;
}

const dispatchers = new Map<string, Dispatcher>();

// the protocol each connection negotiated (ALPN), by origin: how an HTTP/2 response is recognised
const alpnByOrigin = new Map<string, string>();
subscribe('undici:client:connected', (message) => {
  const m = message as { connectParams?: { protocol?: string; host?: string }; socket?: { alpnProtocol?: string | false } };
  if (!m.connectParams?.host || m.connectParams.protocol !== 'https:') return;
  if (alpnByOrigin.size > 500) alpnByOrigin.clear();
  const origin = `https://${m.connectParams.host}`;
  // an HTTP/1.1-only request's connection doesn't mean the server lost HTTP/2
  if (alpnByOrigin.get(origin) === 'h2' && m.socket?.alpnProtocol !== 'h2') return;
  alpnByOrigin.set(origin, m.socket?.alpnProtocol || 'http/1.1');
});

/** Reuse connection pools per TLS / proxy / HTTP version configuration (the app-wide proxy settings apply; see net/proxy.ts). */
function dispatcherFor(spec: HttpRequestSpec): Dispatcher | undefined {
  const s = spec.settings ?? {};
  if (!s.insecure && !s.proxy && !s.clientCert && !s.http1Only && !s.tlsMinVersion && !s.tlsMaxVersion && !s.ciphers?.trim()) return baseDispatcher();
  const key = JSON.stringify([proxyGeneration(), s.insecure, s.proxy, s.clientCert, !!s.http1Only, s.tlsMinVersion, s.tlsMaxVersion, s.ciphers?.trim()]);
  let d = dispatchers.get(key);
  if (!d) {
    const connect: Record<string, unknown> = {};
    if (s.insecure) connect.rejectUnauthorized = false;
    if (s.tlsMinVersion) connect.minVersion = s.tlsMinVersion;
    if (s.tlsMaxVersion) connect.maxVersion = s.tlsMaxVersion;
    if (s.ciphers?.trim()) connect.ciphers = s.ciphers.trim();
    if (s.clientCert) {
      connect.cert = readFileSync(s.clientCert.certPath);
      connect.key = readFileSync(s.clientCert.keyPath);
      if (s.clientCert.caPath) connect.ca = readFileSync(s.clientCert.caPath);
      if (s.clientCert.passphrase) connect.passphrase = s.clientCert.passphrase;
    }
    d = makeDispatcher(connect, s.proxy, s.http1Only ? { allowH2: false } : {});
    dispatchers.set(key, d);
  }
  return d;
}

/** Names of `:name` path segments in a URL, e.g. `/users/:id/posts/:postId` → ["id", "postId"]. */
export { pathVariableNames } from '@testpion/shared';

/** Replace `/:name` path segments with their (URL-encoded) values. Unknown names are left as-is. */
export function applyPathVariables(url: string, vars?: KeyValue[], encode = true): string {
  if (!vars?.length) return url;
  const map = new Map(vars.filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value]));
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/i.exec(url)!;
  const [head = '', rest = ''] = [m[1], m[2]];
  const q = rest.search(/[?#]/);
  const path = q >= 0 ? rest.slice(0, q) : rest;
  const tail = q >= 0 ? rest.slice(q) : '';
  return head + path.replace(/\/:([A-Za-z_][\w-]*)/g, (whole, name: string) => (map.has(name) ? '/' + (encode ? encodeURIComponent(map.get(name)!) : map.get(name)!) : whole)) + tail;
}

export function buildUrl(raw: string, params?: KeyValue[], pathVariables?: KeyValue[], opts: { encode?: boolean } = {}): URL {
  const encode = opts.encode !== false;
  let s = applyPathVariables(raw.trim(), pathVariables, encode);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ApsError('ConfigurationError', `Invalid URL: ${raw}`, {
      suggestions: ['Check for unresolved {{variables}} in the URL.', 'Make sure the selected environment defines the base URL.'],
    });
  }
  const on = (params ?? []).filter((p) => p.enabled !== false && p.key);
  if (encode) for (const p of on) url.searchParams.append(p.key, p.value);
  // as typed: the URL parser still escapes what can't be sent (spaces, non-ASCII) but keeps + / ? = & etc.
  else if (on.length) url.search = [url.search.replace(/^\?/, ''), ...on.map((p) => `${p.key}=${p.value}`)].filter(Boolean).join('&');
  return url;
}

async function buildBody(body: BodyConfig | undefined, headers: Headers): Promise<{ body?: unknown; preview?: string }> {
  if (!body || body.type === 'none') return {};
  const setCT = (ct: string) => {
    if (!headers.has('content-type')) headers.set('content-type', ct);
  };
  switch (body.type) {
    case 'json':
      setCT('application/json');
      return { body: body.content, preview: body.content };
    case 'xml':
      setCT('application/xml');
      return { body: body.content, preview: body.content };
    case 'html':
      setCT('text/html');
      return { body: body.content, preview: body.content };
    case 'text':
      setCT('text/plain');
      return { body: body.content, preview: body.content };
    case 'form-urlencoded': {
      const f = new URLSearchParams();
      for (const kv of body.fields) if (kv.enabled !== false && kv.key) f.append(kv.key, kv.value);
      setCT('application/x-www-form-urlencoded');
      const s = f.toString();
      return { body: s, preview: s };
    }
    case 'multipart': {
      const fd = new UndiciFormData();
      const preview: string[] = [];
      for (const f of body.fields) {
        if (f.enabled === false || !f.key) continue;
        if (f.kind === 'file') {
          const blob = await openAsBlob(f.value, { type: f.contentType });
          fd.append(f.key, blob, basename(f.value));
          preview.push(`${f.key}=@${basename(f.value)} (${blob.size} bytes)`);
        } else {
          fd.append(f.key, f.value);
          preview.push(`${f.key}=${f.value}`);
        }
      }
      // content-type with boundary is set by fetch
      headers.delete('content-type');
      return { body: fd, preview: preview.join('\n') };
    }
    case 'binary': {
      const blob = await openAsBlob(body.filePath);
      setCT(body.contentType ?? 'application/octet-stream');
      return { body: blob, preview: `<binary ${basename(body.filePath)} ${blob.size} bytes>` };
    }
  }
}

function parseSetCookie(h: string): { name: string; value: string; attributes: Record<string, string> } {
  const [pair, ...attrs] = h.split(';');
  const eq = (pair ?? '').indexOf('=');
  const attributes: Record<string, string> = {};
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim();
    if (k) attributes[k] = i < 0 ? 'true' : a.slice(i + 1).trim();
  }
  return { name: (pair ?? '').slice(0, eq).trim(), value: (pair ?? '').slice(eq + 1).trim(), attributes };
}

/**
 * Prepare a request without sending it (used for "code snippet"/preview and by the executor).
 * The spec must already have variables resolved.
 */
export async function prepareHttpRequest(spec: HttpRequestSpec, opts: HttpExecOptions = {}) {
  const url = buildUrl(spec.url, spec.params, spec.pathVariables, { encode: spec.settings?.encodeUrl });
  const headers = new Headers();
  for (const h of spec.headers ?? []) if (h.enabled !== false && h.key) headers.append(h.key, h.value);
  const cookies = (spec.cookies ?? []).filter((c) => c.enabled !== false && c.key).map((c) => `${c.key}=${c.value}`);
  if (cookies.length) headers.set('cookie', [headers.get('cookie'), ...cookies].filter(Boolean).join('; '));
  // the request's own cookies win over jar cookies with the same name
  const explicitCookie = headers.get('cookie') ?? undefined;
  if (opts.cookieJar) setJarCookies(headers, opts.cookieJar, url, explicitCookie);
  if (!headers.has('user-agent')) headers.set('user-agent', `TestPion/${ENGINE_VERSION}`);
  if (!headers.has('accept')) headers.set('accept', '*/*');
  await applyAuth(spec.auth, headers, url, opts);
  const { body, preview } = await buildBody(spec.body, headers);
  const method = (spec.method || 'GET').toUpperCase();
  const sent = method === 'GET' || method === 'HEAD' ? undefined : body;
  if (spec.auth?.type === 'oauth1') {
    signOAuth1(method, url, headers, sent, spec.auth);
    opts.redactor?.addSecret(headers.get('authorization') ?? undefined);
  }
  if (spec.auth?.type === 'awsv4') {
    signAwsV4(method, url, headers, sent, spec.auth);
    opts.redactor?.addSecret(headers.get('authorization') ?? undefined);
  }
  return { url, headers, body: sent, bodyPreview: preview, method, explicitCookie };
}

function setJarCookies(headers: Headers, jar: CookieJar, url: URL, explicitCookie: string | undefined): void {
  const own = new Set((explicitCookie ?? '').split(/;\s*/).map((p) => p.slice(0, Math.max(0, p.indexOf('='))).trim()).filter(Boolean));
  const value = [explicitCookie, jar.headerFor(url, own)].filter(Boolean).join('; ');
  if (value) headers.set('cookie', value);
  else headers.delete('cookie');
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** Execute an HTTP request, streaming the response with bounded memory. */
export async function executeHttp(spec: HttpRequestSpec, opts: HttpExecOptions = {}): Promise<{ response: HttpResponseData; prepared: PreparedRequest }> {
  if (spec.settings?.disableCookieJar && opts.cookieJar) opts = { ...opts, cookieJar: undefined };
  const retries = Math.max(0, Math.min(5, Math.floor(spec.settings?.retries ?? 0)));
  if (!retries) return executeHttpOnce(spec, opts);
  const method = (spec.method || 'GET').toUpperCase();
  const safe = !['POST', 'PATCH'].includes(method);
  const base = Math.max(0, spec.settings?.retryDelayMs ?? 500);
  const wait = (attempt: number, retryAfter?: string | null) => {
    const ra = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : NaN;
    const ms = Math.min(10_000, Number.isFinite(ra) && ra >= 0 ? ra : base * 2 ** attempt);
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      opts.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new ApsError('CancelledError', 'Request cancelled'))), { once: true });
    });
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await executeHttpOnce(spec, opts);
      const retryable = safe && (r.response.status === 429 || r.response.status >= 500);
      if (retryable && attempt < retries) {
        await wait(attempt, r.response.headers.find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        continue;
      }
      r.response.attempts = attempt + 1;
      return r;
    } catch (e) {
      const kind = normalizeError(e).kind;
      if (opts.signal?.aborted || attempt >= retries) throw e;
      // a refused / reset connection never reached the server; a timeout might have, so only safe methods retry it
      const retryable = kind === 'NetworkError' || (safe && kind === 'TimeoutError');
      if (!retryable) throw e;
      await wait(attempt);
    }
  }
}

async function executeHttpOnce(spec: HttpRequestSpec, opts: HttpExecOptions = {}): Promise<{ response: HttpResponseData; prepared: PreparedRequest }> {
  const t0 = performance.now();
  const timeline: TimelinePhase[] = [];
  const mark = (name: string, start: number) => timeline.push({ name, startMs: round(start - t0), durationMs: round(performance.now() - start) });

  const { url, headers, body, bodyPreview, method, explicitCookie } = await prepareHttpRequest(spec, opts);
  mark('prepare', t0);
  const redact = (s: string) => opts.redactor?.redactUrl(s) ?? s;
  const prepared: PreparedRequest = {
    method,
    url: redact(url.toString()),
    headers: [...headers.entries()].map(([k, v]) => [k, v] as [string, string]),
    bodyPreview: bodyPreview && bodyPreview.length > 64 * 1024 ? bodyPreview.slice(0, 64 * 1024) + '…' : bodyPreview,
  };
  if (opts.redactor) prepared.headers = opts.redactor.redact(prepared.headers);

  const s = spec.settings ?? {};
  const jar = opts.cookieJar;
  const follow = s.followRedirects !== false;
  const tSend = performance.now();
  // With a cookie jar, redirects are followed here so cookies set by each hop (login flows) are kept.
  let current = url;
  let curMethod = method;
  let curBody = body;
  let hops = 0;
  let digestAnswered = false;
  let res;
  // with private networks blocked, every redirect hop is checked here (not followed inside undici)
  const guarded = getNetworkPolicy().blockPrivateNetworks;
  // Postman's redirect options are applied hop by hop, so redirects are followed here when one is set
  const custom = !!(s.followOriginalMethod || s.followAuthorizationHeader || s.removeRefererOnRedirect);
  // the connection the (first) request goes over: DNS, TCP and TLS phases when it is a new one
  const watch = watchSend(url, method);
  for (;;) {
    await assertUrlAllowed(current);
    res = await undiciFetch(current, {
      method: curMethod,
      headers: headers as unknown as Record<string, string>,
      body: curBody as never,
      redirect: follow && !jar && !guarded && !custom ? 'follow' : 'manual',
      signal: opts.signal,
      dispatcher: dispatcherFor(spec),
      // duplex is required by undici for streamed (Blob/FormData) bodies
      ...({ duplex: 'half' } as object),
    });
    // Digest: answer the server's challenge once, on the same URL
    if (spec.auth?.type === 'digest' && res.status === 401 && !digestAnswered) {
      const challenge = parseDigestChallenge(res.headers.get('www-authenticate'));
      if (challenge) {
        digestAnswered = true;
        jar?.storeFromResponse(current, res.headers.getSetCookie());
        await res.body?.cancel().catch(() => undefined);
        const answer = digestAuthorization(challenge, { username: spec.auth.username, password: spec.auth.password, method: curMethod, uri: current.pathname + current.search });
        opts.redactor?.addSecret(answer);
        headers.set('authorization', answer);
        continue;
      }
    }
    if (!jar && !(follow && (guarded || custom))) break;
    jar?.storeFromResponse(current, res.headers.getSetCookie());
    const location = res.headers.get('location');
    if (!follow || !REDIRECT_CODES.has(res.status) || !location || hops >= (s.maxRedirects ?? 20)) break;
    await res.body?.cancel().catch(() => undefined);
    const next = new URL(location, current);
    if (res.status === 303 ? curMethod !== 'HEAD' : (res.status === 301 || res.status === 302) && curMethod === 'POST' && !s.followOriginalMethod) {
      curMethod = curMethod === 'HEAD' ? 'HEAD' : 'GET';
      curBody = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    // credentials don't follow a redirect to another origin (unless the request says so)
    if (next.origin !== current.origin && !s.followAuthorizationHeader) headers.delete('authorization');
    if (s.removeRefererOnRedirect) headers.delete('referer');
    current = next;
    hops++;
    if (jar) setJarCookies(headers, jar, current, explicitCookie);
  }
  const sent = watch.result();
  watch.stop();
  let connection: HttpResponseData['connection'];
  if (sent) {
    const t = sent.times;
    // a socket opened after the request started is this request's own new connection
    const fresh = !!t && t.created >= tSend - 1;
    if (fresh) {
      const phase = (name: string, from: number, to?: number) => to !== undefined && timeline.push({ name, startMs: round(from - t0), durationMs: round(to - from) });
      phase('DNS lookup', t.created, t.lookup);
      phase('TCP connect', t.lookup ?? t.created, t.connect);
      if (t.connect !== undefined) phase('TLS handshake', t.connect, t.secure);
    }
    connection = { reused: !fresh, remoteAddress: sent.remoteAddress, remotePort: sent.remotePort, tlsProtocol: sent.tlsProtocol, cipher: sent.cipher, certificate: sent.certificate };
    timeline.push({ name: 'waiting (TTFB)', startMs: round(sent.sentAt - t0), durationMs: round(performance.now() - sent.sentAt) });
  } else mark('waiting (TTFB)', tSend);
  opts.onResponseStart?.(res.status, res.headers);

  const tDown = performance.now();
  const maxPreview = opts.maxPreviewBytes ?? s.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW;
  const chunks: Buffer[] = [];
  let kept = 0;
  let size = 0;
  let file: WriteStream | undefined;
  let payloadPath: string | undefined;
  const decoder = opts.onChunk ? new TextDecoder() : undefined;
  // Server-Sent Events: parsed as they arrive; stopping the request keeps the events received so far
  const sse = !opts.discardBody && isEventStream(res.headers.get('content-type')) ? { parser: new SseParser(), decoder: new TextDecoder(), events: [] as SseEvent[], total: 0 } : undefined;
  let streamStopped = false;

  if (res.body && method !== 'HEAD') {
    const reader = res.body.getReader();
    try {
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch (e) {
          if (sse && opts.signal?.aborted) {
            streamStopped = true;
            break;
          }
          throw e;
        }
        const { done, value } = step;
        if (done) break;
        if (sse) {
          const atMs = round(performance.now() - t0);
          for (const ev of sse.parser.push(sse.decoder.decode(value, { stream: true }), atMs)) {
            sse.total++;
            if (sse.events.length < MAX_SSE_EVENTS) sse.events.push(ev);
            opts.onSseEvent?.(ev);
          }
        }
        size += value.byteLength;
        if (opts.discardBody) continue;
        if (kept < maxPreview) {
          const take = Math.min(value.byteLength, maxPreview - kept);
          chunks.push(Buffer.from(value.buffer, value.byteOffset, take));
          kept += take;
        }
        if (opts.payloadDir) {
          if (!file) {
            mkdirSync(opts.payloadDir, { recursive: true });
            payloadPath = join(opts.payloadDir, `${shortId('resp-')}.bin`);
            file = createWriteStream(payloadPath);
          }
          if (!file.write(value)) await new Promise<void>((r) => file!.once('drain', () => r()));
        }
        if (decoder) opts.onChunk!(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
      if (file) await endAndClose(file);
    }
  }
  mark('download', tDown);
  const durationMs = round(performance.now() - t0);
  timeline.push({ name: 'total', startMs: 0, durationMs });

  const truncated = size > kept;
  const bodyBuf = Buffer.concat(chunks);
  const contentType = res.headers.get('content-type') ?? '';
  let bodyPreviewText = opts.discardBody ? '' : decodeBody(bodyBuf, contentType);
  if (truncated) bodyPreviewText = trimToCharBoundary(bodyPreviewText);
  let json: unknown;
  if (!truncated && bodyPreviewText && /json|\+json/i.test(contentType)) {
    try {
      json = JSON.parse(bodyPreviewText);
    } catch {
      /* not json */
    }
  } else if (!truncated && bodyPreviewText && /^\s*[[{]/.test(bodyPreviewText)) {
    try {
      json = JSON.parse(bodyPreviewText);
    } catch {
      /* not json */
    }
  }

  const response: HttpResponseData = {
    status: res.status,
    // HTTP/2 has no reason phrase: use the standard one
    statusText: res.statusText || STATUS_CODES[res.status] || '',
    headers: [...res.headers.entries()].map(([k, v]) => [k, v] as [string, string]),
    cookies: res.headers.getSetCookie().map(parseSetCookie),
    bodyPreview: bodyPreviewText,
    truncated,
    size,
    contentType,
    payloadPath,
    durationMs,
    timeline,
    connection,
    url: redact(hops ? current.toString() : res.url || url.toString()),
    redirected: hops > 0 || res.redirected,
    httpVersion: !s.http1Only && alpnByOrigin.get(new URL(res.url || current.toString()).origin) === 'h2' ? '2' : '1.1',
    json,
  };
  if (sse) {
    response.events = sse.events;
    if (sse.total > sse.events.length) response.eventsDropped = sse.total - sse.events.length;
  }
  if (streamStopped) response.streamStopped = true;
  return { response, prepared };
}

function decodeBody(buf: Buffer, contentType: string): string {
  if (!buf.length) return '';
  if (/image\/|audio\/|video\/|octet-stream|application\/(zip|pdf|gzip)/i.test(contentType) || looksBinary(buf))
    return `<binary data ${buf.length} bytes — use "Save response" to download>`;
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().toLowerCase();
  try {
    return new TextDecoder(charset && charset !== 'utf8' ? charset : 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 512);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i]!;
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl / n > 0.1;
}

function trimToCharBoundary(s: string): string {
  return s.endsWith('�') ? s.slice(0, -1) : s;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Generate a cURL command for a prepared request (secrets already redacted). */
/** Where a response's time went, in ms per phase (DNS / TCP / TLS only on a new connection), for agents and scripts. */
export function timingSummary(r: Pick<HttpResponseData, 'timeline' | 'connection' | 'durationMs'>): { dnsMs?: number; tcpMs?: number; tlsMs?: number; ttfbMs?: number; downloadMs?: number; totalMs: number; reusedConnection?: boolean; tlsProtocol?: string; certificateDaysLeft?: number } {
  const ms = (name: string) => r.timeline?.find((p) => p.name === name)?.durationMs;
  const out = { dnsMs: ms('DNS lookup'), tcpMs: ms('TCP connect'), tlsMs: ms('TLS handshake'), ttfbMs: ms('waiting (TTFB)'), downloadMs: ms('download'), totalMs: r.durationMs, reusedConnection: r.connection?.reused, tlsProtocol: r.connection?.tlsProtocol, certificateDaysLeft: r.connection?.certificate?.daysLeft };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as typeof out;
}
