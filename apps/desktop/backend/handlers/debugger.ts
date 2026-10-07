/** RPC handlers: the HTTP Debugger (planning/http-debugger.md): a local proxy other programs send through, and what it saw. */
import {
  ApsError,
  shortId,
  ENGINE_VERSION,
  ensureRootCertificate,
  exchangesFromHar,
  exchangesFromSaz,
  exchangesToHar,
  installedBrowsers,
  installRootCertificate,
  leafSigner,
  openBrowserWithProxy,
  openTerminalWithProxy,
  proxyShellLines,
  regenerateRootCertificate,
  removeRootCertificate,
  restoreSystemProxy,
  rootCertificateTrusted,
  setSystemProxy,
  startDebuggerProxy,
  trustInstructions,
  tryDecodeJwt,
  type BrowserName,
  type DebuggerExchange,
  type DebuggerProxy,
  type DebuggerRulesFile,
  type LeafCertificate,
  type RootCertificate,
  type SystemProxySnapshot,
  grpcDecoder,
  grpcMethodIndex,
  workspaceProtoRoots,
} from '@testpion/core';
import QRCode from 'qrcode';
import { networkInterfaces } from 'node:os';
import { activeRules, holdBreakpoint, type PendingBreakpoint } from './debugger-rules.js';
import type { Backend, Handlers } from '../backend.js';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { connect as h2connect } from 'node:http2';

/** A request one of the workspace's mock servers received. */
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

interface ListSync {
  rev: number;
  epoch: number;
  nextSeq: number;
  /** When the session's first request started (the grid's Offset counts from it). */
  firstAt?: number;
  seqs: WeakMap<DebuggerExchange, number>;
  revs: WeakMap<DebuggerExchange, number>;
}

function listOf(state: DebuggerState): ListSync {
  return (state.list ??= { rev: 0, epoch: 1, nextSeq: 1, seqs: new WeakMap(), revs: new WeakMap() });
}
/** An exchange was added or changed: its revision moves on (and it gets its place the first time). */
function changed(state: DebuggerState, e: DebuggerExchange): void {
  const l = listOf(state);
  if (!l.seqs.has(e)) {
    l.seqs.set(e, l.nextSeq++);
    l.firstAt ??= Date.parse(e.startedAt);
  }
  l.revs.set(e, ++l.rev);
}
/** The list was replaced, cleared or shortened by the user: the window reloads it once. */
function replaced(state: DebuggerState): void {
  const l = listOf(state);
  l.epoch++;
  l.rev++;
  l.nextSeq = 1;
  l.firstAt = undefined;
  l.seqs = new WeakMap();
  for (const e of state.exchanges) changed(state, e);
}

/**
 * A row of the grid: what the columns, filters and panels need, not the contents. Headers become their sizes;
 * bodies, frames, events and gRPC messages come with the one exchange (debug.exchange).
 */
function leanRow(be: Backend, state: DebuggerState, e: DebuggerExchange) {
  const { requestBody: _rb, responseBody: _sb, frames, events, grpc, requestHeaders, responseHeaders, trailers: _t, ...rest } = e;
  const l = listOf(state);
  const size = (h?: Record<string, string>) => Object.entries(h ?? {}).reduce((n, [k, v]) => n + k.length + 2 + v.length + 2, 0);
  return {
    ...rest,
    url: be.logger.redactor.redactUrl(e.url),
    requestHeaders: {},
    seq: l.seqs.get(e),
    offsetSec: l.firstAt !== undefined ? (Date.parse(e.startedAt) - l.firstAt) / 1000 : 0,
    requestHeaderBytes: size(requestHeaders),
    responseHeaderBytes: responseHeaders ? size(responseHeaders) : undefined,
    requestContentType: requestHeaders['content-type'],
    ...(frames ? { frameCount: frames.length } : {}),
    ...(events ? { eventCount: events.length } : {}),
    ...(grpc ? { grpc: { ...grpc, requests: [], responses: [], message: grpc.message && be.logger.redactor.redactString(grpc.message) } } : {}),
  };
}

/** Keep a request a mock server received for the Debugger's Incoming tab (and tell the window). */
export function recordIncoming(be: Backend, r: Omit<IncomingRequest, 'id' | 'time'>): void {
  const state: DebuggerState = (be.debugger ??= { exchanges: [] });
  const list = (state.incoming ??= []);
  const item: IncomingRequest = { id: shortId('in-'), time: new Date().toISOString(), ...r };
  list.push(item);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  be.host.emit('debug.incoming', item);
}

export interface DebuggerState {
  proxy?: DebuggerProxy;
  /** Kept across stop / start, until cleared: the session. */
  exchanges: DebuggerExchange[];
  /** The system proxy as it was before TestPion switched it to ours (restored on stop, on clear and when the app quits). */
  systemProxy?: SystemProxySnapshot;
  /** AutoSave: the live session is written to debugger/autosave.har every minute while something changed. */
  autosave?: ReturnType<typeof setInterval>;
  dirty?: boolean;
  /** The rules file (handlers/debugger-rules.ts), read once; the proxy asks for the active profile's rules on every request. */
  rules?: DebuggerRulesFile;
  /** Exchanges held at a breakpoint, waiting for the window. */
  breakpoints?: Map<string, PendingBreakpoint>;
  /** HTTPS decryption (DBG-4): on or off for the session; hosts kept opaque; the root and the per-host signer. */
  decrypt?: boolean;
  noDecrypt?: string[];
  root?: RootCertificate;
  leafFor?(host: string): LeafCertificate;
  /** Listening on the local network (a phone, another computer), not only on this computer. */
  lan?: boolean;
  /** Requests TestPion's mock servers received (the Incoming tab): at most the last 2000. */
  incoming?: IncomingRequest[];
  /**
   * The window's list stays in sync by changes, not by reloading it: every exchange has a place in the session (seq,
   * the grid's #) and a revision; `rev` is the latest; `epoch` changes when the list is replaced or rows removed.
   */
  list?: ListSync;
  /** Put everything back (the system proxy) and stop the timers; the backend calls it when it is disposed. */
  release?(): Promise<void>;
}

const SESSIONS_DIR = 'debugger';
const AUTOSAVE = 'autosave';

/** The root certificate of this computer (in the data folder, never in a workspace) and the signer of host certificates. */
function certificateOf(be: Backend, state: DebuggerState): RootCertificate {
  if (!state.root) {
    state.root = ensureRootCertificate(join(be.host.appDir, 'debugger'));
    state.leafFor = leafSigner(state.root);
  }
  return state.root;
}

const hostMatches = (patterns: string[] | undefined, host: string) =>
  (patterns ?? []).some((p) =>
    new RegExp(
      '^' +
        p
          .trim()
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*') +
        '$',
      'i',
    ).test(host),
  );

/** An exchange for the window: bodies and header values pass the redactor (a captured token must not reach the screen or a report as is). */
function redacted(be: Backend, e: DebuggerExchange): DebuggerExchange {
  const red = be.logger.redactor;
  const headers = (h?: Record<string, string>) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, red.isSensitiveKey(k) ? '***' : v])) : h);
  return {
    ...e,
    url: red.redactUrl(e.url),
    requestHeaders: headers(e.requestHeaders)!,
    responseHeaders: headers(e.responseHeaders),
    requestBody: e.requestBody && red.redactString(e.requestBody),
    responseBody: e.responseBody && red.redactString(e.responseBody),
    trailers: headers(e.trailers),
    frames: e.frames?.map((f) => (f.text ? { ...f, text: red.redactString(f.text) } : f)),
    events: e.events?.map((ev) => ({ ...ev, data: red.redactString(ev.data) })),
    grpc: e.grpc && { ...e.grpc, requests: red.redact(e.grpc.requests), responses: red.redact(e.grpc.responses), message: e.grpc.message && red.redactString(e.grpc.message) },
  };
}

/**
 * gRPC messages are decoded with the .proto files (or reflection descriptor sets) the workspace's gRPC calls carry,
 * in collections and the library. Rebuilt when capture starts, and when a method nobody described shows up (at most
 * every ten seconds).
 */
function protoDecoder(be: Backend) {
  let built = 0;
  let index = grpcMethodIndex([]);
  let decode = grpcDecoder(index);
  const build = () => {
    built = Date.now();
    const roots = workspaceProtoRoots(be.ws);
    index = grpcMethodIndex(roots);
    decode = grpcDecoder(index);
  };
  build();
  return {
    rebuild: build,
    methods: () => index.size,
    decode: (path: string, direction: 'request' | 'response', bytes: Buffer) => {
      if (!index.has(path) && Date.now() - built > 10_000) build();
      return decode(path, direction, bytes);
    },
  };
}

/** This computer's addresses on the local networks, for a phone or another computer to use the proxy. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/** The Auth inspector: what the request authenticates with, decoded, without the secret (Basic: the user; Bearer: the JWT's claims and expiry; else the scheme). */
function authOf(be: Backend, e: DebuggerExchange): { scheme: string; user?: string; jwt?: ReturnType<typeof tryDecodeJwt>; cookies: string[]; setCookies: string[]; note?: string } | undefined {
  const h = e.requestHeaders.authorization ?? e.requestHeaders['proxy-authorization'];
  const cookies = (e.requestHeaders.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('=')[0] ?? '')
    .filter(Boolean);
  const setCookies = (e.responseHeaders?.['set-cookie'] ?? '')
    .split(/,(?=\s*\w+=)/)
    .map((c) => c.trim().split('=')[0] ?? '')
    .filter(Boolean);
  if (!h) return cookies.length || setCookies.length ? { scheme: 'none', cookies, setCookies } : undefined;
  const [scheme = '', ...rest] = h.split(' ');
  const value = rest.join(' ').trim();
  if (/^basic$/i.test(scheme)) {
    let user: string | undefined;
    try {
      user = Buffer.from(value, 'base64').toString('utf8').split(':')[0];
    } catch {
      /* not base64 */
    }
    return { scheme: 'Basic', user, cookies, setCookies, note: 'The password travels base64-encoded, not encrypted: plain HTTP shows it to anyone on the path.' };
  }
  if (/^bearer$/i.test(scheme)) {
    const jwt = tryDecodeJwt(value);
    if (jwt) return { scheme: 'Bearer (JWT)', jwt: { ...jwt, token: '***', payload: be.logger.redactor.redact(jwt.payload) as Record<string, unknown> }, cookies, setCookies };
    return { scheme: 'Bearer (opaque token)', cookies, setCookies };
  }
  return { scheme: scheme || 'unknown', cookies, setCookies };
}

const statusClass = (e: DebuggerExchange) => (e.error ? 'error' : !e.status ? 'pending' : e.status < 300 ? '2xx' : e.status < 400 ? '3xx' : e.status < 500 ? '4xx' : '5xx');

export function debuggerHandlers(be: Backend): Handlers {
  const state: DebuggerState = (be.debugger ??= { exchanges: [] });
  const status = () => ({
    lan: !!state.lan,
    // rules that change what programs send or get (not ignore / highlight): the status bar shows them wherever you are
    changingRules: state.proxy ? activeRules(be, state).filter((r) => r.enabled && (r.kind === 'modify' || r.kind === 'reply' || r.kind === 'redirect' || r.kind === 'breakpoint')).length : 0,
    running: !!state.proxy,
    url: state.proxy?.url,
    port: state.proxy?.port,
    exchanges: state.exchanges.length,
    systemProxy: !!state.systemProxy,
    autosave: !!state.autosave,
    decrypt: !!state.decrypt,
    noDecrypt: state.noDecrypt ?? [],
  });
  const sessionsDir = () => be.ws.path(SESSIONS_DIR);
  const sessionFile = (name: string) => {
    const clean = name
      .replace(/\.har$/i, '')
      .replace(/[^\w.\- ]+/g, '_')
      .trim();
    if (!clean) throw new ApsError('ValidationError', 'A session needs a name');
    return be.ws.safePath(`${clean}.har`, sessionsDir());
  };
  const writeSession = (name: string) => {
    mkdirSync(sessionsDir(), { recursive: true });
    const file = sessionFile(name);
    be.lastOwnChange = Date.now();
    writeFileSync(file, JSON.stringify(exchangesToHar(state.exchanges, be.logger.redactor, ENGINE_VERSION), null, 2));
    return { name: basename(file, '.har'), path: file, exchanges: state.exchanges.length };
  };
  const touch = () => {
    state.dirty = true;
  };
  const stopAutosave = () => {
    clearInterval(state.autosave);
    state.autosave = undefined;
  };
  const startAutosave = () => {
    stopAutosave();
    state.autosave = setInterval(() => {
      if (!state.dirty || !state.exchanges.length) return;
      try {
        writeSession(AUTOSAVE);
        state.dirty = false;
      } catch (e) {
        be.logger.warn(`Debugger autosave failed: ${(e as Error).message}`);
      }
    }, 60_000);
  };
  const restoreSystem = async () => {
    const s = state.systemProxy;
    if (!s) return;
    state.systemProxy = undefined;
    await restoreSystemProxy(s).catch((e) => be.logger.warn(`Could not restore the system proxy: ${(e as Error).message}`));
    be.logger.info('System proxy restored');
  };
  state.release = async () => {
    stopAutosave();
    await restoreSystem();
  };
  const stop = async () => {
    for (const bp of [...(state.breakpoints?.values() ?? [])]) bp.resolve(undefined);
    await state.proxy?.close();
    state.proxy = undefined;
    stopAutosave();
    await restoreSystem();
    if (state.dirty && state.exchanges.length) {
      try {
        writeSession(AUTOSAVE);
        state.dirty = false;
      } catch {
        /* the next save */
      }
    }
    return status();
  };

  const handlers: Handlers = {
    'debug.status': () => status(),
    /** Send one request through the proxy from this process (the e2e suite's "program"; also a quick check that the proxy works). */
    'debug.selfTest': ({ url }: { url: string }) =>
      new Promise<{ status: number }>((resolve, reject) => {
        if (!state.proxy) return reject(new ApsError('ConfigurationError', 'The debugger is not capturing'));
        const target = new URL(url);
        if (target.protocol === 'grpc:') {
          // a gRPC call the way grpc-js makes one through a proxy: CONNECT, then HTTP/2 without TLS (h2c) inside the
          // tunnel; the message is a number in field 1 (`?id=`, under 128), which is what GetPet-style requests carry
          const id = Math.min(127, Math.max(0, Number(target.searchParams.get('id') ?? 1) || 0));
          const msg = Buffer.from([0x08, id]);
          const framed = Buffer.concat([Buffer.from([0, 0, 0, 0, msg.length]), msg]);
          const connectReq = httpRequest({ host: '127.0.0.1', port: state.proxy.port, method: 'CONNECT', path: target.host });
          connectReq.on('connect', (_r, socket) => {
            const session = h2connect(`http://${target.host}`, { createConnection: () => socket as never });
            session.on('error', reject);
            const stream = session.request({ ':method': 'POST', ':path': target.pathname, 'content-type': 'application/grpc', te: 'trailers' });
            stream.on('response', () => undefined);
            stream.resume();
            stream.on('end', () => (session.close(), resolve({ status: 200 })));
            stream.on('error', reject);
            stream.end(framed);
          });
          connectReq.on('error', reject);
          connectReq.end();
          return;
        }
        if (target.protocol === 'ws:') {
          // the upgrade through the proxy, one masked text frame, the first frame back, then close
          const req = httpRequest({
            host: '127.0.0.1',
            port: state.proxy.port,
            method: 'GET',
            path: `http://${target.host}${target.pathname}${target.search}`,
            headers: { host: target.host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('testpion-selftst').toString('base64') },
          });
          req.on('upgrade', (res, socket) => {
            const payload = Buffer.from('hello from TestPion');
            const mask = Buffer.from([1, 2, 3, 4]);
            socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))]));
            let seen = 0;
            socket.on('data', () => {
              if (++seen >= 2) {
                socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
                socket.end();
                resolve({ status: res.statusCode ?? 101 });
              }
            });
            setTimeout(() => (socket.end(), resolve({ status: res.statusCode ?? 101 })), 3000);
          });
          req.on('error', reject);
          req.end();
          return;
        }
        if (target.protocol === 'https:') {
          // CONNECT, then TLS inside the tunnel trusting this computer's root: what a program with the root installed does
          const root = certificateOf(be, state);
          const connectReq = httpRequest({ host: '127.0.0.1', port: state.proxy.port, method: 'CONNECT', path: `${target.hostname}:${target.port || 443}` });
          connectReq.on('connect', (_r, socket) => {
            const inner = httpsRequest(
              {
                createConnection: () => socket as never,
                host: target.hostname,
                port: Number(target.port) || 443,
                path: `${target.pathname}${target.search}`,
                servername: target.hostname,
                ca: root.certPem,
                headers: { 'user-agent': 'TestPion self-test' },
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
              },
            );
            inner.on('error', reject);
            inner.end();
          });
          connectReq.on('error', reject);
          connectReq.end();
          return;
        }
        const req = httpRequest({ host: '127.0.0.1', port: state.proxy.port, method: 'GET', path: target.href, headers: { host: target.host, 'user-agent': 'TestPion self-test' } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on('error', reject);
        req.end();
      }),
    /** Start the proxy; programs point at its URL (HTTP_PROXY=…, a browser's proxy setting, --proxy-server=…). */
    'debug.start': async ({ port, lan }: { port?: number; lan?: boolean } = {}) => {
      await state.proxy?.close();
      const protos = protoDecoder(be);
      state.lan = !!lan;
      state.proxy = await startDebuggerProxy({
        port,
        lan,
        grpcDecode: protos.decode,
        rootCertificatePem: () => (state.decrypt ? certificateOf(be, state).certPem : undefined),
        rules: () => activeRules(be, state),
        onBreakpoint: (e, phase) => holdBreakpoint(be, state, e, phase),
        decrypt: {
          leafFor: (host) => (certificateOf(be, state), state.leafFor!(host)),
          enabled: (host) => !!state.decrypt && !hostMatches(state.noDecrypt, host),
        },
        onExchange: (e, phase) => {
          if (phase === 'request') {
            state.exchanges.push(e);
            if (state.exchanges.length > 5000) state.exchanges.shift();
          }
          changed(state, e);
          touch();
          be.host.emit('debug.exchange', { id: e.id, phase });
        },
      });
      startAutosave();
      be.logger.info(`HTTP Debugger listening on ${state.proxy.url}`);
      return status();
    },
    'debug.stop': stop,

    /* ---- capture helpers: the ways a program ends up sending through the proxy */

    /**
     * A phone or another computer: the addresses of this computer on the local networks, each with the proxy URL and
     * a QR code of the page the proxy serves (proxy settings, and the root certificate when HTTPS is decrypted).
     */
    'debug.lan': async () => {
      const port = state.proxy?.port;
      const addresses = await Promise.all(
        lanAddresses().map(async (ip) => {
          const page = port ? `http://${ip}:${port}/` : undefined;
          return { ip, proxy: port ? `${ip}:${port}` : undefined, page, qrSvg: page ? await QRCode.toString(page, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : undefined };
        }),
      );
      return { running: !!state.proxy, lan: !!state.lan, port, decrypt: !!state.decrypt, addresses };
    },
    /** The browsers found on this computer, the shell lines to paste, and whether the system proxy is ours. */
    'debug.captureOptions': () => ({
      browsers: installedBrowsers().map(({ name, label }) => ({ name, label })),
      shells: state.proxy ? proxyShellLines(state.proxy.url) : [],
      systemProxy: !!state.systemProxy,
      platform: process.platform,
    }),
    /** A browser with a throw-away profile that sends through the proxy. */
    'debug.openBrowser': ({ browser, url }: { browser?: BrowserName; url?: string }) => {
      if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
      const r = openBrowserWithProxy(state.proxy.url, browser, url);
      be.logger.info(`Debugger: opened ${r.browser} through ${state.proxy.url}`);
      return r;
    },
    /** A terminal whose shell sends through the proxy. */
    'debug.openTerminal': () => {
      if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
      return openTerminalWithProxy(state.proxy.url);
    },
    /** HTTPS decryption on or off (the program must trust the root certificate), and the hosts kept opaque (globs). */
    'debug.decrypt': ({ on, noDecrypt }: { on?: boolean; noDecrypt?: string[] }) => {
      if (on !== undefined) {
        if (on) certificateOf(be, state);
        state.decrypt = on;
      }
      if (noDecrypt) state.noDecrypt = noDecrypt.map((h) => h.trim()).filter(Boolean);
      return status();
    },
    /** The root certificate: what it is, whether this computer trusts it, install / remove / export / regenerate. */
    'debug.certificate': async ({ action }: { action?: 'info' | 'install' | 'remove' | 'regenerate' | 'export' } = {}) => {
      let root = certificateOf(be, state);
      if (action === 'regenerate') {
        state.root = regenerateRootCertificate(join(be.host.appDir, 'debugger'));
        state.leafFor = leafSigner(state.root);
        root = state.root;
      }
      let note: string | undefined;
      if (action === 'install') note = `Installed into ${(await installRootCertificate(root)).where}`;
      if (action === 'remove') {
        await removeRootCertificate(root);
        note = 'Removed from the trust store';
      }
      if (action === 'export') {
        const r = await be.saveOrDownload(
          'testpion-root.pem',
          [{ name: 'Certificate', extensions: ['pem', 'crt'] }],
          (dest) => writeFileSync(dest, root.certPem),
          () => Buffer.from(root.certPem),
        );
        return { ...r, fingerprint: root.fingerprint };
      }
      const trusted = await rootCertificateTrusted(root);
      return { path: root.path, fingerprint: root.fingerprint, notAfter: root.notAfter, trusted, instructions: trustInstructions(root.path), note, platform: process.platform };
    },
    /** Switch the system proxy to ours (every program that honours it) and back. */
    'debug.systemProxy': async ({ on }: { on: boolean }) => {
      if (on) {
        if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
        if (!state.systemProxy) {
          state.systemProxy = await setSystemProxy(state.proxy.url);
          be.logger.info(`System proxy set to ${state.proxy.url}`);
        }
      } else await restoreSystem();
      return status();
    },

    /* ---- the session */

    /** What was captured (newest last), with filters; bodies only with `withBodies`, for the grid's sake. */
    'debug.exchanges': ({
      host,
      method,
      status: st,
      text,
      deep,
      kind,
      bookmarked,
      application,
      type,
      idsOnly,
      limit = 5000,
    }: {
      /** Only the ids of the matches (a search in headers and bodies, the rest is filtered in the window). */
      idsOnly?: boolean;
      host?: string;
      /** The program, exactly as listed (All Applications). */
      application?: string;
      /** The content type without parameters (All Types): application/json. */
      type?: string;
      method?: string;
      status?: 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error';
      text?: string;
      /** Search headers and bodies too, not only the URL line. */
      deep?: boolean;
      kind?: 'http' | 'tunnel';
      bookmarked?: boolean;
      limit?: number;
    } = {}) => {
      const needle = text?.toLowerCase();
      const out = state.exchanges.filter((e) => {
        if (host && !e.host.toLowerCase().includes(host.toLowerCase())) return false;
        if (method && e.method !== method.toUpperCase()) return false;
        if (kind && e.kind !== kind) return false;
        if (bookmarked && !e.bookmarked) return false;
        if (application && (e.application ?? '') !== application) return false;
        if (type && (e.contentType ?? '').split(';')[0]!.trim().toLowerCase() !== type.toLowerCase()) return false;
        if (st) {
          const s = e.status ?? 0;
          const ok = st === 'ok' ? s >= 200 && s < 300 : st === 'redirect' ? s >= 300 && s < 400 : st === 'client-error' ? s >= 400 && s < 500 : st === 'server-error' ? s >= 500 : !!e.error;
          if (!ok) return false;
        }
        if (needle) {
          const line = `${e.method} ${e.url} ${e.application ?? ''} ${e.contentType ?? ''} ${e.status ?? ''}`.toLowerCase();
          if (line.includes(needle)) return true;
          if (!deep) return false;
          const h = (x?: Record<string, string>) => Object.entries(x ?? {}).some(([k, v]) => k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle));
          return h(e.requestHeaders) || h(e.responseHeaders) || !!e.requestBody?.toLowerCase().includes(needle) || !!e.responseBody?.toLowerCase().includes(needle);
        }
        return true;
      });
      if (idsOnly) return out.slice(-limit).map((e) => e.id);
      return out.slice(-limit).map((e) => leanRow(be, state, e));
    },
    /**
     * The grid's changes since the window last asked: the rows added or changed after revision `since`, or every row
     * (reset) when the list was replaced since `epoch`; `firstSeq` drops the rows the session no longer keeps.
     */
    'debug.changes': ({ epoch, since = 0 }: { epoch?: number; since?: number } = {}) => {
      const l = listOf(state);
      const reset = epoch !== l.epoch;
      const rows = state.exchanges.filter((e) => reset || (l.revs.get(e) ?? 0) > since).map((e) => leanRow(be, state, e));
      return { epoch: l.epoch, rev: l.rev, reset, rows, firstSeq: state.exchanges.length ? l.seqs.get(state.exchanges[0]!) : undefined, total: state.exchanges.length };
    },
    /** Requests the workspace's mock servers received (the Incoming tab), newest last. */
    'debug.incoming': () => state.incoming ?? [],
    'debug.clearIncoming': () => {
      state.incoming = [];
    },
    /** One exchange whole (bodies included, redacted), with the Auth inspector's reading of its credentials (never the secret itself). */
    'debug.exchange': ({ id }: { id: string }) => {
      const e = state.exchanges.find((x) => x.id === id);
      if (!e) throw new ApsError('ValidationError', 'That exchange is no longer in the session');
      const size = (h?: Record<string, string>) => Object.entries(h ?? {}).reduce((n, [k, v]) => n + k.length + 2 + v.length + 2, 0);
      // the sizes as sent (the headers shown are masked)
      return { ...redacted(be, e), auth: authOf(be, e), requestHeaderBytes: size(e.requestHeaders), responseHeaderBytes: e.responseHeaders ? size(e.responseHeaders) : undefined };
    },
    'debug.bookmark': ({ id, on }: { id: string; on: boolean }) => {
      const e = state.exchanges.find((x) => x.id === id);
      if (e) {
        e.bookmarked = on;
        changed(state, e);
      }
      touch();
      return true;
    },
    'debug.delete': ({ ids }: { ids: string[] }) => {
      const set = new Set(ids);
      state.exchanges = state.exchanges.filter((e) => !set.has(e.id));
      if (be.debugger) be.debugger.exchanges = state.exchanges;
      listOf(state).epoch++;
      listOf(state).rev++;
      touch();
      return status();
    },
    'debug.clear': () => {
      state.exchanges.length = 0;
      state.proxy?.clear();
      replaced(state);
      state.dirty = false;
      // the window refreshes whoever cleared (a menu, a shortcut, an agent)
      be.host.emit('debug.exchange', { phase: 'cleared' });
      return status();
    },
    /** Statistics of the session: by host, by content type, the largest and the slowest, the timeline. */
    'debug.stats': () => {
      const by = <K extends string>(key: (e: DebuggerExchange) => K | undefined) => {
        const m = new Map<K, { count: number; bytes: number; ms: number }>();
        for (const e of state.exchanges) {
          const k = key(e);
          if (!k) continue;
          const v = m.get(k) ?? { count: 0, bytes: 0, ms: 0 };
          v.count++;
          v.bytes += e.responseBodyBytes;
          v.ms += e.durationMs ?? 0;
          m.set(k, v);
        }
        return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes);
      };
      const done = state.exchanges.filter((e) => e.durationMs !== undefined);
      // the overview: requests per time slice (so a burst, a gap or a retry storm shows), and the status mix
      const times = state.exchanges.map((e) => Date.parse(e.startedAt)).filter((t) => !Number.isNaN(t));
      const first = times.length ? Math.min(...times) : 0;
      const last = times.length ? Math.max(...times) : 0;
      const span = Math.max(1000, last - first);
      const buckets = Math.min(60, Math.max(10, Math.ceil(span / 1000)));
      const slice = span / buckets;
      const timeline = Array.from({ length: buckets }, (_, i) => ({ t: new Date(first + i * slice).toISOString(), count: 0, errors: 0 }));
      for (const e of state.exchanges) {
        const t = Date.parse(e.startedAt);
        if (Number.isNaN(t)) continue;
        const b = timeline[Math.min(buckets - 1, Math.floor((t - first) / slice))]!;
        b.count++;
        if (e.error || (e.status ?? 0) >= 400) b.errors++;
      }
      const statuses: Record<string, number> = {};
      for (const e of state.exchanges) statuses[statusClass(e)] = (statuses[statusClass(e)] ?? 0) + 1;
      return {
        total: state.exchanges.length,
        bytes: state.exchanges.reduce((n, e) => n + e.responseBodyBytes, 0),
        errors: state.exchanges.filter((e) => e.error || (e.status ?? 0) >= 400).length,
        firstAt: first ? new Date(first).toISOString() : undefined,
        lastAt: last ? new Date(last).toISOString() : undefined,
        timeline,
        statuses,
        hosts: by((e) => e.host).slice(0, 20),
        contentTypes: by((e) => e.contentType?.split(';')[0]?.trim()).slice(0, 20),
        applications: by((e) => e.application).slice(0, 20),
        largest: [...done]
          .sort((a, b) => b.responseBodyBytes - a.responseBodyBytes)
          .slice(0, 10)
          .map((e) => ({ id: e.id, method: e.method, url: be.logger.redactor.redactUrl(e.url), bytes: e.responseBodyBytes })),
        slowest: [...done]
          .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
          .slice(0, 10)
          .map((e) => ({ id: e.id, method: e.method, url: be.logger.redactor.redactUrl(e.url), ms: e.durationMs })),
      };
    },
    /** The session as HAR (the same format the history exports), for saving and for other tools. */
    'debug.har': () => exchangesToHar(state.exchanges, be.logger.redactor, ENGINE_VERSION),

    /* ---- sessions: HAR files in the workspace's debugger/ folder (never committed) */

    'debug.sessions': () => {
      const dir = sessionsDir();
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => /\.har$/i.test(f))
        .map((f) => {
          const st = statSync(join(dir, f));
          return { name: basename(f, '.har'), path: join(dir, f), bytes: st.size, savedAt: st.mtime.toISOString(), autosave: basename(f, '.har') === AUTOSAVE };
        })
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    'debug.saveSession': ({ name }: { name: string }) => {
      if (!state.exchanges.length) throw new ApsError('ValidationError', 'Nothing captured yet');
      const r = writeSession(name);
      state.dirty = false;
      return r;
    },
    /** Open a saved session (or any HAR file by path): its exchanges replace the session, or join it with `append`. */
    'debug.openSession': ({ name, path, text, base64, append }: { name?: string; path?: string; text?: string; /** A SAZ (zip) file's bytes. */ base64?: string; append?: boolean }) => {
      const bytes = base64 ? Buffer.from(base64, 'base64') : text !== undefined ? Buffer.from(text, 'utf8') : readFileSync(path ? be.ws.safePath(path) : sessionFile(name ?? ''));
      let loaded: DebuggerExchange[];
      if (bytes.subarray(0, 2).toString('latin1') === 'PK') {
        try {
          loaded = exchangesFromSaz(bytes);
        } catch (e) {
          throw new ApsError('ValidationError', `Not a Fiddler SAZ file: ${(e as Error).message}`);
        }
      } else {
        let har: unknown;
        try {
          har = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new ApsError('ValidationError', 'Not a HAR file (JSON with log.entries) or a SAZ file');
        }
        loaded = exchangesFromHar(har);
      }
      if (!loaded.length) throw new ApsError('ValidationError', 'No entries in that file');
      state.exchanges = append ? [...state.exchanges, ...loaded] : loaded;
      if (be.debugger) be.debugger.exchanges = state.exchanges;
      if (append) for (const e of loaded) changed(state, e);
      else replaced(state);
      state.dirty = false;
      be.host.emit('debug.exchange', { phase: 'session' });
      return { ...status(), loaded: loaded.length };
    },
    'debug.deleteSession': ({ name }: { name: string }) => {
      const f = sessionFile(name);
      if (existsSync(f)) unlinkSync(f);
      return true;
    },
  };
  // the status bar shows the Debugger wherever you are (running, rules that change traffic, the system proxy):
  // whatever changes that state says so
  for (const name of ['debug.start', 'debug.stop', 'debug.systemProxy', 'debug.decrypt', 'debug.clear']) {
    const h = handlers[name]!;
    handlers[name] = async (p: unknown) => {
      const r = await h(p);
      be.host.emit('debug.state', status());
      return r;
    };
  }
  return handlers;
}
