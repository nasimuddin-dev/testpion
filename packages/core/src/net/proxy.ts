import type { Dispatcher } from 'undici';
import { EventEmitter } from 'node:events';
import { Agent as HttpAgent, request as httpRequest, type AgentOptions, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import * as tls from 'node:tls';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { policyLookup } from './policy.js';

/**
 * Outbound proxy for everything the engine sends over HTTP (requests, tp.sendRequest, OAuth token
 * calls, AI providers, MCP over HTTP, remote datasets, WebSocket and Socket.IO handshakes):
 * - `env` (default): the standard HTTP_PROXY / HTTPS_PROXY / NO_PROXY variables, as curl and most CLIs do;
 * - `custom`: one proxy URL (optionally with a user name and password) and a bypass list;
 * - `off`: connect directly, even when the variables are set.
 * A request's own proxy setting wins over this. gRPC is not covered (grpc-js reads the same
 * environment variables itself).
 */
export interface ProxySettings {
  mode: 'env' | 'custom' | 'off';
  /** custom: http://host:port (https:// proxies work too). */
  url?: string;
  /** custom: hosts that go direct, comma separated, like NO_PROXY: `localhost, .internal.example, 10.0.0.1`. */
  bypass?: string;
  /** custom: proxy user name; the password is passed separately (it lives in the secret store). */
  username?: string;
  password?: string;
}

let settings: ProxySettings = { mode: 'env' };
let generation = 0;
let base: Dispatcher | undefined;
let wsBase: Dispatcher | undefined;

/*
 * undici loads with the first request, not at start-up (its module body is a noticeable part of starting the app):
 * the settings are kept, and applied (the global dispatcher, which global `fetch` uses too) once it has loaded, a
 * moment after start or at the first request, whichever comes first. `ensureProxyApplied` waits for that.
 */
type Undici = typeof import('undici');
let undici: Undici | undefined;
let loading: Promise<Undici> | undefined;
/** How long after the settings are first set undici loads by itself (when no request asked for it before). */
const LOAD_DELAY_MS = 1500;
let loadTimer: ReturnType<typeof setTimeout> | undefined;

function loadUndici(): Promise<Undici> {
  clearTimeout(loadTimer);
  return (loading ??= import('undici').then((m) => {
    undici = m;
    m.setGlobalDispatcher(baseDispatcher());
    return m;
  }));
}

/** Load undici and apply the proxy and certificate settings (global `fetch` follows them from then on). */
export async function ensureProxyApplied(): Promise<void> {
  await loadUndici();
}

/**
 * A dispatcher made once undici has loaded: right away when it has, else one that passes every request on to it as
 * soon as it is there (a request asks for its dispatcher before it is sent; this costs it a microtask, once).
 */
function whenLoaded(make: (u: Undici) => Dispatcher): Dispatcher {
  if (undici) return make(undici);
  let real: Dispatcher | undefined;
  const ready = loadUndici().then((u) => (real = make(u)));
  const lazy = Object.assign(new EventEmitter(), {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      if (real) return real.dispatch(opts, handler);
      void ready.then(
        (d) => d.dispatch(opts, handler),
        (e: Error) => (handler as { onError?(e: Error): void }).onError?.(e),
      );
      return true;
    },
    close: () => ready.then((d) => d.close()),
    destroy: (err?: Error) => ready.then((d) => d.destroy(err ?? null)),
  });
  return lazy as unknown as Dispatcher;
}

const withAuth = (url: string, username?: string, password?: string) => {
  if (!username) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(password ?? '');
  return u.toString();
};

/** Proxy options for undici's EnvHttpProxyAgent (undefined keys fall back to the environment). */
function proxyOptions(): { httpProxy?: string; httpsProxy?: string; noProxy?: string } {
  if (settings.mode !== 'custom' || !settings.url?.trim()) return {};
  const uri = withAuth(settings.url.trim(), settings.username, settings.password);
  // with a custom proxy, NO_PROXY from the environment must not apply: the bypass list replaces it
  return { httpProxy: uri, httpsProxy: uri, noProxy: settings.bypass?.trim() || '' };
}

/**
 * A dispatcher for these TLS / connect options that honours the proxy settings (a per-request proxy
 * overrides them). The SSRF guard (`policyLookup`) always applies to direct connections.
 */
export function makeDispatcher(connect: Record<string, unknown> = {}, requestProxy?: string, pool: Record<string, unknown> = {}): Dispatcher {
  const ca = trustedCa();
  // a request's own CA (client certificate settings) wins over the trusted set
  const c = { lookup: policyLookup, ...(ca ? { ca } : {}), ...connect };
  const mode = settings.mode;
  const options = proxyOptions();
  return whenLoaded(({ Agent, EnvHttpProxyAgent, ProxyAgent }) => {
    if (requestProxy) return new ProxyAgent({ uri: requestProxy, connect: c, requestTls: c as never, ...pool });
    if (mode === 'off') return new Agent({ connect: c as never, ...pool });
    return new EnvHttpProxyAgent({ ...options, connect: c as never, requestTls: c as never, ...pool } as never);
  });
}

/** The shared dispatcher for requests with default TLS settings (also used by global `fetch`). */
export function baseDispatcher(): Dispatcher {
  return (base ??= makeDispatcher({}, undefined, { connections: 256, pipelining: 1, keepAliveTimeout: 10_000 }));
}

/** For WebSocket handshakes: always a CONNECT tunnel through the proxy (proxies can't forward a ws:// upgrade otherwise). */
export function websocketDispatcher(): Dispatcher {
  return (wsBase ??= makeDispatcher({}, undefined, { proxyTunnel: true }));
}

/** Changes whenever the proxy settings change, so callers can drop cached dispatchers. */
export function proxyGeneration(): number {
  return generation;
}

export function getProxySettings(): ProxySettings {
  return { ...settings, password: settings.password ? '••••' : undefined };
}

/** Apply new proxy settings (the app's Settings, or the CLI's defaults). Global `fetch` follows them too. */
export function setProxySettings(p: ProxySettings): void {
  if (p.mode === 'custom' && p.url) {
    // throws on a malformed URL before anything changes
    const u = new URL(p.url);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(`The proxy URL must be http:// or https:// with a host: ${p.url}`);
  }
  settings = { ...p };
  rebuild();
}

function rebuild(): void {
  generation++;
  const old = [base, wsBase];
  base = wsBase = undefined;
  if (undici) undici.setGlobalDispatcher(baseDispatcher());
  else if (!loading && !loadTimer) {
    // not loaded yet: a moment after start (a request before that loads it itself)
    loadTimer = setTimeout(() => void loadUndici().catch(() => undefined), LOAD_DELAY_MS);
    (loadTimer as { unref?(): void }).unref?.();
  }
  for (const d of old) void d?.close().catch(() => undefined);
}

/* ------------------------------------------------------------------ trusted certificates */

/**
 * Which certificate authorities HTTPS connections trust, besides Node's built-in list: the operating
 * system's store (where corporate root certificates usually are, e.g. for a TLS-inspecting proxy) and
 * extra CA certificates (PEM). Applies wherever the proxy settings apply.
 */
export interface TlsTrust {
  /** Also trust the operating system's certificate store. */
  systemCa?: boolean;
  /** Extra CA certificates, PEM (one or more). */
  extraCa?: string;
}

let trust: TlsTrust = {};
let caList: string[] | undefined;

const splitPem = (pem = '') => pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];

function systemCertificates(): string[] {
  const get = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  try {
    return get?.('system') ?? [];
  } catch {
    return [];
  }
}

/** The CA list to use, or undefined for Node's default (nothing extra configured). */
export function trustedCa(): string[] | undefined {
  if (!trust.systemCa && !splitPem(trust.extraCa).length) return undefined;
  return (caList ??= [...tls.rootCertificates, ...(trust.systemCa ? systemCertificates() : []), ...splitPem(trust.extraCa)]);
}

/** Validate PEM certificates (throws on a malformed one) and apply the trust settings. */
export function setTlsTrust(t: TlsTrust): void {
  describeCertificates(t.extraCa ?? '');
  trust = { ...t };
  caList = undefined;
  rebuild();
}

export function getTlsTrust(): TlsTrust & { systemCertificates: number } {
  return { ...trust, systemCertificates: trust.systemCa ? systemCertificates().length : 0 };
}

/** What a PEM bundle holds: subject, issuer, expiry (for the UI and for validation). */
export function describeCertificates(pem: string): Array<{ subject: string; issuer: string; validTo: string; expired: boolean; ca: boolean; fingerprint: string }> {
  return splitPem(pem).map((block, i) => {
    let c: X509Certificate;
    try {
      c = new X509Certificate(block);
    } catch (e) {
      throw new Error(`Certificate ${i + 1} is not a valid PEM certificate: ${(e as Error).message}`);
    }
    const cn = (dn: string) => /CN=([^\n,]+)/.exec(dn)?.[1] ?? dn.split('\n')[0] ?? dn;
    return { subject: cn(c.subject), issuer: cn(c.issuer), validTo: new Date(c.validTo).toISOString(), expired: Date.parse(c.validTo) < Date.now(), ca: c.ca, fingerprint: c.fingerprint256 };
  });
}

/** Which proxy a URL would use under the current settings (for the UI, `testpion` diagnostics and tests). */
export function proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (settings.mode === 'off') return undefined;
  const u = new URL(url);
  const custom = settings.mode === 'custom' && settings.url?.trim();
  const proxy = custom ? settings.url!.trim() : u.protocol === 'https:' ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy : env.HTTP_PROXY ?? env.http_proxy;
  if (!proxy) return undefined;
  const noProxy = (custom ? settings.bypass : env.NO_PROXY ?? env.no_proxy) ?? '';
  return bypassed(u, noProxy) ? undefined : proxy;
}

/** NO_PROXY rules: `*`, host names (also matching subdomains), `.suffix`, host:port, IP addresses. */
export function bypassed(u: URL, noProxy: string): boolean {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return noProxy
    .split(/[,\s]+/)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule === '*') return true;
      const [h, p] = rule.startsWith('[') ? [rule.slice(1, rule.indexOf(']')), rule.split(']:')[1]] : rule.split(':');
      if (p && p !== port) return false;
      const name = h!.replace(/^\*?\./, '');
      return host === name || host.endsWith(`.${name}`);
    });
}

/** The proxy URL for a target, with the custom proxy's credentials (for clients that aren't undici). */
function proxyUriFor(url: string): string | undefined {
  const proxy = proxyFor(url);
  if (!proxy) return undefined;
  return settings.mode === 'custom' ? withAuth(proxy, settings.username, settings.password) : proxy;
}

/**
 * A Node `http.Agent` that tunnels through the proxy with CONNECT, for clients built on Node's http
 * module (Socket.IO's engine.io); undefined when the target goes direct. ws:// and http:// targets get
 * a plain tunnel, wss:// and https:// a TLS connection inside it.
 */
export function proxyAgentFor(url: string): HttpAgent | undefined {
  const target = new URL(url.replace(/^ws(s?):/i, 'http$1:'));
  const uri = proxyUriFor(target.toString());
  if (!uri) return undefined;
  const p = new URL(uri);
  const auth = p.username ? `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` : undefined;
  const secure = target.protocol === 'https:';
  const createConnection = (opts: ConnectionOptions & { host?: string; port?: number | string }, cb: (err: Error | null, socket?: Duplex) => void) => {
    const hostPort = `${opts.host}:${opts.port}`;
    const req = (p.protocol === 'https:' ? httpsRequest : httpRequest)({
      host: p.hostname,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: hostPort,
      headers: { host: hostPort, ...(auth ? { 'proxy-authorization': auth } : {}) },
    });
    req.once('connect', (res: IncomingMessage, socket: Duplex) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error(`The proxy refused the connection to ${hostPort} (HTTP ${res.statusCode})`));
      }
      const ca = trustedCa();
      cb(null, secure ? tlsConnect({ ...opts, ...(ca && !opts.ca ? { ca } : {}), socket: socket as never, servername: opts.servername ?? opts.host }) : socket);
    });
    req.once('error', (e) => cb(e));
    req.end();
    return undefined;
  };
  const Base = secure ? HttpsAgent : HttpAgent;
  const agent = new Base({ keepAlive: false } as AgentOptions);
  (agent as unknown as { createConnection: typeof createConnection }).createConnection = createConnection;
  return agent;
}

