/** RPC handlers: the HTTP Debugger (planning/http-debugger.md): a local proxy other programs send through, and what it saw. */
import {
  ApsError,
  annotate,
  cleanAnnotation,
  shortId,
  ENGINE_VERSION,
  exchangesFromHar,
  exchangesFromSaz,
  exchangesToHar,
  startDebuggerProxy,
  tryDecodeJwt,
  type DebuggerExchange,
  grpcDecoder,
  grpcMethodIndex,
  workspaceProtoRoots,
  batcher,
  CAPTURE_SESSIONS_DIR,
  captureSessionFileName,
  recordCaptureSession,
  removeOwned,
} from '@testpion/core';
import {
  ensureRootCertificate,
  installedBrowsers,
  installRootCertificate,
  leafSigner,
  openBrowserWithProxy,
  openTerminalWithProxy,
  proxyShellLines,
  regenerateRootCertificate,
  rootStanding,
  removeRootCertificate,
  checkStartUrl,
  disengageSystemProxy,
  engageSystemProxy,
  repairSystemProxy,
  trustChecker,
  trustInstructions,
  type BrowserName,
  type RootCertificate,
} from '@testpion/core/desktop';
import { networkInterfaces } from 'node:os';
import { activeRules, holdBreakpoint } from './debugger-rules.js';
import { runExchangeView } from './debugger-views.js';
import { graphqlOf, looksLikeGraphql } from '@testpion/shared';
import { cachedLeanRow, cachedSessionStats, DeepSearchCache, inSlices, startMs } from './debugger-stats.js';
import { newDebuggerState, type DebuggerState, type IncomingRequest, type ListSync } from './debugger-state.js';
import { AUTOSAVE, sessionSaver } from './debugger-save.js';
import { settleWithin } from '../backend-health.js';

export { newDebuggerState, type DebuggerState, type IncomingRequest };
import type { Backend, Handlers } from '../backend.js';

/** qrcode (with pngjs) loads when the phone-setup page first asks for its QR code, not at startup. */
let qrcodeMod: Promise<typeof import('qrcode')> | undefined;
const qrcode = () => (qrcodeMod ??= import('qrcode').then((m) => ((m as { default?: typeof import('qrcode') }).default ?? m) as typeof import('qrcode')));
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { connect as h2connect } from 'node:http2';

/** Epochs are unique across every session's list (the live one, saved ones shown in their tabs): a switch is a reset. */
let epochSeq = 0;
function listOf(state: DebuggerState): ListSync {
  return (state.list ??= { rev: 0, epoch: ++epochSeq, nextSeq: 1, seqs: new WeakMap(), revs: new WeakMap() });
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
  l.epoch = ++epochSeq;
  l.rev++;
  l.nextSeq = 1;
  l.firstAt = undefined;
  l.seqs = new WeakMap();
  for (const e of state.exchanges) changed(state, e);
}

/** Rows of a changes answer built in one go; a longer list is built in slices. */
const LEAN_AT_ONCE = 300;

/**
 * A row of the grid: what the columns, filters and panels need, not the contents. Headers become their sizes;
 * bodies, frames, events and gRPC messages come with the one exchange (debug.exchange).
 */
function leanRow(be: Backend, state: DebuggerState, e: DebuggerExchange) {
  const l = listOf(state);
  // built once per revision (a reset of thousands of rows reads them from here)
  return cachedLeanRow(e, { rev: l.revs.get(e) ?? 0, seq: l.seqs.get(e), firstAt: l.firstAt, gen: be.logger.redactor.generation }, () => buildLeanRow(be, state, e));
}
function buildLeanRow(be: Backend, state: DebuggerState, e: DebuggerExchange) {
  const { requestBody: _rb, responseBody: _sb, requestBodyBase64: _qb, responseBodyBase64: _pb, connection: _cx, frames, events, grpc, requestHeaders, responseHeaders, trailers: _t, ...rest } = e;
  const l = listOf(state);
  const size = (h?: Record<string, string>) => Object.entries(h ?? {}).reduce((n, [k, v]) => n + k.length + 2 + v.length + 2, 0);
  return {
    ...rest,
    url: be.logger.redactor.redactUrl(e.url),
    requestHeaders: {},
    seq: l.seqs.get(e),
    offsetSec: l.firstAt !== undefined ? (startMs(e) - l.firstAt) / 1000 : 0,
    requestHeaderBytes: size(requestHeaders),
    responseHeaderBytes: responseHeaders ? size(responseHeaders) : undefined,
    requestContentType: requestHeaders['content-type'],
    ...gqlOf(e),
    ...(frames ? { frameCount: frames.length } : {}),
    ...(events ? { eventCount: events.length } : {}),
    ...(grpc ? { grpc: { ...grpc, requests: [], responses: [], message: grpc.message && be.logger.redactor.redactString(grpc.message) } } : {}),
  };
}

/** GraphQL calls get `graphql: "query GetUser"` for the list (the row is built once per change, so the request body is read once). */
function gqlOf(e: DebuggerExchange): { graphql?: string } {
  if (e.kind !== 'http' || !e.requestBody || !looksLikeGraphql({ url: e.url, requestContentType: e.requestHeaders['content-type'], requestBody: e.requestBody })) return {};
  const g = graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestHeaders['content-type'], requestBody: e.requestBody });
  return g ? { graphql: g.label } : {};
}

/** Keep a request a mock server received for the Debugger's Incoming tab (and tell the window). */
export function recordIncoming(be: Backend, r: Omit<IncomingRequest, 'id' | 'time'>): void {
  const state: DebuggerState = (be.debugger ??= newDebuggerState());
  const list = (state.incoming ??= []);
  // secrets masked, bodies capped: the list is kept in memory and shown in the window
  const red = be.logger.redactor;
  const headers = (h?: Record<string, string>) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, red.isSensitiveKey(k) ? '***' : v])) : undefined);
  const text = (t?: string) => (t === undefined ? undefined : red.redactString(t.slice(0, 16 * 1024)));
  const item: IncomingRequest = {
    id: shortId('in-'),
    time: new Date().toISOString(),
    ...r,
    query: r.query ? red.redactUrl(`http://x/${r.query}`).slice('http://x/'.length) : undefined,
    headers: headers(r.headers),
    responseHeaders: headers(r.responseHeaders),
    body: text(r.body),
    responseBody: text(r.responseBody),
  };
  list.push(item);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  // a load test against a mock fills the list fast: only the latest 200 keep their bodies (at most ~6 MB)
  const old = list[list.length - 201];
  if (old) {
    old.body = old.body === undefined ? undefined : '(not kept: only the latest 200 requests keep their bodies)';
    old.responseBody = old.responseBody === undefined ? undefined : '(not kept: only the latest 200 requests keep their bodies)';
  }
  be.host.emit('debug.incoming', item);
}

const SESSIONS_DIR = CAPTURE_SESSIONS_DIR;
/** The most a session file or pasted text opened in the Debugger may hold when the host sets no limit of its own. */
const OPEN_BYTES = 256 * 1024 * 1024;
/** The bodies all saved sessions open in tabs may hold together (the live capture's own budget, DebuggerSession). */
const VIEWS_BODY_BUDGET = 200 * 1024 * 1024;

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
    // bytes are not masked: only an image goes to the window as bytes; a binary protocol is decoded on the host (debug.view), where its text is masked
    requestBodyBase64: undefined,
    responseBodyBase64: /^image\//i.test(e.contentType ?? '') ? e.responseBodyBase64 : undefined,
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


export function debuggerHandlers(be: Backend): Handlers {
  const state: DebuggerState = (be.debugger ??= newDebuggerState());
  const deepSearch = new DeepSearchCache();
  const status = () => ({
    /** The saved session on screen (a Debugger tab), when not the live capture. */
    viewing,
    lan: !!state.lan,
    // rules that change what programs send or get (not ignore / highlight): the status bar shows them wherever you are
    changingRules: state.proxy ? activeRules(be, state).filter((r) => r.enabled && ['modify', 'reply', 'redirect', 'breakpoint', 'remap', 'fault', 'frame'].includes(r.kind)).length : 0,
    speed: state.speed ?? null,
    running: !!state.proxy,
    paused: !!state.paused,
    url: state.proxy?.url,
    port: state.proxy?.port,
    exchanges: state.exchanges.length,
    systemProxy: !!state.systemProxy,
    autosave: !!state.autosave,
    decrypt: !!state.decrypt,
    noDecrypt: state.noDecrypt ?? [],
  });
  /**
   * The session on screen (WF-19 Debugger tabs): the live capture, or a saved session opened in its own tab — read from
   * its HAR into memory (the last few kept), never into the live capture, which goes on capturing behind it. What the
   * grid reads and does (list, filters, details, bookmarks, delete, stats, HAR export, Create flow, Save to collection)
   * acts on the session on screen.
   */
  const views = new Map<string, DebuggerState>();
  let viewing: string | undefined;
  /** A saved session's file in memory (read once; again after it was saved anew): at most 4 are kept. */
  const viewOf = (file: string): DebuggerState => {
    const had = views.get(file);
    // the order of the map is the order they were last shown in
    if (had) return views.delete(file), views.set(file, had), had;
    if (!existsSync(file)) throw new ApsError('ValidationError', `No saved session "${basename(file, '.har')}"`);
    let har: unknown;
    try {
      har = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new ApsError('ValidationError', `The saved session "${basename(file, '.har')}" is not a HAR file`);
    }
    const v = newDebuggerState();
    v.session.load(exchangesFromHar(har));
    views.set(file, v);
    // the saved sessions in memory share one body budget (the live capture's): beyond it, or beyond 4 sessions, the
    // longest unseen goes (it is read again from its file when its tab shows). Each kept its own before: 5 × 200 M.
    const held = () => [...views.values()].reduce((n, x) => n + x.session.bodyBytes, 0);
    for (const k of [...views.keys()]) {
      if (views.size <= 4 && held() <= VIEWS_BODY_BUDGET) break;
      if (k !== file) views.delete(k);
    }
    return v;
  };
  const shown = (): DebuggerState => {
    if (!viewing) return state;
    try {
      return viewOf(viewing);
    } catch {
      viewing = undefined; // gone meanwhile: the live capture
      return state;
    }
  };
  state.view = () => shown().exchanges;
  // the output builders (output.save) read the session on screen as HAR through this, not through the RPC by name
  be.outputProviders.har = () => exchangesToHar(shown().exchanges, be.logger.redactor, ENGINE_VERSION);
  const sessionsDir = () => be.ws.path(SESSIONS_DIR);
  const saver = sessionSaver(be, state);
  const sessionFile = (name: string) => {
    const file = captureSessionFileName(name); // the same name a capture ref (History) finds it by
    if (file === '.har') throw new ApsError('ValidationError', 'A session needs a name');
    // the AutoSave is not in the workspace (it holds whatever the machine sent): the app's data folder
    if (file === `${AUTOSAVE}.har`) return saver.autosaveFile();
    return be.ws.safePath(file, sessionsDir());
  };
  const writeSession = async (name: string) => {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    const file = sessionFile(name);
    if (file === saver.autosaveFile()) throw new ApsError('ValidationError', `"${AUTOSAVE}" is the name of the AutoSave file; pick another name`);
    if (file !== viewing) views.delete(file); // a tab showing it later reads it again (the one on screen stays as shown)
    const count = state.exchanges.length;
    await saver.save(file); // made and written a few exchanges at a time, atomic and private: a crash while saving keeps the previous file
    return { name: basename(file, '.har'), path: file, exchanges: count };
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
    state.autosave = setInterval(() => void saver.autosaveNow(), 60_000);
    (state.autosave as { unref?(): void }).unref?.();
  };
  // the window learns of new and changed exchanges at most once per 50 ms (a flood is thousands a second); it reads
  // the changes itself (debug.changes), so the signal carries only how many and the latest ids
  const signals = batcher<string>((ids) => be.host.emit('debug.exchange', { phase: 'batch', count: ids.length, ids: [...new Set(ids.slice(-20))] }), 50);
  /** The folder of the system proxy record (state.systemProxy on disk): what the start of the app repairs. */
  const proxyDir = () => join(be.host.appDir, 'debugger');
  // a system proxy a crashed or killed TestPion left pointing here is put back before anything switches it again
  const repaired = repairSystemProxy(proxyDir()).then(
    (r) => {
      if (r === 'restored') be.logger.warn('The system proxy still pointed at TestPion from an earlier run: it was put back');
    },
    (e) => be.logger.warn(`Could not check the system proxy: ${(e as Error).message}`),
  );
  saver.tidy(sessionsDir);
  /** Point the system proxy at the running proxy (the setting is kept on disk first). */
  const engageSystem = async () => {
    await repaired;
    if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
    state.systemProxy = await engageSystemProxy(proxyDir(), state.proxy.url);
    be.logger.info(`System proxy set to ${state.proxy.url}`);
  };
  /** Put the system proxy back; when that fails the setting and its file are kept so the next stop, quit or start tries again. */
  const restoreSystem = async () => {
    const s = state.systemProxy;
    if (!s) return;
    try {
      await disengageSystemProxy(proxyDir(), s);
      state.systemProxy = undefined;
      be.logger.info('System proxy restored');
    } catch (e) {
      be.logger.warn(`Could not restore the system proxy: ${(e as Error).message}`);
    }
  };
  state.release = async () => {
    stopAutosave();
    // the system proxy first and with a limit of its own: nothing may keep the computer pointing at a proxy that is gone
    await settleWithin([restoreSystem()], 3000);
    // quitting (or a workspace switch) with exchanges not yet saved: the write in flight is awaited, then what changed since is written
    await settleWithin([saver.flush()], 2500);
  };
  // one store for every capture mode: what the reverse proxy forwards joins the session like the proxy's exchanges
  state.capture = (e) => {
    state.session.add(e);
    changed(state, e);
    touch();
    signals.push(e.id);
  };
  const stop = async () => {
    state.paused = false;
    for (const bp of [...(state.breakpoints?.values() ?? [])]) bp.resolve(undefined);
    await state.proxy?.close();
    state.proxy = undefined;
    stopAutosave();
    await restoreSystem();
    // kept as the AutoSave, written in the background; Stop answers once it is done or after a moment (it goes on, quitting waits for it)
    await settleWithin([saver.flush()], 1500);
    return status();
  };

  const trust = trustChecker(); // the root's trust in the store, kept for 30 s
  const handlers: Handlers = {
    'debug.status': () => status(),
    /** Send one request through the proxy from this process (the e2e suite's "program"; also a quick check that the proxy works). */
    'debug.selfTest': ({ url, method, headers, body }: { url: string; /** Plain http only: the request to send (a flow to record in the e2e suite). */ method?: string; headers?: Record<string, string>; body?: string }) =>
      new Promise<{ status: number; body?: string }>((resolve, reject) => {
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
            // close once: the server's close (or more frames) can still arrive after ours, and a write after end throws
            // in a socket handler, where nothing catches it (Electron then stops the whole main process at an error box)
            const close = () => {
              if (!socket.writableEnded) socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
              resolve({ status: res.statusCode ?? 101 });
            };
            socket.on('error', () => undefined);
            socket.on('data', () => ++seen === 2 && close());
            setTimeout(close, 3000);
          });
          // no upgrade (the server is down, the proxy answered 502): the status, not a wait for ever
          req.on('response', (res) => (res.resume(), resolve({ status: res.statusCode ?? 0 })));
          req.setTimeout(10_000, () => req.destroy(new Error('No answer through the proxy in 10 s')));
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
        const req = httpRequest({ host: '127.0.0.1', port: state.proxy.port, method: method ?? 'GET', path: target.href, headers: { host: target.host, 'user-agent': 'TestPion self-test', ...headers } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.length < 64 && chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, ...(method ? { body: Buffer.concat(chunks).toString('utf8') } : {}) }));
        });
        req.on('error', reject);
        req.end(body);
      }),
    /** Start the proxy; programs point at its URL (HTTP_PROXY=…, a browser's proxy setting, --proxy-server=…). */
    'debug.start': async ({ port, lan }: { port?: number; lan?: boolean } = {}) => {
      await state.proxy?.close();
      const protos = protoDecoder(be);
      state.lan = !!lan;
      state.proxy = await startDebuggerProxy({
        session: state.session,
        port,
        lan,
        grpcDecode: protos.decode,
        rootCertificatePem: () => (state.decrypt ? certificateOf(be, state).certPem : undefined),
        rules: () => activeRules(be, state),
        speed: () => state.speed,
        workspaceRoot: () => be.ws.root,
        listing: () => !state.paused,
        onBreakpoint: (e, phase) => holdBreakpoint(be, state, e, phase),
        decrypt: {
          leafFor: (host) => (certificateOf(be, state), state.leafFor!(host)),
          enabled: (host) => !!state.decrypt && !hostMatches(state.noDecrypt, host),
        },
        onExchange: (e) => {
          changed(state, e);
          touch();
          signals.push(e.id);
        },
      });
      startAutosave();
      be.logger.info(`HTTP Debugger listening on ${state.proxy.url}`);
      // the proxy moved to another port while the system proxy was ours: the system follows
      if (state.systemProxy) {
        try {
          state.systemProxy = await engageSystemProxy(proxyDir(), state.proxy.url, state.systemProxy);
        } catch (e) {
          be.logger.warn(`Could not point the system proxy at ${state.proxy.url}: ${(e as Error).message}`);
          await restoreSystem();
        }
      }
      return status();
    },
    'debug.stop': stop,
    /** Pause or resume listing (FG-13): the proxy keeps forwarding, nothing new is listed while paused. */
    'debug.pause': ({ on }: { on?: boolean } = {}) => {
      state.paused = on ?? !state.paused;
      be.logger.info(`HTTP Debugger: listing ${state.paused ? 'paused' : 'resumed'}`);
      return status();
    },

    /* ---- capture helpers: the ways a program ends up sending through the proxy */

    /**
     * A phone or another computer: the addresses of this computer on the local networks, each with the proxy URL and
     * a QR code of the page the proxy serves (proxy settings, and the root certificate when HTTPS is decrypted).
     */
    'debug.lan': async () => {
      const port = state.proxy?.port;
      const addresses = await Promise.all(
        lanAddresses().map(async (ip) => {
          // the QR code opens the page with the pairing secret: that pairs the phone's address for 8 hours (the proxy refuses unpaired devices)
          const page = port ? `http://${ip}:${port}/${state.proxy?.pairingSecret ? `?pair=${encodeURIComponent(state.proxy.pairingSecret)}` : ''}` : undefined;
          return { ip, proxy: port ? `${ip}:${port}` : undefined, page, qrSvg: page ? await (await qrcode()).toString(page, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : undefined };
        }),
      );
      return { running: !!state.proxy, lan: !!state.lan, port, decrypt: !!state.decrypt, addresses, pairingSecret: state.proxy?.pairingSecret };
    },
    /** The browsers found on this computer, the shell lines to paste, and whether the system proxy is ours. */
    'debug.captureOptions': () => ({
      browsers: installedBrowsers().map(({ name, label, systemProxy }) => ({ name, label, systemProxy: !!systemProxy })),
      shells: state.proxy ? proxyShellLines(state.proxy.url, state.decrypt ? certificateOf(be, state).path : undefined) : [],
      systemProxy: !!state.systemProxy,
      platform: process.platform,
    }),
    /**
     * A browser with a throw-away profile that sends through the proxy. Safari has no proxy of its own: the system
     * proxy points here first (restored on stop, like "everything on this computer").
     */
    'debug.openBrowser': async ({ browser, url }: { browser?: BrowserName; url?: string }) => {
      if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
      if (url !== undefined) url = checkStartUrl(url); // before anything is changed
      if (installedBrowsers().find((b) => b.name === browser)?.systemProxy && !state.systemProxy) await engageSystem();
      const r = openBrowserWithProxy(state.proxy.url, browser, url);
      be.logger.info(`Debugger: opened ${r.browser} through ${state.proxy.url}`);
      return r;
    },
    /** A terminal whose shell sends through the proxy. */
    'debug.openTerminal': () => {
      if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
      // with HTTPS decryption on, the shell also trusts the root certificate (NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, SSL_CERT_FILE, CURL_CA_BUNDLE)
      return openTerminalWithProxy(state.proxy.url, state.decrypt ? certificateOf(be, state).path : undefined);
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
        trust.invalidate();
      }
      let note: string | undefined;
      if (action === 'install') {
        trust.invalidate();
        const r = await installRootCertificate(root);
        trust.invalidate();
        note = `Installed into ${r.where}${r.removedOld ? ` (${r.removedOld} older TestPion root${r.removedOld === 1 ? '' : 's'} removed)` : ''}${r.leftOld ? ` (${r.leftOld} older TestPion root${r.leftOld === 1 ? '' : 's'} could not be removed: remove them by hand)` : ''}`;
      }
      if (action === 'remove') {
        await removeRootCertificate(root);
        trust.invalidate();
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
      // `known` is false when this computer could not say (Linux, a tool that failed): `trusted` is then absent, never a "no"
      const { trusted, known } = await trust.check(root);
      return { path: root.path, fingerprint: root.fingerprint, notAfter: root.notAfter, ...rootStanding(root.certPem), trusted, known, instructions: trustInstructions(root.path), note, platform: process.platform };
    },
    /** Switch the system proxy to ours (every program that honours it) and back. */
    'debug.systemProxy': async ({ on }: { on: boolean }) => {
      if (on) {
        if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first');
        if (!state.systemProxy) await engageSystem();
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
      limit,
      offset = 0,
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
      /** How many, newest first in what is cut (the list stays oldest first): 200 rows / 5000 ids by default; 0 is all. */
      limit?: number;
      /** Skip this many of the newest (paging back through the session). */
      offset?: number;
    } = {}) => {
      const needle = text?.toLowerCase();
      const needleRe = needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined;
      const l = listOf(shown());
      const pass = (e: DebuggerExchange) => {
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
        return true;
      };
      const lineHit = (e: DebuggerExchange) => `${e.method} ${e.url} ${e.application ?? ''} ${e.contentType ?? ''} ${e.status ?? ''}`.toLowerCase().includes(needle!);
      // (a case-insensitive pattern: the bodies - up to 200 MB in all - are not lowercased into copies for every search)
      const bodiesHit = (e: DebuggerExchange) => {
        const h = (x?: Record<string, string>) => Object.entries(x ?? {}).some(([k, v]) => needleRe!.test(k) || needleRe!.test(v));
        return h(e.requestHeaders) || h(e.responseHeaders) || (!!e.requestBody && needleRe!.test(e.requestBody)) || (!!e.responseBody && needleRe!.test(e.responseBody));
      };
      const page = (out: DebuggerExchange[]) => {
        const n = limit ?? (idsOnly ? 5000 : 200);
        const end = Math.max(0, out.length - Math.max(0, offset));
        const rows = n > 0 ? out.slice(Math.max(0, end - n), end) : out.slice(0, end);
        if (idsOnly) return rows.map((e) => e.id);
        return rows.map((e) => leanRow(be, shown(), e));
      };
      const candidates = shown().exchanges.filter(pass);
      if (!needle) return page(candidates);
      if (!deep) return page(candidates.filter(lineHit));
      // headers and bodies: an exchange is read again only when it changed since the last search of this text, and the reading
      // gives the main process a turn every few milliseconds
      const hits = new Set<DebuggerExchange>();
      return inSlices(candidates, (e) => {
        if (lineHit(e) || deepSearch.hit(needle, e, l.revs.get(e) ?? 0, bodiesHit)) hits.add(e);
      }).then(() => page(candidates.filter((e) => hits.has(e))));
    },
    /**
     * The grid's changes since the window last asked: the rows added or changed after revision `since`, or every row
     * (reset) when the list was replaced since `epoch`; `firstSeq` drops the rows the session no longer keeps.
     */
    'debug.changes': ({ epoch, since = 0 }: { epoch?: number; since?: number } = {}) => {
      const st = shown();
      const l = listOf(st);
      const reset = epoch !== l.epoch;
      // what the answer says is fixed now; a row that changes while a long list is built is simply sent again next time (its revision is past `rev`)
      const head = { epoch: l.epoch, rev: l.rev, reset };
      const tail = { firstSeq: st.exchanges.length ? l.seqs.get(st.exchanges[0]!) : undefined, total: st.exchanges.length };
      const picked = st.exchanges.filter((e) => reset || (l.revs.get(e) ?? 0) > since);
      if (picked.length <= LEAN_AT_ONCE) return { ...head, rows: picked.map((e) => leanRow(be, st, e)), ...tail };
      // a first load or a view switch: thousands of rows, built in slices so the proxy and the window's calls are not held for the whole list
      const rows: Array<ReturnType<typeof leanRow>> = [];
      return inSlices(picked, (e) => void rows.push(leanRow(be, st, e)), 8).then(() => ({ ...head, rows, ...tail }));
    },
    /** Requests the workspace's mock servers received (the Incoming tab), newest last. */
    'debug.incoming': () => state.incoming ?? [],
    'debug.clearIncoming': () => {
      state.incoming = [];
    },
    /** A body view of one exchange (image facts, XML tree, form parts, GraphQL, MessagePack, Protobuf, SignalR, Socket.IO, caching, TLS): decoded on the host, masked like the bodies. */
    'debug.bodyView': ({ id, view, side }: { id: string; view: string; side?: string }) => {
      const e = shown().exchanges.find((x) => x.id === id);
      if (!e) throw new ApsError('ValidationError', 'That exchange is no longer in the session');
      return runExchangeView(be, e, view, side);
    },
    /** One exchange whole (bodies included, redacted), with the Auth inspector's reading of its credentials (never the secret itself). */
    'debug.exchange': ({ id }: { id: string }) => {
      const e = shown().exchanges.find((x) => x.id === id);
      if (!e) throw new ApsError('ValidationError', 'That exchange is no longer in the session');
      const size = (h?: Record<string, string>) => Object.entries(h ?? {}).reduce((n, [k, v]) => n + k.length + 2 + v.length + 2, 0);
      // the sizes as sent (the headers shown are masked)
      return { ...redacted(be, e), auth: authOf(be, e), requestHeaderBytes: size(e.requestHeaders), responseHeaderBytes: e.responseHeaders ? size(e.responseHeaders) : undefined };
    },
    'debug.bookmark': ({ id, on }: { id: string; on: boolean }) => {
      const e = shown().exchanges.find((x) => x.id === id);
      if (e) {
        e.bookmarked = on;
        changed(shown(), e);
      }
      touch();
      return true;
    },
    /** A note and a colour mark on exchanges (FG-11): an empty value removes it. Saved in the HAR as the entry's comment. */
    'debug.annotate': ({ ids, note, mark }: { ids: string[]; note?: string; mark?: string }) => {
      let a: ReturnType<typeof cleanAnnotation>;
      try {
        a = cleanAnnotation({ note, mark });
      } catch (err) {
        throw new ApsError('ValidationError', (err as Error).message);
      }
      const set = new Set(ids);
      const hit = shown().exchanges.filter((x) => set.has(x.id));
      for (const e of hit) {
        annotate(e, a);
        changed(shown(), e);
      }
      touch();
      return { annotated: hit.length };
    },
    'debug.delete': ({ ids }: { ids: string[] }) => {
      const set = new Set(ids);
      shown().session.remove(set);
      listOf(shown()).epoch = ++epochSeq;
      listOf(shown()).rev++;
      touch();
      return status();
    },
    'debug.clear': () => {
      shown().session.clear();
      replaced(shown());
      if (!viewing) state.dirty = false;
      // the window refreshes whoever cleared (a menu, a shortcut, an agent)
      be.host.emit('debug.exchange', { phase: 'cleared' });
      return status();
    },
    /** Statistics of the session: by host, by content type, the largest and the slowest, the timeline. */
    'debug.stats': () => {
      const l = listOf(shown());
      return cachedSessionStats(shown().exchanges, `${l.epoch}:${l.rev}:${shown().exchanges.length}`, (u) => be.logger.redactor.redactUrl(u));
    },
    /** The session as HAR (the same format the history exports), for saving and for other tools. */
    'debug.har': () => exchangesToHar(shown().exchanges, be.logger.redactor, ENGINE_VERSION),

    /* ---- sessions: HAR files in the workspace's debugger/ folder (never committed) */

    /**
     * Show a saved session (its tab) or, without `session`, the live capture. The saved session is read from its HAR
     * once and kept in memory while its tab may come back (at most 4); the live capture is not touched.
     */
    'debug.view': ({ session }: { session?: string } = {}) => {
      if (!session) viewing = undefined;
      else {
        const file = sessionFile(session);
        viewOf(file);
        viewing = file;
      }
      be.host.emit('debug.exchange', { phase: 'session' });
      return status();
    },
    'debug.sessions': () => {
      const dir = sessionsDir();
      saver.tidy(sessionsDir); // an AutoSave an earlier version left in the workspace moves to the app's data folder
      const entry = (file: string) => {
        const st = statSync(file);
        const name = basename(file, '.har');
        return { name, path: file, bytes: st.size, savedAt: st.mtime.toISOString(), autosave: name === AUTOSAVE };
      };
      const own = existsSync(dir) ? readdirSync(dir).filter((f) => /\.har$/i.test(f) && f.toLowerCase() !== `${AUTOSAVE}.har`) : [];
      // the AutoSave is listed with the others, but lives in the app's data folder
      return [...own.map((f) => entry(join(dir, f))), ...(existsSync(saver.autosaveFile()) ? [entry(saver.autosaveFile())] : [])].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    'debug.saveSession': async ({ name }: { name: string }) => {
      if (!state.exchanges.length) throw new ApsError('ValidationError', 'Nothing captured yet');
      const rev = listOf(state).rev;
      const r = await writeSession(name);
      if (listOf(state).rev === rev) state.dirty = false; // nothing changed while it was written
      // History: this capture session, saved (opens it in the Debugger again)
      const entry = recordCaptureSession(be.ws, state.exchanges, { result: 'session', ref: { kind: 'capture', name: r.name }, target: r.name }, be.logger.redactor);
      return { ...r, historyId: entry.id };
    },
    /** Open a saved session (or any HAR file by path): its exchanges replace the session, or join it with `append`. */
    'debug.openSession': ({ name, path, text, base64, append }: { name?: string; path?: string; text?: string; /** A SAZ (zip) file's bytes. */ base64?: string; append?: boolean }) => {
      // a pasted text, a dropped file or a path is bounded by what this host accepts for an import (the bridge's own body limit is the same)
      const cap = be.host.importBytes ?? OPEN_BYTES;
      const tooBig = () => new ApsError('ValidationError', `That session is larger than the ${Math.round(cap / 1024 / 1024)} MB the Debugger opens`);
      if ((base64 && base64.length * 0.75 > cap) || (text !== undefined && text.length > cap)) throw tooBig();
      let file: string | undefined;
      if (!base64 && text === undefined) {
        file = path ? be.ws.safePath(path) : sessionFile(name ?? '');
        if (existsSync(file) && statSync(file).size > cap) throw tooBig();
      }
      const bytes = base64 ? Buffer.from(base64, 'base64') : text !== undefined ? Buffer.from(text, 'utf8') : readFileSync(file!);
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
      state.session.load(loaded, append);
      if (append) for (const e of loaded) changed(state, e);
      else replaced(state);
      state.dirty = false;
      be.host.emit('debug.exchange', { phase: 'session' });
      return { ...status(), loaded: loaded.length };
    },
    'debug.deleteSession': ({ name }: { name: string }) => {
      const f = sessionFile(name);
      if (existsSync(f)) removeOwned(f);
      views.delete(f);
      if (viewing === f) {
        viewing = undefined; // its tab shows the live capture again
        be.host.emit('debug.exchange', { phase: 'session' });
      }
      return true;
    },
  };
  // the status bar shows the Debugger wherever you are (running, rules that change traffic, the system proxy):
  // whatever changes that state says so
  for (const name of ['debug.start', 'debug.stop', 'debug.pause', 'debug.systemProxy', 'debug.openBrowser', 'debug.decrypt', 'debug.clear']) {
    const h = handlers[name]!;
    handlers[name] = async (p: unknown) => {
      const r = await h(p);
      be.host.emit('debug.state', status());
      return r;
    };
  }
  return handlers;
}
