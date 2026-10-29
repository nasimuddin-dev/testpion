import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { createLanGuard } from './lan-guard.js';
import { guardedLookup, upstreamAgents } from './upstream-guard.js';
import { PROXY_PAGE_HEADERS, proxyPageHtml, remoteHttpAgent } from './proxy-page.js';
import { createSecureContext, TLSSocket } from 'node:tls';
import {
  connect as h2connect,
  createServer as createH2Server,
  constants as h2c,
  type ClientHttp2Session,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type IncomingHttpHeaders as H2Headers,
} from 'node:http2';
import { duplexPair } from 'node:stream';
import { applicationOfPort, ownerOfProcess, type ProgramInfo } from './programs.js';
import { DebuggerSession } from './session.js';
export { applicationOfPort, ownerOfProcess, type ProgramInfo };
import { PassThrough, type Duplex, type Readable } from 'node:stream';
import { ApsError } from '../errors.js';
import { randomBytes } from 'node:crypto';
import { sleep } from '../util/concurrency.js';
import { flattenHeaders } from '../util/headers.js';
import { BoundedMap } from '../util/collections.js';
import { currentNet } from '../net/proxy.js';
import { applyRequestScripts, applyResponseScripts } from './script-rules.js';
import { applyHeaderEdits, decideRequest, highlightRuleForResponse, ruleMatches, type DebuggerRule, type HighlightStyle } from './rules.js';
import { sseParser, webSocketFrameParser, type DebuggerSseEvent, type WebSocketFrame } from './frames.js';
import { forH2, forH2Out, holdBody, isH2, textLike, withoutPseudo } from './http-util.js';
import { decodeBody, dropConnection, hangRequest, localReply, redirectTarget, rewriteBody, writeCutResponse } from './shaping.js';
import { Pacer, pacedBody, type NetworkSpeed } from './network-speed.js';
import { createFrameRelay, frameBreaker, frameDecider, responseHead } from './ws-relay.js';
import type { LeafCertificate } from './certificate.js';
import { keepsBytes, type TlsInfo } from '@testpion/shared';
import { watchTls } from './tls-info.js';
import { GRPC_STATUS, grpcDecoder, grpcDecompress, grpcMessageReader, grpcMethodOf, type GrpcCapture } from './grpc.js';

/**
 * Exchange and connection ids: a random prefix per process and a counter (a flood makes thousands a second; a random
 * id each cost a call into the system's random source). Unique within the app's run and across saved sessions.
 */
const ID_RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
let idSeq = 0;
const shortId = (prefix: string) => `${prefix}${ID_RUN}-${(++idSeq).toString(36)}`;

/**
 * The HTTP Debugger's proxy (planning/http-debugger.md): a forward proxy other programs point at (HTTP_PROXY, a
 * browser's proxy setting, --proxy-server). Plain HTTP requests are captured whole. HTTPS goes through as an opaque
 * CONNECT tunnel, listed by host, unless decryption is on: then the proxy answers the program with a certificate for
 * the host signed by the TestPion root (DBG-4) and the requests inside are captured like plain ones. WebSocket
 * upgrades are followed frame by frame; Server-Sent Events event by event. Every exchange carries timings, sizes
 * and, best effort, the program that sent it. Rules (DBG-3) act on the way: ignore, highlight, modify, reply,
 * redirect, breakpoints.
 */
export type { DebuggerExchange, BreakpointEdits, DebuggerProxyOptions } from './proxy-types.js';
import type { DebuggerExchange, BreakpointEdits, DebuggerProxyOptions } from './proxy-types.js';

/** A tunnel whose requests are read: where they go, who sent them, how many came, its connection id. */
/** Exchanges of devices on the network: their connections use guardedLookup. */
const remoteExchanges = new WeakSet<object>();

interface TunnelOrigin {
  /** The tunnel was opened by a device on the network. */
  remote?: boolean;
  scheme: 'http' | 'https';
  host: string;
  port: number;
  clientPort: number;
  requests: number;
  id: string;
}

export interface DebuggerProxy {
  url: string;
  port: number;
  /** LAN mode: the secret a phone or another computer pairs with (in the QR code's address, or as the proxy password). */
  pairingSecret?: string;
  /** The captured exchanges (the session's array). */
  exchanges: DebuggerExchange[];
  session: DebuggerSession;
  close(): Promise<void>;
  /** Forget captured exchanges (the server keeps running). */
  clear(): void;
  /** How many requests each rule acted on (by rule id) since the start or the last reset. */
  ruleHits(): Record<string, number>;
  resetRuleHits(): void;
}

const MAX_FRAMES = 500;
/** The program that owns a local TCP port, best effort, per platform; undefined when unknown. */
export async function startDebuggerProxy(opts: DebuggerProxyOptions = {}): Promise<DebuggerProxy> {
  const maxBody = opts.maxBodyBytes ?? 512 * 1024;
  const session = opts.session ?? new DebuggerSession({ maxBodyBytes: opts.maxSessionBodyBytes });
  const exchanges = session.items;
  const appOf = opts.applicationOf ?? applicationOfPort;
  const appCache = new BoundedMap<number, Promise<string | ProgramInfo | undefined>>(500);
  /** Hits per rule, and the rules already counted for an exchange (a highlight is checked again on the response). */
  const hits = new Map<string, number>();
  const counted = new WeakMap<DebuggerExchange, Set<string>>();
  const countHit = (e: DebuggerExchange, id: string) => {
    let seen = counted.get(e);
    if (!seen) counted.set(e, (seen = new Set()));
    if (seen.has(id)) return;
    seen.add(id);
    hits.set(id, (hits.get(id) ?? 0) + 1);
  };
  const decideAndCount = (rules: DebuggerRule[], e: DebuggerExchange) => {
    const d = decideRequest(rules, e, opts.random);
    if (opts.listing && !opts.listing()) d.ignore = true; // paused: forwarded, not listed
    for (const id of d.appliedIds) countHit(e, id);
    // the first highlight's style goes with its colour
    const hl = rules.find((r) => r.enabled && r.kind === 'highlight' && d.appliedIds.includes(r.id));
    if (hl?.style) e.highlightStyle = hl.style;
    return d;
  };
  /** Highlights that need the response (status, time, size, a column condition). */
  const responseHighlight = (e: DebuggerExchange) => {
    const r = highlightRuleForResponse(rulesNow(), e);
    if (!r) return;
    e.highlight = r.color ?? 'yellow';
    e.highlightStyle = r.style;
    countHit(e, r.id);
  };
  /** The program (and its process id) on the exchange. */
  const setApp = (e: DebuggerExchange, a: string | ProgramInfo | undefined) => {
    if (!a) return;
    if (typeof a === 'string') e.application = a;
    else {
      e.application = a.name;
      if (a.pid) e.pid = a.pid;
      if (a.user) e.user = a.user;
    }
    // the lookup often ends after the exchange was listed: say it changed
    if (recorded.has(e)) opts.onExchange?.(e, 'update');
    // the account, looked up once per process (and when it comes, the exchange changed again)
    if (e.pid && !e.user)
      void ownerFor(e.pid).then((u) => {
        if (!u) return;
        e.user = u;
        if (recorded.has(e)) opts.onExchange?.(e, 'update');
      });
  };
  const owners = new BoundedMap<number, Promise<string | undefined>>(500);
  const ownerFor = (pid: number) => {
    let p = owners.get(pid);
    if (!p) {
      p = (opts.ownerOf ?? ownerOfProcess)(pid).catch(() => undefined);
      owners.set(pid, p);
    }
    return p;
  };
  const recorded = new WeakSet<DebuggerExchange>();
  /** The Network speed an exchange was started under (it keeps it even if the switch changes meanwhile). */
  const shapes = new WeakMap<DebuggerExchange, NetworkSpeed>();
  /** Rules that decide on the program need it before the request is decided: wait for the lookup (at most 1.5 s). */
  const needsProgram = (rules: DebuggerRule[]) => rules.some((r) => r.enabled && (r.kind === 'only' || r.kind === 'ignore') && (r.match.application || r.match.where?.column === 'application'));
  const programFirst = (p: Promise<unknown>, rules: DebuggerRule[]) => (needsProgram(rules) ? Promise.race([p, sleep(1500)]) : undefined);
  /** Tunnels whose requests are read (decrypted TLS, plaintext HTTP/1 or h2c inside a CONNECT): the origin they go to. */
  const tlsOrigins = new WeakMap<object, TunnelOrigin>();
  /** A connection id per client socket (the HTTP/2 tree groups streams by it). */
  const connectionIds = new WeakMap<object, string>();
  const connectionOf = (socket: object) => {
    let id = connectionIds.get(socket);
    if (!id) connectionIds.set(socket, (id = shortId('conn-')));
    return id;
  };
  const decodeGrpc = opts.grpcDecode ?? grpcDecoder(new Map());
  /** HTTP/2 sessions to servers (gRPC is forwarded over HTTP/2, trailers and all), one per origin. */
  const h2Sessions = new Map<string, ClientHttp2Session>();
  const application = (port: number) => {
    let p = appCache.get(port);
    if (!p) {
      p = appOf(port)
        .catch(() => undefined)
        .then((a) => {
          if (!a) appCache.delete(port);
          return a;
        });
      appCache.set(port, p);
    }
    return p;
  };
  const record = (e: DebuggerExchange, phase: 'request' | 'response') => {
    if (phase === 'request') {
      recorded.add(e);
      session.add(e);
    } else session.account(e);
    opts.onExchange?.(e, phase);
  };
  /** Streams (frames, events) report at most a few times a second. */
  const throttled = (e: DebuggerExchange) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return () => {
      if (t) return;
      t = setTimeout(() => {
        t = undefined;
        session.account(e); // what the stream holds so far counts against the session's budget
        opts.onExchange?.(e, 'response');
      }, 250);
    };
  };
  const rulesNow = () => opts.rules?.() ?? [];
  const net = currentNet(); // the session that started the proxy: its certificates apply to its connections
  const trustedCa = () => net.trustedCa();
  const upstreamTls = () => ({ ca: trustedCa(), rejectUnauthorized: !opts.decrypt?.insecureUpstream });
  /*
   * One https.Agent for the upstream requests of a trust configuration: with the CA list in every request's options (hundreds of
   * certificates) each request hashed it to find its agent. A new one is made only when the trusted CAs change.
   */
  const upstreamHttps = upstreamAgents(trustedCa, () => !!opts.decrypt?.insecureUpstream);
  const remoteHttp = remoteHttpAgent(); // plain-HTTP keep-alive pool of the devices on the network
  /** TLS contexts of the leaf certificates handed to clients, by certificate (parsing the PEM for every tunnel was repeated work). */
  const contexts = new BoundedMap<string, ReturnType<typeof createSecureContext>>(500);
  const contextFor = (leaf: { cert: string; key: string }) => {
    const hit = contexts.get(leaf.cert);
    if (hit) return hit;
    const made = createSecureContext({ cert: leaf.cert, key: leaf.key });
    contexts.set(leaf.cert, made);
    return made;
  };
  /** Where a request on this socket goes: the absolute URL of a proxy request, or the decrypted tunnel's origin plus the path. */
  const targetOf = (req: IncomingMessage | Http2ServerRequest, origin?: TunnelOrigin): URL => {
    if (origin) return new URL(req.url ?? '/', `${origin.scheme}://${origin.host}:${origin.port}`);
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  };

  /** LAN mode: who may use the proxy, and what a client that is not this computer may reach through it. */
  const lanGuard = createLanGuard(opts.lan, opts.lanSecret);
  const { pairingSecret, isOwnAddress, unpaired, refusedTarget } = lanGuard;

  /** Every connection to the proxy, so close() ends them all (tunnels, upgrades and injected TLS sockets included). */
  const sockets = new Set<Duplex>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => void handle(req, res, tlsOrigins.get(req.socket)));

  /** One request, from HTTP/1.1 (the proxy, or a tunnel) or HTTP/2 (a tunnel): captured, ruled, forwarded. */
  async function handle(req: IncomingMessage | Http2ServerRequest, res: ServerResponse, origin?: TunnelOrigin) {
    const t0 = Date.now();
    // a browser opening the proxy itself (a phone on the LAN): the page with the root certificate, not a loop to ourselves
    if (!origin && (req.url ?? '').startsWith('/')) return servePage(req, res);
    let target: URL;
    try {
      target = targetOf(req, origin);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (!origin) {
      // LAN mode: only a paired device uses the proxy, and none reaches this computer's own services through it
      if (unpaired(req.socket, req.headers['proxy-authorization'])) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="TestPion HTTP Debugger"', 'content-type': 'text/plain' }).end('Pair this device first: open the proxy address from the QR code, or use the pairing secret as the proxy password.');
        return;
      }
      if (await refusedTarget(req.socket, target.hostname)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('A device on the network cannot reach this computer through the proxy.');
        return;
      }
    }
    if (origin) origin.requests++;
    const h2 = isH2(res);
    const requestHeaders = flattenHeaders(req.headers as IncomingMessage['headers']);
    if (h2 && !requestHeaders.host && req.headers[':authority']) requestHeaders.host = String(req.headers[':authority']);
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'http',
      method: req.method ?? 'GET',
      url: target.href,
      host: target.host,
      clientPort: origin?.clientPort ?? req.socket?.remotePort ?? 0,
      requestHeaders,
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      httpVersion: h2 ? '2' : '1.1',
      connectionId: origin?.id ?? connectionOf(req.socket),
      ...(h2 ? { streamId: (res as unknown as Http2ServerResponse).stream.id } : {}),
      ...(origin?.scheme === 'https' ? { tls: true } : {}),
    };
    if (origin ? origin.remote : pairingSecret && !isOwnAddress(req.socket?.remoteAddress)) remoteExchanges.add(e);
    const speed = opts.speed?.();
    if (speed) shapes.set(e, speed);
    // gRPC: forwarded over HTTP/2 as it streams (messages both ways, then trailers); rules may ignore or highlight it
    if (h2 && /^application\/grpc/i.test(String(req.headers['content-type'] ?? ''))) {
      void application(e.clientPort).then((a) => {
        setApp(e, a);
      });
      const rules = rulesNow();
      const decision = rules.length || opts.listing ? decideAndCount(rules, e) : undefined;
      if (decision?.highlight) e.highlight = decision.highlight;
      if (decision?.applied.length) e.rules = decision.applied;
      return forwardGrpc(target, req as Http2ServerRequest, res as unknown as Http2ServerResponse, e, !decision?.ignore);
    }
    const appPromise = application(e.clientPort).then((a) => {
      setApp(e, a);
    });
    // the request body whole, before the rules: a breakpoint or a modify rule may change it
    const held = await holdBody(req as NodeJS.ReadableStream, opts.holdLimitBytes);
    let bodyToSend: Buffer | Readable | undefined;
    let streamed = false;
    if (held.over) {
      // too big to hold: sent on as it arrives (counted, the first part kept for the list), rules do not change this body
      streamed = true;
      const head = Buffer.concat(held.chunks, Math.min(held.bytes, maxBody)).subarray(0, maxBody);
      e.requestBodyBytes = held.bytes;
      e.requestBodyTruncated = true;
      if (textLike(req.headers['content-type'])) e.requestBody = head.toString('utf8');
      const pass = new PassThrough();
      for (const c of held.chunks) pass.write(c);
      (req as NodeJS.ReadableStream).on('data', (c: Buffer) => (e.requestBodyBytes += c.length));
      (req as NodeJS.ReadableStream).pipe(pass);
      bodyToSend = pass;
    } else {
      const reqBody = held.body;
      e.requestBodyBytes = reqBody.length;
      e.requestBodyTruncated = reqBody.length > maxBody;
      if (reqBody.length && textLike(req.headers['content-type'])) e.requestBody = reqBody.subarray(0, maxBody).toString('utf8');
      else if (reqBody.length && reqBody.length <= maxBody && keepsBytes(req.headers['content-type'])) e.requestBodyBase64 = reqBody.toString('base64');
      bodyToSend = reqBody.length ? reqBody : undefined;
    }

    const rules = rulesNow();
    await programFirst(appPromise, rules);
    const decision = rules.length || opts.listing ? decideAndCount(rules, e) : undefined;
    if (decision?.scripts) await applyRequestScripts(decision, e, opts.workspaceRoot?.()); // JS rule scripts (FG-21)
    if (decision?.ignore) {
      // not listed; forwarded as is
      forward(target, e.method, { ...requestHeaders }, bodyToSend, res, e, undefined, undefined, false);
      return;
    }
    if (decision) {
      if (decision.highlight) e.highlight = decision.highlight;
      if (decision.applied.length) e.rules = decision.applied;
      if (decision.requestHeaders) e.requestHeaders = applyHeaderEdits(e.requestHeaders, decision.requestHeaders);
      if (decision.requestBody !== undefined && !streamed) {
        e.requestBody = decision.requestBody;
        bodyToSend = Buffer.from(decision.requestBody, 'utf8');
        e.requestBodyBytes = bodyToSend.length;
        e.requestHeaders['content-length'] = String(bodyToSend.length);
      }
      if (decision.requestReplace && !streamed && Buffer.isBuffer(bodyToSend)) {
        const changed = rewriteBody(bodyToSend, String(req.headers['content-type'] ?? ''), req.headers['content-encoding'] as string | undefined, decision.requestReplace);
        if (changed) {
          bodyToSend = changed;
          e.requestBody = changed.subarray(0, maxBody).toString('utf8');
          e.requestBodyBytes = changed.length;
          e.requestHeaders['content-length'] = String(changed.length);
          delete e.requestHeaders['content-encoding'];
        }
      }
      if (decision.redirect) {
        target = redirectTarget(target, decision.redirect);
        e.redirectedTo = target.href;
      }
    }
    record(e, 'request');
    if (decision?.breakpoint === 'request' && opts.onBreakpoint) {
      const edits = await opts.onBreakpoint(e, 'request').catch(() => undefined);
      if (edits?.abort) {
        e.error = 'Aborted at the breakpoint';
        e.durationMs = Date.now() - t0;
        res.writeHead(502, { 'content-type': 'text/plain' }).end('TestPion debugger: aborted at the breakpoint');
        record(e, 'response');
        return;
      }
      if (edits) {
        e.edited = true;
        if (edits.method) e.method = edits.method.toUpperCase();
        if (edits.url) {
          try {
            target = new URL(edits.url);
            e.url = target.href;
            e.host = target.host;
          } catch {
            /* keep the URL */
          }
        }
        if (edits.headers) e.requestHeaders = edits.headers;
        if (edits.body !== undefined && !streamed) {
          e.requestBody = edits.body;
          bodyToSend = Buffer.from(edits.body, 'utf8');
          e.requestBodyBytes = bodyToSend.length;
          e.requestHeaders['content-length'] = String(bodyToSend.length);
        }
      }
    }
    if (decision?.delayMs) await sleep(decision.delayMs);
    if (decision?.fault && decision.fault.action !== 'truncate') {
      // a failure injected by a rule: the connection is cut, or the request is never answered
      const failed = (why: string) => {
        e.error = why;
        e.durationMs = Date.now() - t0;
        record(e, 'response');
      };
      if (decision.fault.action === 'drop') (dropConnection(res), failed('Connection dropped by a rule'));
      else hangRequest(res, decision.fault.timeoutMs, failed);
      return;
    }
    if (decision?.reply) {
      const r = decision.reply;
      if (r.delayMs) await sleep(r.delayMs);
      // map local: the body is a file of the workspace, read now
      const local = r.file || r.folder ? await localReply(opts.workspaceRoot?.(), r, target) : undefined;
      const headers = local?.headers ?? Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const status = local?.status ?? r.status;
      const body: string | Buffer = local?.body ?? r.body ?? '';
      if (body.length && !headers['content-type']) headers['content-type'] = 'application/json';
      e.repliedByRule = true;
      e.waitMs = Date.now() - t0;
      e.status = status;
      e.statusText = 'Rule';
      e.responseHeaders = headers;
      e.contentType = headers['content-type'];
      e.responseBody = typeof body === 'string' ? body : textLike(e.contentType) ? body.subarray(0, maxBody).toString('utf8') : undefined;
      e.responseBodyBytes = Buffer.byteLength(body);
      e.durationMs = Date.now() - t0;
      res.writeHead(status, isH2(res) ? forH2(headers) : headers).end(body);
      record(e, 'response');
      void appPromise;
      return;
    }
    // modify rules on the response, or a response breakpoint: the body is held whole, then sent
    const holdResponse = !!(decision?.hold || decision?.breakpoint === 'response');
    forward(target, e.method, e.requestHeaders, bodyToSend, res, e, decision, holdResponse ? (decision?.breakpoint === 'response' ? opts.onBreakpoint : undefined) : undefined, true);
  }

  /** The page a browser gets when it opens the proxy itself: how to use it, and the root certificate to download. */
  function servePage(req: IncomingMessage | Http2ServerRequest, res: ServerResponse) {
    const pem = opts.rootCertificatePem?.();
    // opening the page from the QR code (/?pair=<secret>) pairs this device's address
    const asked = /[?&]pair=([^&\s]+)/.exec(req.url ?? '');
    if (pairingSecret && asked && !isOwnAddress(req.socket?.remoteAddress) && lanGuard.secretMatches(asked[1]!.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))))) lanGuard.pair(req.socket.remoteAddress!);
    if (/^\/testpion-root\.(pem|crt|cer)$/.test(req.url ?? '')) {
      if (!pem) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('HTTPS decryption is off: no root certificate to download.');
      return void res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="testpion-root.crt"' }).end(pem);
    }
    const here = String(req.headers.host ?? (req.headers[':authority'] as string | undefined) ?? 'this-computer');
    res.writeHead(200, PROXY_PAGE_HEADERS).end(proxyPageHtml(here, !!pem));
  }

  /** A gRPC call over HTTP/2 to the server: messages both ways read along, trailers passed back, the status kept. */
  function forwardGrpc(target: URL, req: Http2ServerRequest, res: Http2ServerResponse, e: DebuggerExchange, listed: boolean) {
    const t0 = Date.parse(e.startedAt);
    const m = grpcMethodOf(target.pathname);
    const capture: GrpcCapture = { service: m?.service ?? '', method: m?.method ?? target.pathname, decodedWith: 'raw', requests: [], responses: [] };
    e.grpc = capture;
    e.contentType = String(req.headers['content-type'] ?? 'application/grpc');
    const read = (direction: 'request' | 'response', encoding: () => string | undefined) =>
      grpcMessageReader((bytes, compressed) => {
        const d = decodeGrpc(target.pathname, direction, compressed ? grpcDecompress(bytes, encoding()) : bytes);
        if (d.with === 'proto') capture.decodedWith = 'proto';
        const list = direction === 'request' ? capture.requests : capture.responses;
        list.push(d.value);
        if (list.length > MAX_FRAMES) list.shift();
        if (listed) report();
      });
    const report = throttled(e);
    let responseEncoding: string | undefined;
    const fromClient = read('request', () => String(req.headers['grpc-encoding'] ?? ''));
    const fromServer = read('response', () => responseEncoding);
    if (listed) record(e, 'request');
    // a session opened for this computer's own clients is never used for a device on the network (it was opened without the address check)
    const key = `${remoteExchanges.has(e) ? 'remote' : 'local'} ${target.origin}`;
    let session = h2Sessions.get(key);
    if (!session || session.closed || session.destroyed) {
      session = h2connect(target.origin, { ...(remoteExchanges.has(e) ? { lookup: guardedLookup } : {}), ...(target.protocol === 'https:' ? { ...upstreamTls(), ALPNProtocols: ['h2'] } : {}) });
      session.on('error', () => undefined);
      session.on('close', () => h2Sessions.delete(key));
      h2Sessions.set(key, session);
    }
    const headers: Record<string, string | string[]> = {
      ...forH2Out(req.headers as Record<string, string>),
      [h2c.HTTP2_HEADER_METHOD]: req.method ?? 'POST',
      [h2c.HTTP2_HEADER_PATH]: `${target.pathname}${target.search}`,
      [h2c.HTTP2_HEADER_AUTHORITY]: target.host,
    };
    delete headers.host;
    const up = session.request(headers, { endStream: false });
    if (session.socket?.remoteAddress) e.serverAddress = `${session.socket.remoteAddress}:${session.socket.remotePort}`;
    e.open = true;
    const finish = (error?: string) => {
      if (e.durationMs !== undefined) return;
      e.durationMs = Date.now() - t0;
      e.open = undefined;
      if (error) e.error = error;
      responseHighlight(e);
      if (listed) record(e, 'response');
    };
    const status = (h: H2Headers) => {
      if (h['grpc-status'] === undefined) return;
      capture.status = Number(h['grpc-status']);
      capture.statusName = GRPC_STATUS[capture.status] ?? String(capture.status);
      if (h['grpc-message']) capture.message = decodeURIComponent(String(h['grpc-message']));
    };
    req.on('data', (c: Buffer) => {
      e.requestBodyBytes += c.length;
      fromClient.push(c);
      up.write(c);
    });
    req.on('end', () => up.end());
    req.on('error', () => up.close());
    let trailersOnly = false;
    up.on('response', (h, flags) => {
      e.waitMs = Date.now() - t0;
      e.status = Number(h[':status']);
      e.statusText = '';
      e.responseHeaders = flattenHeaders(withoutPseudo(h as Record<string, string>) as IncomingMessage['headers']);
      responseEncoding = h['grpc-encoding'] as string | undefined;
      status(h);
      if (flags & h2c.NGHTTP2_FLAG_END_STREAM) {
        // trailers-only (an error answered at once): the status goes back in the headers that end the stream
        trailersOnly = true;
        res.stream.respond({ ...forH2Out(h as Record<string, string>), ':status': e.status }, { endStream: true });
        return;
      }
      res.writeHead(e.status, forH2(h as Record<string, string>));
    });
    up.on('data', (c: Buffer) => {
      e.responseBodyBytes += c.length;
      fromServer.push(c);
      res.write(c);
    });
    up.on('trailers', (t) => {
      e.trailers = flattenHeaders(withoutPseudo(t as Record<string, string>) as IncomingMessage['headers']);
      status(t);
      res.addTrailers(forH2(t as Record<string, string>) as Record<string, string>);
    });
    up.on('end', () => {
      if (!trailersOnly) res.end();
      finish();
    });
    up.on('error', (err: Error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
      finish(err.message);
    });
    res.on('close', () => {
      if (!up.closed) up.close(h2c.NGHTTP2_CANCEL);
    });
  }

  /** Send the request on and stream (or hold and edit) the response back. */
  function forward(
    target: URL,
    method: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer | Readable | undefined,
    res: ServerResponse,
    e: DebuggerExchange,
    decision: ReturnType<typeof decideRequest> | undefined,
    breakpoint: DebuggerProxyOptions['onBreakpoint'],
    listed: boolean,
  ) {
    const t0 = Date.parse(e.startedAt);
    const h = { ...headers };
    delete h['proxy-connection'];
    delete h['proxy-authorization'];
    // a remap that keeps the host: the Host header and the TLS name stay the original's, only the address is another
    const keepHost = !!(e.redirectedTo && decision?.redirect?.preserveHost);
    if (e.redirectedTo && !keepHost) h.host = target.host;
    const speed = shapes.get(e);
    const hold = !!(decision?.hold || breakpoint);
    const secure = target.protocol === 'https:';
    const sni = keepHost && !isIP(e.host.replace(/:\d+$/, '')) ? { servername: e.host.replace(/:\d+$/, '') } : {};
    const up = (secure ? httpsRequest : httpRequest)(target, { method, headers: h, timeout: 60_000, ...sni, ...(remoteExchanges.has(e) ? { lookup: guardedLookup } : {}), ...(secure ? upstreamHttps(remoteExchanges.has(e)) : remoteExchanges.has(e) ? { agent: remoteHttp } : {}) }, async (ures) => {
      e.sendMs ??= Date.now() - t0;
      e.waitMs = Date.now() - t0;
      e.status = ures.statusCode;
      e.statusText = ures.statusMessage;
      e.responseHeaders = flattenHeaders(ures.headers);
      e.contentType = ures.headers['content-type'];
      const keep = textLike(e.contentType);
      const keepBin = !keep && keepsBytes(e.contentType);
      // a response breakpoint on the status (Only errors) is known once the headers are in
      const bp = breakpoint ?? (opts.onBreakpoint && decision?.lateBreakpoints?.some((r) => ruleMatches(r, e, 'response')) ? opts.onBreakpoint : undefined);
      if (!hold && !bp) {
        res.writeHead(ures.statusCode ?? 502, isH2(res) ? forH2(ures.headers) : ures.headers);
        // Network speed: the response goes to the program through a pacer
        const pacer = speed ? new Pacer(speed.downKbps) : undefined;
        const sink: { write(c: Buffer): unknown; end(): unknown } = pacer ?? res;
        if (pacer) {
          pacer.pipe(res);
          res.once('close', () => pacer.destroy());
        }
        const chunks: Buffer[] = [];
        let kept = 0;
        // Server-Sent Events: the stream stays open; every event is listed as it comes
        const sse = /text\/event-stream/i.test(e.contentType ?? '');
        const report = throttled(e);
        const events = sse
          ? sseParser((ev) => {
              (e.events ??= []).push(ev);
              if (e.events.length > MAX_FRAMES) e.events.shift();
              report();
            })
          : undefined;
        if (sse) {
          e.open = true;
          if (listed) record(e, 'response');
        }
        ures.on('data', (c: Buffer) => {
          e.responseBodyBytes += c.length;
          if ((keep || keepBin) && kept < maxBody) {
            chunks.push(c.subarray(0, maxBody - kept));
            kept += Math.min(c.length, maxBody - kept);
          }
          events?.push(c);
          sink.write(c);
        });
        ures.on('end', () => {
          sink.end();
          events?.end();
          if (keep) e.responseBody = Buffer.concat(chunks).toString('utf8');
          else if (keepBin && e.responseBodyBytes <= maxBody) e.responseBodyBase64 = Buffer.concat(chunks).toString('base64');
          e.responseBodyTruncated = e.responseBodyBytes > maxBody;
          e.open = undefined;
          done();
        });
        ures.on('error', (err) => {
          e.error = err.message;
          e.open = undefined;
          sink.end();
          done();
        });
        return;
      }
      // held: the whole body, then the rules' edits, then the breakpoint, then the client
      const heldResponse = await holdBody(ures, opts.holdLimitBytes);
      if (heldResponse.over) {
        // too big to hold for edits: what has arrived goes on, then the rest as it comes (headers and body rules do not change it)
        res.writeHead(e.status ?? 502, isH2(res) ? forH2(ures.headers) : ures.headers);
        e.responseBodyBytes = heldResponse.bytes;
        e.responseBodyTruncated = true;
        for (const c of heldResponse.chunks) res.write(c);
        ures.on('data', (c: Buffer) => {
          e.responseBodyBytes += c.length;
          res.write(c);
        });
        ures.on('end', () => {
          res.end();
          done();
        });
        ures.on('error', (err) => {
          e.error = err.message;
          res.end();
          done();
        });
        ures.resume();
        return;
      }
      e.responseBodyBytes = heldResponse.body.length;
      let outBody: Buffer = heldResponse.body;
      if (decision?.scripts) await applyResponseScripts(decision, e, textLike(e.contentType) ? (decodeBody(outBody, ures.headers['content-encoding']) ?? outBody).toString('utf8') : undefined, opts.workspaceRoot?.());
      let outHeaders = applyHeaderEdits(e.responseHeaders, decision?.responseHeaders);
      // the body keeps its content-encoding unless a rule or an edit replaced it
      let changed = false;
      if (decision?.setStatus) e.status = decision.setStatus;
      if (decision?.responseBody !== undefined) (outBody = Buffer.from(decision.responseBody, 'utf8')), (changed = true);
      const rewritten = decision?.responseReplace ? rewriteBody(outBody, e.contentType, ures.headers['content-encoding'], decision.responseReplace) : undefined;
      if (rewritten) (outBody = rewritten), (changed = true);
      if (keep) e.responseBody = (changed ? outBody : (decodeBody(outBody, ures.headers['content-encoding']) ?? outBody)).subarray(0, maxBody).toString('utf8');
      else if (keepBin && outBody.length <= maxBody) e.responseBodyBase64 = outBody.toString('base64');
      if (bp) {
        const edits = await bp(e, 'response').catch(() => undefined);
        if (edits?.abort) {
          e.error = 'Aborted at the breakpoint';
          e.durationMs = Date.now() - t0;
          res.writeHead(502, { 'content-type': 'text/plain' }).end('TestPion debugger: aborted at the breakpoint');
          if (listed) record(e, 'response');
          return;
        }
        if (edits) {
          e.edited = true;
          if (edits.status) e.status = edits.status;
          if (edits.headers) outHeaders = edits.headers;
          if (edits.body !== undefined) {
            outBody = Buffer.from(edits.body, 'utf8');
            e.responseBody = edits.body;
            changed = true;
          }
        }
      }
      delete outHeaders['content-length'];
      delete outHeaders['transfer-encoding'];
      if (changed) delete outHeaders['content-encoding'];
      outHeaders['content-length'] = String(outBody.length);
      e.responseHeaders = outHeaders;
      e.responseBodyBytes = outBody.length;
      e.responseBodyTruncated = outBody.length > maxBody;
      const head = isH2(res) ? forH2(outHeaders) : outHeaders;
      if (decision?.fault?.action === 'truncate') {
        // a failure injected by a rule: the head says the whole body is coming, part of it is sent, the connection is cut
        const cut = Math.min(decision.fault.bytes ?? 0, outBody.length);
        e.error = `The response was cut after ${cut} of ${outBody.length} bytes (by a rule)`;
        e.responseBodyBytes = cut;
        writeCutResponse(res, e.status ?? 502, head, outBody, cut);
      } else if (speed) {
        res.writeHead(e.status ?? 502, head);
        const pacer = pacedBody(outBody, speed.downKbps);
        res.once('close', () => (pacer.destroy(), done()));
        pacer.pipe(res);
        return;
      } else res.writeHead(e.status ?? 502, head).end(outBody);
      done();
    });
    const done = () => {
      if (e.durationMs !== undefined) return;
      e.durationMs = Date.now() - t0;
      if (decision) responseHighlight(e);
      if (listed) record(e, 'response');
    };
    // the request's 60 s timeout only emitted an event nobody listened to: a stalled upstream never ended the exchange
    up.on('timeout', () => up.destroy(Object.assign(new Error('The server did not answer within 60 s'), { code: 'ETIMEDOUT' })));
    up.on('error', (err: NodeJS.ErrnoException) => {
      e.error = err.code === 'ENOTFOUND' ? `Unknown host ${target.hostname}` : err.message;
      e.durationMs = Date.now() - t0;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`TestPion debugger: ${e.error}`);
      if (decision) responseHighlight(e);
      if (listed) record(e, 'response');
    });
    up.on('socket', (sock) => {
      const at = () => (e.serverAddress = sock.remoteAddress ? `${sock.remoteAddress}:${sock.remotePort}` : undefined);
      if (sock.remoteAddress) at();
      else sock.once('connect', at);
      if (target.protocol === 'https:') watchTls(sock, (t) => (e.connection = t ?? e.connection));
    });
    // the request is sent whole when the last byte has gone out
    up.once('finish', () => (e.sendMs = Date.now() - t0));
    // Network speed: the request body goes out at the upload speed, after the latency
    const payload = speed && body ? pacedBody(body, speed.upKbps) : body;
    const send = () => (payload && !Buffer.isBuffer(payload) ? payload.pipe(up) : up.end(payload));
    if (speed?.latencyMs) setTimeout(send, speed.latencyMs).unref?.();
    else send();
  }

  // WebSocket: the upgrade goes to the server; both directions are read frame by frame on the way
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => void onUpgrade(req, socket, head));
  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const t0 = Date.now();
    let target: URL;
    const origin = tlsOrigins.get(req.socket);
    try {
      target = targetOf(req, origin);
    } catch {
      socket.destroy();
      return;
    }
    if (!origin && (unpaired(req.socket, req.headers['proxy-authorization']) || (await refusedTarget(req.socket, target.hostname)))) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="TestPion HTTP Debugger"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'websocket',
      method: req.method ?? 'GET',
      url: target.href.replace(/^http/, 'ws'),
      httpVersion: '1.1',
      connectionId: origin?.id ?? connectionOf(req.socket),
      host: target.host,
      clientPort: origin?.clientPort ?? req.socket.remotePort ?? 0,
      requestHeaders: flattenHeaders(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      frames: [],
      ...(origin?.scheme === 'https' ? { tls: true } : {}),
    };
    if (origin ? origin.remote : pairingSecret && !isOwnAddress(req.socket?.remoteAddress)) remoteExchanges.add(e);
    void application(e.clientPort).then((a) => {
      setApp(e, a);
    });
    const rules = rulesNow();
    const decision = rules.length || opts.listing ? decideAndCount(rules, e) : undefined;
    const listed = !decision?.ignore;
    if (decision?.highlight) e.highlight = decision.highlight;
    if (decision?.applied.length) e.rules = decision.applied;
    if (decision?.redirect) {
      target = redirectTarget(target, decision.redirect);
      e.redirectedTo = target.href.replace(/^http/, 'ws');
    }
    if (listed) record(e, 'request');
    const h = { ...req.headers };
    delete h['proxy-connection'];
    delete h['proxy-authorization']; // the pairing secret of a device on the network is for this proxy, not for the server
    // frame rules read the frames: the server is asked not to compress them
    const frameRules = decision?.frames?.length ? decision.frames : undefined;
    if (frameRules) delete h['sec-websocket-extensions'];
    const keepHost = !!(e.redirectedTo && decision?.redirect?.preserveHost);
    if (e.redirectedTo && !keepHost) h.host = target.host;
    const secure = target.protocol === 'https:';
    const sni = keepHost && !isIP(e.host.replace(/:\d+$/, '')) ? { servername: e.host.replace(/:\d+$/, '') } : {};
    const up = (secure ? httpsRequest : httpRequest)(target, { method: req.method, headers: h, ...sni, ...(remoteExchanges.has(e) ? { lookup: guardedLookup } : {}), ...(secure ? upstreamHttps(remoteExchanges.has(e)) : remoteExchanges.has(e) ? { agent: remoteHttp } : {}) });
    const report = throttled(e);
    const frame = (f: WebSocketFrame) => {
      e.frames!.push(f);
      if (e.frames!.length > MAX_FRAMES) e.frames!.shift();
      if (f.direction === 'sent') e.requestBodyBytes += f.bytes;
      else e.responseBodyBytes += f.bytes;
      if (listed) report();
    };
    const finish = (err?: string) => {
      if (e.durationMs !== undefined) return;
      e.durationMs = Date.now() - t0;
      e.open = undefined;
      if (err) e.error = err;
      if (listed) record(e, 'response');
    };
    up.on('upgrade', (ures: IncomingMessage, upSocket: Duplex, upHead: Buffer) => {
      e.waitMs = Date.now() - t0;
      e.status = ures.statusCode;
      e.statusText = ures.statusMessage;
      e.responseHeaders = flattenHeaders(ures.headers);
      e.open = true;
      socket.write(responseHead(ures));
      // with frame rules the relay writes what it forwards; without, the bytes go on untouched and the parser only reads along
      const pause = frameRules && opts.onBreakpoint ? frameBreaker(opts.onBreakpoint, e) : undefined;
      const sent = frameRules ? createFrameRelay({ direction: 'sent', decide: frameDecider(frameRules, 'sent', pause), write: (b) => void upSocket.write(b), onFrame: frame }) : webSocketFrameParser('sent', frame);
      const received = frameRules ? createFrameRelay({ direction: 'received', decide: frameDecider(frameRules, 'received', pause), write: (b) => void socket.write(b), onFrame: frame }) : webSocketFrameParser('received', frame);
      const plain = !frameRules;
      if (head.length) (sent.push(head), plain && upSocket.write(head));
      if (upHead.length) (received.push(upHead), plain && socket.write(upHead));
      socket.on('data', (c: Buffer) => (sent.push(c), plain && upSocket.write(c)));
      upSocket.on('data', (c: Buffer) => (received.push(c), plain && socket.write(c)));
      // half-open sockets: one side ending is the connection closing
      socket.on('end', () => (finish(), upSocket.end()));
      upSocket.on('end', () => (finish(), socket.end()));
      socket.on('close', () => (finish(), upSocket.destroy()));
      upSocket.on('close', () => (finish(), socket.destroy()));
      socket.on('error', () => undefined);
      upSocket.on('error', (err) => finish(err.message));
      if (listed) record(e, 'response');
    });
    up.on('response', (ures: IncomingMessage) => {
      // the server refused the upgrade: its answer goes back as is
      e.waitMs = Date.now() - t0;
      e.status = ures.statusCode;
      e.statusText = ures.statusMessage;
      e.responseHeaders = flattenHeaders(ures.headers);
      socket.write(responseHead(ures));
      ures.on('data', (c: Buffer) => socket.write(c));
      ures.on('end', () => (socket.end(), finish()));
    });
    up.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOTFOUND' ? `Unknown host ${target.hostname}` : err.message);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    up.end();
  }

  // HTTPS: an opaque tunnel, listed by host; or, with decryption on, TLS to the program with a certificate for the
  // host signed by the TestPion root, and its requests captured like plain ones
  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => void onConnect(req, socket, head));
  async function onConnect(req: IncomingMessage, socket: Socket, head: Buffer) {
    const t0 = Date.now();
    const [host, portText] = (req.url ?? '').split(':');
    const port = Number(portText) || 443;
    if (unpaired(socket, req.headers['proxy-authorization'])) return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="TestPion HTTP Debugger"\r\nContent-Length: 0\r\n\r\n');
    if (await refusedTarget(socket, host ?? '')) return void socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'tunnel',
      method: 'CONNECT',
      url: `https://${host}:${port}`,
      host: `${host}:${port}`,
      clientPort: socket.remotePort ?? 0,
      requestHeaders: flattenHeaders(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
    };
    if (pairingSecret && !isOwnAddress(socket.remoteAddress)) remoteExchanges.add(e);
    void application(e.clientPort).then((a) => {
      setApp(e, a);
    });
    const rules = rulesNow();
    const decision = rules.length || opts.listing ? decideAndCount(rules, e) : undefined;
    const listed = !decision?.ignore;
    if (decision?.highlight) e.highlight = decision.highlight;
    if (decision?.applied.length) e.rules = decision.applied;
    const decrypt = !!(opts.decrypt && host && opts.decrypt.enabled(host));
    // The tunnel is answered at once; the program's first bytes say what it speaks: TLS (decrypted when that is on),
    // HTTP/2 without TLS (h2c, e.g. gRPC to a plaintext server) or HTTP/1.1 (read like any request), or something else
    // (an opaque tunnel). A program that waits for the server to speak first gets an opaque tunnel after a moment.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let decided = false;
    const decide = (first?: Buffer) => {
      if (decided) return;
      decided = true;
      clearTimeout(quiet);
      socket.removeListener('data', onFirst);
      socket.pause();
      if (first?.length) socket.unshift(first);
      const isTls = first?.[0] === 0x16;
      const isH2c = !!first && first.subarray(0, 14).toString('latin1') === 'PRI * HTTP/2.0';
      const isH1 = !!first && /^[A-Z]{3,10} \S+ HTTP\/1\.[01]\r?\n/.test(first.subarray(0, 512).toString('latin1'));
      if (isTls && decrypt) return readTunnel('https');
      if (isH2c || isH1) return readTunnel('http', isH2c);
      opaque();
    };
    const onFirst = (c: Buffer) => decide(c);
    const quiet = setTimeout(() => decide(), 400);
    if (head.length) return decide(head);
    socket.on('data', onFirst);
    socket.on('error', () => decide());
    socket.once('end', () => decide());

    /** Read the requests inside the tunnel: TLS to the program first (https), then HTTP/1.1 or HTTP/2 as it chose. */
    function readTunnel(scheme: 'http' | 'https', h2cPreface = false) {
      const origin: TunnelOrigin = { remote: remoteExchanges.has(e), scheme, host: host!, port, clientPort: e.clientPort, requests: 0, id: shortId('conn-') };
      let reported = false;
      // the program did not accept our certificate (an alert, or it hung up without a request): a tunnel that failed, with what to do
      const failed = (why?: string) => {
        if (origin.requests > 0 || reported || scheme === 'http') return;
        reported = true;
        e.error =
          !why || /alert|handshake|certificate|unknown ca|ECONNRESET|EPIPE|closed|socket disconnected/i.test(why)
            ? 'The program did not trust the TestPion root certificate (install it, or turn HTTPS decryption off for this host)'
            : why;
        e.durationMs = Date.now() - t0;
        if (listed) {
          record(e, 'request');
          record(e, 'response');
        }
        socket.destroy();
      };
      // the protocol runs on one end of a pass-through pair; the raw socket stays ours, so its close is always seen
      const [inner, outer] = duplexPair();
      socket.pipe(outer);
      outer.pipe(socket);
      socket.resume();
      /** HTTP/2 on this stream: a server of its own, so every request knows the tunnel it came on. */
      const speakH2 = (stream: Duplex) => {
        const h2 = createH2Server();
        h2.on('request', (req: Http2ServerRequest, res: Http2ServerResponse) => void handle(req, res as unknown as ServerResponse, origin));
        h2.on('sessionError', () => undefined);
        sockets.add(stream);
        stream.on('close', () => sockets.delete(stream));
        h2.emit('connection', stream);
      };
      const speakH1 = (stream: Duplex) => {
        tlsOrigins.set(stream, origin);
        sockets.add(stream);
        stream.on('close', () => sockets.delete(stream));
        server.emit('connection', stream);
      };
      let tlsSocket: TLSSocket | undefined;
      if (scheme === 'https') {
        const leaf = opts.decrypt!.leafFor(host!);
        tlsSocket = new TLSSocket(inner, {
          isServer: true,
          ALPNProtocols: ['h2', 'http/1.1'],
          secureContext: contextFor(leaf),
          SNICallback: (name, cb) => {
            try {
              const l = opts.decrypt!.leafFor(name);
              cb(null, contextFor(l));
            } catch (err) {
              cb(err as Error);
            }
          },
        });
        const t = tlsSocket;
        t.once('secure', () => {
          if (t.alpnProtocol !== 'h2') return speakH1(t);
          // HTTP/2 straight on a TLS socket that wraps a JS stream fails inside Node; one more pass-through pair does not
          const [a, b] = duplexPair();
          t.pipe(a);
          a.pipe(t);
          t.on('close', () => a.destroy());
          b.on('close', () => t.destroy());
          speakH2(b);
        });
        t.on('error', (err: Error) => failed(err.message));
      } else if (h2cPreface) speakH2(inner);
      else speakH1(inner);
      socket.on('error', (err: Error) => failed(err.message));
      // the HTTP server's sockets allow half-open connections: the program hanging up is an 'end', not a 'close'
      const hangUp = () => {
        failed();
        tlsSocket?.destroy();
        inner.destroy();
        outer.destroy();
        socket.destroy();
      };
      socket.on('end', hangUp);
      socket.on('close', hangUp);
    }

    function opaque() {
      const to = decision?.redirect?.host ? { host: decision.redirect.host.split(':')[0]!, port: Number(decision.redirect.host.split(':')[1]) || port } : { host, port };
      if (decision?.redirect?.host) e.redirectedTo = `https://${to.host}:${to.port}`;
      e.connectionId = connectionOf(socket);
      if (listed) record(e, 'request');
      const upstream = tcpConnect({ port: to.port, host: to.host!, ...(remoteExchanges.has(e) ? { lookup: guardedLookup } : {}) }, () => {
        upstream.pipe(socket);
        socket.pipe(upstream);
        socket.resume();
      });
      upstream.on('data', (c: Buffer) => (e.responseBodyBytes += c.length));
      socket.on('data', (c: Buffer) => (e.requestBodyBytes += c.length));
      const finish = (err?: Error) => {
        if (e.durationMs !== undefined) return;
        e.durationMs = Date.now() - t0;
        if (err) e.error = err.message;
        else e.status = 200;
        if (listed) record(e, 'response');
      };
      upstream.on('error', (err) => {
        finish(err);
        socket.destroy();
      });
      socket.on('error', () => (finish(), upstream.destroy()));
      upstream.on('close', () => finish());
      socket.on('close', () => finish());
      socket.on('end', () => (finish(), upstream.end()));
    }
  }

  server.on('connection', (socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // the program is looked up as soon as it connects, while the connection is still open (its requests find the answer)
    const clientPort = (socket as Socket).remotePort;
    if (clientPort) void application(clientPort);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(new ApsError('ConfigurationError', err.code === 'EADDRINUSE' ? `Port ${opts.port} is in use` : err.message, { suggestions: ['Choose another port in the Debugger view.'] })),
    );
    server.listen(opts.port ?? 0, opts.lan ? '0.0.0.0' : '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    pairingSecret,
    exchanges,
    session,
    clear: () => session.clear(),
    ruleHits: () => Object.fromEntries(hits),
    resetRuleHits: () => hits.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        // upstream HTTP/2 sessions and the upstream agent's idle connections outlived the proxy
        for (const sess of h2Sessions.values()) sess.destroy();
        h2Sessions.clear();
        upstreamHttps.destroy();
        remoteHttp.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
