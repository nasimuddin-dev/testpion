import type { Dispatcher } from 'undici';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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
 *
 * The settings and the trusted certificates are USER configuration, so they live in a `NetConfig` (one per session: the
 * backend makes one per user, the CLI uses the process default) that travels with the call (`withNet`, AsyncLocalStorage) and
 * on `ExecServices.net`. What stays process-wide is the operator's SAFETY policy (net/policy.ts: private networks, host
 * allow-list), which a server enforces for every user.
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
    m.setGlobalDispatcher(defaultNet.baseDispatcher()); // global fetch follows the process default only
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

export const splitPem = (pem = '') => pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];

function systemCertificates(): string[] {
  const get = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  try {
    return get?.('system') ?? [];
  } catch {
    return [];
  }
}

/** One user's network configuration: proxy, trusted certificates and the connection pools built from them. */
export class NetConfig {
  /** Names this configuration in pool keys (connection pools are never shared between configurations). */
  readonly id = randomUUID();
  settings: ProxySettings = { mode: 'env' };
  trust: TlsTrust = {};
  /** Changes whenever the proxy or the trust change, so callers can drop cached dispatchers. */
  generation = 0;
  private caList: string[] | undefined;
  private base: Dispatcher | undefined;
  private wsBase: Dispatcher | undefined;

  /** Proxy options for undici's EnvHttpProxyAgent (undefined keys fall back to the environment). */
  private proxyOptions(): { httpProxy?: string; httpsProxy?: string; noProxy?: string } {
    const s = this.settings;
    if (s.mode !== 'custom' || !s.url?.trim()) return {};
    const uri = withAuth(s.url.trim(), s.username, s.password);
    // with a custom proxy, NO_PROXY from the environment must not apply: the bypass list replaces it
    return { httpProxy: uri, httpsProxy: uri, noProxy: s.bypass?.trim() || '' };
  }

  /**
   * A dispatcher for these TLS / connect options that honours the proxy settings (a per-request proxy
   * overrides them). The SSRF guard (`policyLookup`) always applies to direct connections.
   */
  makeDispatcher(connect: Record<string, unknown> = {}, requestProxy?: string, pool: Record<string, unknown> = {}): Dispatcher {
    const ca = this.trustedCa();
    // a request's own CA (client certificate settings) wins over the trusted set
    const c = { lookup: policyLookup, ...(ca ? { ca } : {}), ...connect };
    const mode = this.settings.mode;
    const options = this.proxyOptions();
    return whenLoaded(({ Agent, EnvHttpProxyAgent, ProxyAgent }) => {
      if (requestProxy) return new ProxyAgent({ uri: requestProxy, connect: c, requestTls: c as never, ...pool });
      if (mode === 'off') return new Agent({ connect: c as never, ...pool });
      return new EnvHttpProxyAgent({ ...options, connect: c as never, requestTls: c as never, ...pool } as never);
    });
  }

  /** The shared dispatcher for requests with default TLS settings. */
  baseDispatcher(): Dispatcher {
    return (this.base ??= this.makeDispatcher({}, undefined, { connections: 256, pipelining: 1, keepAliveTimeout: 10_000 }));
  }

  /** For WebSocket handshakes: always a CONNECT tunnel through the proxy (proxies can't forward a ws:// upgrade otherwise). */
  websocketDispatcher(): Dispatcher {
    return (this.wsBase ??= this.makeDispatcher({}, undefined, { proxyTunnel: true }));
  }

  /** The settings with the password masked (for the UI). */
  proxySettings(): ProxySettings {
    return { ...this.settings, password: this.settings.password ? '••••' : undefined };
  }

  /** Apply new proxy settings (the app's Settings, or the CLI's defaults). */
  setProxy(p: ProxySettings): void {
    if (p.mode === 'custom' && p.url) {
      // throws on a malformed URL before anything changes
      const u = new URL(p.url);
      if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(`The proxy URL must be http:// or https:// with a host: ${p.url}`);
    }
    this.settings = { ...p };
    this.rebuild();
  }

  /** The CA list to use, or undefined for Node's default (nothing extra configured). */
  trustedCa(): string[] | undefined {
    if (!this.trust.systemCa && !splitPem(this.trust.extraCa).length) return undefined;
    return (this.caList ??= [...tls.rootCertificates, ...(this.trust.systemCa ? systemCertificates() : []), ...splitPem(this.trust.extraCa)]);
  }

  /** Validate PEM certificates (throws on a malformed one) and apply the trust settings. */
  setTrust(t: TlsTrust): void {
    describeCertificates(t.extraCa ?? '');
    this.trust = { ...t };
    this.caList = undefined;
    this.rebuild();
  }

  tlsTrust(): TlsTrust & { systemCertificates: number } {
    return { ...this.trust, systemCertificates: this.trust.systemCa ? systemCertificates().length : 0 };
  }

  /** Which proxy a URL would use under these settings. */
  proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const s = this.settings;
    if (s.mode === 'off') return undefined;
    const u = new URL(url);
    const custom = s.mode === 'custom' && s.url?.trim();
    const proxy = custom ? s.url!.trim() : u.protocol === 'https:' ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy : env.HTTP_PROXY ?? env.http_proxy;
    if (!proxy) return undefined;
    const noProxy = (custom ? s.bypass : env.NO_PROXY ?? env.no_proxy) ?? '';
    return bypassed(u, noProxy) ? undefined : proxy;
  }

  /** The proxy URL for a target, with the custom proxy's credentials (for clients that aren't undici). */
  proxyUriFor(url: string): string | undefined {
    const proxy = this.proxyFor(url);
    if (!proxy) return undefined;
    return this.settings.mode === 'custom' ? withAuth(proxy, this.settings.username, this.settings.password) : proxy;
  }

  /** Run `fn` with this configuration for every network call inside it (also after awaits). */
  run<T>(fn: () => T): T {
    return als.run(this, fn);
  }

  /** Stop using the pools of this configuration (the session closed). */
  dispose(): void {
    // the process default is global fetch's dispatcher: hand that over to a fresh default before the pools close
    if (this === defaultNet) setDefaultNet(new NetConfig());
    this.generation++;
    for (const d of [this.base, this.wsBase]) void d?.close().catch(() => undefined);
    this.base = this.wsBase = undefined;
  }

  private rebuild(): void {
    this.generation++;
    const old = [this.base, this.wsBase];
    this.base = this.wsBase = undefined;
    if (this === defaultNet) {
      // the process default owns the global dispatcher (global fetch follows it)
      if (undici) undici.setGlobalDispatcher(this.baseDispatcher());
      else if (!loading && !loadTimer) {
        // not loaded yet: a moment after start (a request before that loads it itself)
        loadTimer = setTimeout(() => void loadUndici().catch(() => undefined), LOAD_DELAY_MS);
        (loadTimer as { unref?(): void }).unref?.();
      }
    }
    for (const d of old) void d?.close().catch(() => undefined);
  }
}

const als = new AsyncLocalStorage<NetConfig>();
let defaultNet = new NetConfig();

/**
 * The configuration of the process (the CLI's, or the desktop app's single session): what code outside any call uses (timers, the
 * monitor scheduler, global `fetch`). A server never replaces it: its sessions bring their own.
 */
export function setDefaultNet(net: NetConfig): void {
  const was = defaultNet;
  defaultNet = net;
  if (was !== net) {
    net.generation++;
    undici?.setGlobalDispatcher(net.baseDispatcher());
  }
}

/** The configuration the running code belongs to: its call's (or run's) session, else the process default. */
export function currentNet(): NetConfig {
  return als.getStore() ?? defaultNet;
}

/** Run `fn` with this configuration (a no-op wrapper when none is given). */
export function withNet<T>(net: NetConfig | undefined, fn: () => T): T {
  return net ? net.run(fn) : fn();
}

/**
 * `fetch` through the current configuration's proxy and trust. The process default keeps using the global dispatcher (which it
 * owns); any other session passes its own pool.
 */
export async function netFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const net = currentNet();
  if (net === defaultNet) return fetch(input, init);
  // undici's own fetch: the global one of an older Node hands a dispatcher of a newer undici a handler it does not accept
  const { fetch: undiciFetch } = await import('undici');
  return (await undiciFetch(input, { ...init, dispatcher: net.baseDispatcher() } as never)) as unknown as Response;
}

export function makeDispatcher(connect: Record<string, unknown> = {}, requestProxy?: string, pool: Record<string, unknown> = {}): Dispatcher {
  return currentNet().makeDispatcher(connect, requestProxy, pool);
}
export const baseDispatcher = (): Dispatcher => currentNet().baseDispatcher();
export const websocketDispatcher = (): Dispatcher => currentNet().websocketDispatcher();
export const proxyGeneration = (): number => currentNet().generation;
export const getProxySettings = (): ProxySettings => currentNet().proxySettings();
export const setProxySettings = (p: ProxySettings): void => currentNet().setProxy(p);
export const trustedCa = (): string[] | undefined => currentNet().trustedCa();
export const setTlsTrust = (t: TlsTrust): void => currentNet().setTrust(t);
export const getTlsTrust = (): TlsTrust & { systemCertificates: number } => currentNet().tlsTrust();

/* ------------------------------------------------------------------ certificates and proxy lookup */

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
export const proxyFor = (url: string, env: NodeJS.ProcessEnv = process.env): string | undefined => currentNet().proxyFor(url, env);

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

/**
 * A Node `http.Agent` that tunnels through the proxy with CONNECT, for clients built on Node's http
 * module (Socket.IO's engine.io); undefined when the target goes direct. ws:// and http:// targets get
 * a plain tunnel, wss:// and https:// a TLS connection inside it.
 */
export function proxyAgentFor(url: string): HttpAgent | undefined {
  const target = new URL(url.replace(/^ws(s?):/i, 'http$1:'));
  const net = currentNet(); // the call's configuration, also when the tunnel opens later
  const uri = net.proxyUriFor(target.toString());
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
      const ca = net.trustedCa();
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

