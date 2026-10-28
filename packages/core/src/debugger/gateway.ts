import { existsSync, readFileSync, statSync } from 'node:fs';
import { ApsError } from '../errors.js';
import { bypassed, splitPem } from '../net/proxy.js';

/**
 * The Debugger's connections to the servers (FG-9): a corporate gateway (upstream proxy) the forwarded traffic goes through,
 * a bypass list, extra certificate authorities to trust and client certificates for servers that ask for one (mutual TLS).
 *
 * The configuration (`GatewayConfig`) holds no secret: a proxy password and the passphrase of a client key live in the secret
 * store and come in through `resolveGateway`; a client key itself stays in the file the user keeps it in (only its path is saved).
 */
export interface ClientCertificate {
  /** Names it in the secret store (`debugger.clientcert.<id>.passphrase`) and in the list. */
  id: string;
  /** Which servers get it: a glob on host[:port], like a rule's Domain (`*.corp.example`, `mtls.example.com:8443`). */
  host: string;
  certFile: string;
  keyFile: string;
}

export interface GatewayConfig {
  /** none: connect directly. system: follow the app's network settings (Settings ▸ Network, HTTP_PROXY and NO_PROXY). manual: the address below. */
  mode: 'none' | 'system' | 'manual';
  /** manual: `http://host:port` (credentials may be given in the address; a separate user name and the password in the secret store are safer). */
  url?: string;
  /** Hosts that go direct, comma separated like NO_PROXY: `.corp.example, 10.0.0.1, <local>`. Loopback always goes direct. */
  bypass?: string;
  username?: string;
  /** Extra certificate authorities (PEM files) the servers' certificates may chain to, besides the app's trust. */
  caFiles?: string[];
  clientCerts?: ClientCertificate[];
}

export const GATEWAY_PASSWORD_SECRET = 'debugger.gateway.password';
export const clientCertSecret = (id: string): string => `debugger.clientcert.${id}.passphrase`;

export const emptyGateway = (): GatewayConfig => ({ mode: 'none' });

/** The proxy address as a URL, or a reason it cannot work (in words for the person who typed it). */
export function checkGatewayUrl(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim();
  if (!text) return 'Give the gateway as http://host:port';
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return `"${text}" is not an address (e.g. http://proxy.corp.example:3128)`;
  }
  if (u.protocol !== 'http:') return 'The gateway is reached over http:// (it tunnels HTTPS with CONNECT); an https:// gateway is not supported';
  if (!u.hostname) return 'The gateway needs a host name';
  return undefined;
}

/** A configuration from loose input (a file, an RPC call, a tool call): every field checked, unknown ones dropped. */
export function cleanGateway(input: unknown): GatewayConfig {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const mode = o.mode === 'system' || o.mode === 'manual' ? o.mode : 'none';
  const text = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const out: GatewayConfig = { mode };
  if (mode === 'manual') {
    const bad = checkGatewayUrl(text(o.url));
    if (bad) throw new ApsError('ValidationError', bad);
    out.url = text(o.url);
  }
  if (mode !== 'none') {
    const bypass = text(o.bypass);
    if (bypass) out.bypass = bypass;
  }
  if (mode === 'manual' && text(o.username, 200)) out.username = text(o.username, 200);
  const files = Array.isArray(o.caFiles) ? o.caFiles.map((f) => text(f, 1000)).filter((f): f is string => !!f) : [];
  if (files.length > 20) throw new ApsError('ValidationError', 'At most 20 certificate files');
  if (files.length) out.caFiles = [...new Set(files)];
  const certs = Array.isArray(o.clientCerts) ? o.clientCerts : [];
  if (certs.length > 50) throw new ApsError('ValidationError', 'At most 50 client certificates');
  const list: ClientCertificate[] = [];
  for (const c of certs as Array<Record<string, unknown>>) {
    const host = text(c?.host, 300);
    const certFile = text(c?.certFile, 1000);
    const keyFile = text(c?.keyFile, 1000);
    if (!host || !certFile || !keyFile) throw new ApsError('ValidationError', 'A client certificate needs the host it is for, a certificate file and a key file');
    if (list.some((x) => x.host === host)) throw new ApsError('ValidationError', `There is already a client certificate for ${host}`);
    const id = text(c?.id, 64)?.replace(/[^A-Za-z0-9_-]/g, '') || `c${list.length + 1}-${host.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
    list.push({ id, host, certFile, keyFile });
  }
  if (list.length) out.clientCerts = list;
  return out;
}

/** What a configuration needs from outside it: files that are missing, a CA file with no certificate in it. For the dialog and `testpion debugger gateway --check`. */
export function gatewayProblems(c: GatewayConfig): string[] {
  const out: string[] = [];
  for (const f of c.caFiles ?? []) {
    if (!existsSync(f)) out.push(`The certificate file ${f} does not exist`);
    else if (!splitPem(readFileSync(f, 'utf8')).length) out.push(`${f} has no PEM certificate in it`);
  }
  for (const k of c.clientCerts ?? []) {
    if (!existsSync(k.certFile)) out.push(`The client certificate ${k.certFile} (for ${k.host}) does not exist`);
    if (!existsSync(k.keyFile)) out.push(`The key ${k.keyFile} (for ${k.host}) does not exist`);
  }
  return out;
}

/** A configuration ready to answer the proxy's questions for every request. */
export interface Gateway {
  readonly config: GatewayConfig;
  /** The upstream proxy for this URL (host, port, the Proxy-Authorization value), or undefined: connect directly. */
  proxyFor(url: URL): { host: string; port: number; auth?: string; label: string } | undefined;
  /** Extra authorities (PEM) to trust besides the app's. */
  readonly extraCa: string[];
  /** The client certificate for a server (host[:port]), with its passphrase. */
  clientCertFor(hostPort: string): { id: string; cert: Buffer; key: Buffer; passphrase?: string } | undefined;
}

export interface GatewaySources {
  /** A secret by name (the proxy password, the key passphrases). */
  secret(name: string): string | undefined;
  /** What the app's network settings say for a URL (a proxy URL, possibly with credentials), for the `system` mode. */
  systemProxyFor?(url: string): string | undefined;
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|::1|\[::1\])$/i;

/** Files read once per resolve and again when they change (a renewed certificate is picked up on the next resolve). */
const readTrusted = (file: string, what: string): Buffer => {
  try {
    if (statSync(file).size > 1_000_000) throw new Error('larger than 1 MB');
    return readFileSync(file);
  } catch (e) {
    throw new ApsError('ConfigurationError', `Cannot read ${what} ${file}: ${(e as Error).message}`, { suggestions: ['Open Capture ▸ Connections and check the file path.'] });
  }
};

const authOf = (user: string | undefined, pass: string | undefined): string | undefined => (user ? `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}` : undefined);

/** Make a configuration usable: files read, secrets looked up. Throws a ConfigurationError that says which file or secret is wrong. */
export function resolveGateway(config: GatewayConfig, src: GatewaySources): Gateway {
  const extraCa: string[] = [];
  for (const f of config.caFiles ?? []) {
    const pems = splitPem(readTrusted(f, 'the certificate file').toString('utf8'));
    if (!pems.length) throw new ApsError('ConfigurationError', `${f} has no PEM certificate in it`);
    extraCa.push(...pems);
  }
  const certs = (config.clientCerts ?? []).map((c) => ({ ...c, cert: readTrusted(c.certFile, 'the client certificate'), key: readTrusted(c.keyFile, 'the client key'), passphrase: src.secret(clientCertSecret(c.id)) }));
  let manual: { host: string; port: number; auth?: string } | undefined;
  if (config.mode === 'manual') {
    const bad = checkGatewayUrl(config.url);
    if (bad) throw new ApsError('ConfigurationError', bad);
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(config.url!) ? config.url! : `http://${config.url}`);
    const user = config.username || (u.username ? decodeURIComponent(u.username) : undefined);
    const pass = config.username ? src.secret(GATEWAY_PASSWORD_SECRET) : u.password ? decodeURIComponent(u.password) : undefined;
    manual = { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80, auth: authOf(user, pass) };
  }
  const local = (u: URL, list: string) => list.split(/[,\s]+/).some((r) => r.toLowerCase() === '<local>') && !u.hostname.includes('.') && !/^[\d.]+$|:/.test(u.hostname);
  return {
    config,
    extraCa,
    proxyFor(url) {
      if (config.mode === 'none' || LOOPBACK.test(url.hostname)) return undefined;
      const list = config.bypass ?? '';
      if (list && (bypassed(url, list) || local(url, list))) return undefined;
      if (manual) return { ...manual, label: `${manual.host}:${manual.port}` };
      const uri = src.systemProxyFor?.(url.href);
      if (!uri) return undefined;
      const p = new URL(uri);
      if (p.protocol !== 'http:') return undefined; // an https:// proxy is not tunnelled here; the request goes direct rather than failing
      return { host: p.hostname.replace(/^\[|\]$/g, ''), port: Number(p.port) || 80, auth: authOf(p.username ? decodeURIComponent(p.username) : undefined, p.password ? decodeURIComponent(p.password) : undefined), label: `${p.hostname}:${p.port || 80}` };
    },
    clientCertFor(hostPort) {
      const h = hostPort.toLowerCase();
      const bare = h.replace(/:\d+$/, '');
      const hit = certs.find((c) => globMatch(c.host.toLowerCase(), h) || (!/:\d+$/.test(c.host) && globMatch(c.host.toLowerCase(), bare)));
      return hit && { id: hit.id, cert: hit.cert, key: hit.key, passphrase: hit.passphrase };
    },
  };
}

function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === text;
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(text);
}

/** The summary the window and the tools show: no secret, no path content. */
export function describeGateway(c: GatewayConfig, secretsSet: { password: boolean }): string {
  const base = c.mode === 'none' ? 'Direct connections' : c.mode === 'system' ? 'Through the system proxy settings' : `Through ${c.url}${c.username ? ` as ${c.username}${secretsSet.password ? '' : ' (password not set)'}` : ''}`;
  const extra = [c.caFiles?.length ? `${c.caFiles.length} extra certificate file${c.caFiles.length === 1 ? '' : 's'}` : '', c.clientCerts?.length ? `${c.clientCerts.length} client certificate${c.clientCerts.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  return extra.length ? `${base}; ${extra.join(', ')}` : base;
}
