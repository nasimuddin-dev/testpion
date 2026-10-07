import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
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
import type { Duplex } from 'node:stream';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { trustedCa } from '../net/proxy.js';
import { applyHeaderEdits, decideRequest, highlightRuleForResponse, type DebuggerRule, type HighlightStyle } from './rules.js';
import { sseParser, webSocketFrameParser, type DebuggerSseEvent, type WebSocketFrame } from './frames.js';
import type { LeafCertificate } from './certificate.js';
import { GRPC_STATUS, grpcDecoder, grpcDecompress, grpcMessageReader, grpcMethodOf, type GrpcCapture } from './grpc.js';

/**
 * The HTTP Debugger's proxy (planning/http-debugger.md): a forward proxy other programs point at (HTTP_PROXY, a
 * browser's proxy setting, --proxy-server). Plain HTTP requests are captured whole. HTTPS goes through as an opaque
 * CONNECT tunnel, listed by host, unless decryption is on: then the proxy answers the program with a certificate for
 * the host signed by the TestPion root (DBG-4) and the requests inside are captured like plain ones. WebSocket
 * upgrades are followed frame by frame; Server-Sent Events event by event. Every exchange carries timings, sizes
 * and, best effort, the program that sent it. Rules (DBG-3) act on the way: ignore, highlight, modify, reply,
 * redirect, breakpoints.
 */
export interface DebuggerExchange {
  id: string;
  /** When the request arrived (ISO). */
  startedAt: string;
  /** 'http' for a captured request, 'tunnel' for an HTTPS CONNECT (host only), 'websocket' for an upgraded connection. */
  kind: 'http' | 'tunnel' | 'websocket';
  method: string;
  url: string;
  host: string;
  /** The port the client connected from, and the program behind it when it could be found. */
  clientPort: number;
  application?: string;
  /** The program's process id and the account it runs as, when they could be found with the program. */
  pid?: number;
  user?: string;
  /** The server's address the request went to (ip:port), once connected. */
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
  /** The bodies were let go to keep the session within its memory budget (the oldest go first). */
  bodiesDropped?: boolean;
  contentType?: string;
  /** Milliseconds: until the request was sent whole, until the server answered its headers, and until the body ended. */
  sendMs?: number;
  waitMs?: number;
  durationMs?: number;
  error?: string;
  /** Set by the user (a star) or a rule (a colour). */
  bookmarked?: boolean;
  /** A highlight rule's text colours, bold and whole row (with `highlight`). */
  highlightStyle?: HighlightStyle;
  highlight?: string;
  /** The rules that acted on this exchange, by name. */
  rules?: string[];
  /** A redirect rule sent it here instead. */
  redirectedTo?: string;
  /** A reply rule answered; the server never saw it. */
  repliedByRule?: boolean;
  /** A breakpoint held it, and the user changed it. */
  edited?: boolean;
  /** Captured inside a decrypted HTTPS tunnel. */
  tls?: boolean;
  /** Still streaming (a WebSocket, Server-Sent Events). */
  open?: boolean;
  /** WebSocket frames, both directions (up to a limit). */
  frames?: WebSocketFrame[];
  /** Server-Sent Events (up to a limit). */
  events?: DebuggerSseEvent[];
  /** DBG-5: '2' for HTTP/2 (inside a decrypted tunnel, or h2c); the connection the request came on; its stream. */
  httpVersion?: '1.1' | '2';
  connectionId?: string;
  streamId?: number;
  /** A gRPC call: its messages both ways, decoded, and the status from the trailers. */
  grpc?: GrpcCapture;
  /** HTTP/2 trailers (gRPC's status lives there). */
  trailers?: Record<string, string>;
}

/** What a breakpoint hands back: edits to apply, or nothing to let it go on as it was. */
export interface BreakpointEdits {
  abort?: boolean;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
}

export interface DebuggerProxyOptions {
  port?: number;
  /** The session the captured exchanges go into (the app shares one across stop / start); a new one otherwise. */
  session?: DebuggerSession;
  /** Without a session given: how many bytes of bodies it keeps in memory in all (default 200 MB). */
  maxSessionBodyBytes?: number;
  /** Listen on every interface (a phone, another computer), not only this one. */
  lan?: boolean;
  maxBodyBytes?: number;
  /** `update`: something learned later changed a listed exchange (its program, found after the response). */
  onExchange?(e: DebuggerExchange, phase: 'request' | 'response' | 'update'): void;
  /** Which program owns a client port (see applicationOfPort); replaceable in tests. */
  applicationOf?(port: number): Promise<string | ProgramInfo | undefined>;
  /** The account a process runs as (see ownerOfProcess); replaceable in tests. */
  ownerOf?(pid: number): Promise<string | undefined>;
  /** The active rules, read for every request (so edits apply at once). */
  rules?(): DebuggerRule[];
  /** A breakpoint rule matched: show the exchange, resolve with edits (or nothing) to let it go on. */
  onBreakpoint?(e: DebuggerExchange, phase: 'request' | 'response'): Promise<BreakpointEdits | undefined>;
  /** HTTPS decryption: a certificate for each host, signed by the root the program trusts; `enabled` is asked per tunnel. */
  decrypt?: { leafFor(host: string): LeafCertificate; enabled(host: string): boolean; insecureUpstream?: boolean };
  /** gRPC messages as JSON: with the workspace's .proto files when one describes the method, else field by field. */
  grpcDecode?(path: string, direction: 'request' | 'response', bytes: Buffer): { value: unknown; with: 'proto' | 'raw' };
  /** The page the proxy serves to a browser that opens it directly (a phone on the LAN): the root certificate to download. */
  rootCertificatePem?(): string | undefined;
}

/** A tunnel whose requests are read: where they go, who sent them, how many came, its connection id. */
interface TunnelOrigin {
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
const flat = (h: IncomingMessage['headers']): Record<string, string> =>
  Object.fromEntries(
    Object.entries(h)
      .filter(([k, v]) => v !== undefined && !k.startsWith(':'))
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
  );
/** Headers HTTP/2 forbids (connection-specific) and HTTP/2's pseudo-headers, which HTTP/1.1 has no place for. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings', 'te']);
const forH2 = (h: Record<string, string | string[] | number | undefined>) =>
  Object.fromEntries(Object.entries(h).filter(([k, v]) => v !== undefined && !HOP_BY_HOP.has(k.toLowerCase()) && !k.startsWith(':')));
const withoutPseudo = (h: Record<string, string | string[] | number | undefined>) =>
  Object.fromEntries(Object.entries(h).filter(([k, v]) => v !== undefined && !k.startsWith(':'))) as Record<string, string | string[]>;
const forH2Out = (h: Record<string, string | string[] | number | undefined>) => forH2(h) as Record<string, string | string[]>;
/** The HTTP/2 compatibility response has the same methods as ServerResponse; it is handled as one and told apart here. */
const isH2 = (res: ServerResponse): boolean => 'stream' in res && !!(res as unknown as Http2ServerResponse).stream;
const textLike = (ct: string | undefined) => !ct || /json|text|xml|javascript|html|form|yaml|graphql|csv|urlencoded/i.test(ct);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Collect a stream into text, up to `max` bytes (the rest is counted, not kept). */
function collect(stream: NodeJS.ReadableStream, max: number, keep: boolean): Promise<{ text?: string; bytes: number; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let kept = 0;
    stream.on('data', (c: Buffer) => {
      bytes += c.length;
      if (keep && kept < max) {
        chunks.push(c.subarray(0, max - kept));
        kept += Math.min(c.length, max - kept);
      }
    });
    stream.on('end', () => resolve({ text: keep ? Buffer.concat(chunks).toString('utf8') : undefined, bytes, truncated: bytes > max }));
    stream.on('error', () => resolve({ text: keep ? Buffer.concat(chunks).toString('utf8') : undefined, bytes, truncated: bytes > max }));
  });
}

/** A request body whole (it is forwarded after the rules, which may change it). */
const collectWhole = (stream: NodeJS.ReadableStream) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.concat(chunks)));
  });

/** The program that owns a local TCP port, best effort, per platform; undefined when unknown. */
export async function startDebuggerProxy(opts: DebuggerProxyOptions = {}): Promise<DebuggerProxy> {
  const maxBody = opts.maxBodyBytes ?? 512 * 1024;
  const session = opts.session ?? new DebuggerSession({ maxBodyBytes: opts.maxSessionBodyBytes });
  const exchanges = session.items;
  const appOf = opts.applicationOf ?? applicationOfPort;
  const appCache = new Map<number, Promise<string | ProgramInfo | undefined>>();
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
    const d = decideRequest(rules, e);
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
  const owners = new Map<number, Promise<string | undefined>>();
  const ownerFor = (pid: number) => {
    let p = owners.get(pid);
    if (!p) {
      p = (opts.ownerOf ?? ownerOfProcess)(pid).catch(() => undefined);
      owners.set(pid, p);
      if (owners.size > 500) owners.delete(owners.keys().next().value!);
    }
    return p;
  };
  const recorded = new WeakSet<DebuggerExchange>();
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
      if (appCache.size > 500) appCache.delete(appCache.keys().next().value!);
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
        opts.onExchange?.(e, 'response');
      }, 250);
    };
  };
  const rulesNow = () => opts.rules?.() ?? [];
  const upstreamTls = () => ({ ca: trustedCa(), rejectUnauthorized: !opts.decrypt?.insecureUpstream });
  /** Where a request on this socket goes: the absolute URL of a proxy request, or the decrypted tunnel's origin plus the path. */
  const targetOf = (req: IncomingMessage | Http2ServerRequest, origin?: TunnelOrigin): URL => {
    if (origin) return new URL(req.url ?? '/', `${origin.scheme}://${origin.host}:${origin.port}`);
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  };

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
    if (origin) origin.requests++;
    const h2 = isH2(res);
    const requestHeaders = flat(req.headers as IncomingMessage['headers']);
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
    // gRPC: forwarded over HTTP/2 as it streams (messages both ways, then trailers); rules may ignore or highlight it
    if (h2 && /^application\/grpc/i.test(String(req.headers['content-type'] ?? ''))) {
      void application(e.clientPort).then((a) => {
        setApp(e, a);
      });
      const rules = rulesNow();
      const decision = rules.length ? decideAndCount(rules, e) : undefined;
      if (decision?.highlight) e.highlight = decision.highlight;
      if (decision?.applied.length) e.rules = decision.applied;
      return forwardGrpc(target, req as Http2ServerRequest, res as unknown as Http2ServerResponse, e, !decision?.ignore);
    }
    const appPromise = application(e.clientPort).then((a) => {
      setApp(e, a);
    });
    // the request body whole, before the rules: a breakpoint or a modify rule may change it
    const reqBody = await collectWhole(req as NodeJS.ReadableStream);
    e.requestBodyBytes = reqBody.length;
    e.requestBodyTruncated = reqBody.length > maxBody;
    if (reqBody.length && textLike(req.headers['content-type'])) e.requestBody = reqBody.subarray(0, maxBody).toString('utf8');
    let bodyToSend: Buffer | undefined = reqBody.length ? reqBody : undefined;

    const rules = rulesNow();
    await programFirst(appPromise, rules);
    const decision = rules.length ? decideAndCount(rules, e) : undefined;
    if (decision?.ignore) {
      // not listed; forwarded as is
      forward(target, e.method, { ...requestHeaders }, bodyToSend, res, e, undefined, undefined, false);
      return;
    }
    if (decision) {
      if (decision.highlight) e.highlight = decision.highlight;
      if (decision.applied.length) e.rules = decision.applied;
      if (decision.requestHeaders) e.requestHeaders = applyHeaderEdits(e.requestHeaders, decision.requestHeaders);
      if (decision.requestBody !== undefined) {
        e.requestBody = decision.requestBody;
        bodyToSend = Buffer.from(decision.requestBody, 'utf8');
        e.requestBodyBytes = bodyToSend.length;
        e.requestHeaders['content-length'] = String(bodyToSend.length);
      }
      if (decision.redirect) {
        const to = new URL(target.href);
        to.host = decision.redirect.host;
        if (decision.redirect.scheme) to.protocol = `${decision.redirect.scheme}:`;
        e.redirectedTo = to.href;
        target = to;
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
        if (edits.body !== undefined) {
          e.requestBody = edits.body;
          bodyToSend = Buffer.from(edits.body, 'utf8');
          e.requestBodyBytes = bodyToSend.length;
          e.requestHeaders['content-length'] = String(bodyToSend.length);
        }
      }
    }
    if (decision?.delayMs) await sleep(decision.delayMs);
    if (decision?.reply) {
      const r = decision.reply;
      if (r.delayMs) await sleep(r.delayMs);
      const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const body = r.body ?? '';
      if (body && !headers['content-type']) headers['content-type'] = 'application/json';
      e.repliedByRule = true;
      e.waitMs = Date.now() - t0;
      e.status = r.status;
      e.statusText = 'Rule';
      e.responseHeaders = headers;
      e.contentType = headers['content-type'];
      e.responseBody = body;
      e.responseBodyBytes = Buffer.byteLength(body);
      e.durationMs = Date.now() - t0;
      res.writeHead(r.status, isH2(res) ? forH2(headers) : headers).end(body);
      record(e, 'response');
      void appPromise;
      return;
    }
    // modify rules on the response, or a response breakpoint: the body is held whole, then sent
    const holdResponse = !!(decision?.responseHeaders || decision?.responseBody !== undefined || decision?.breakpoint === 'response');
    forward(target, e.method, e.requestHeaders, bodyToSend, res, e, decision, holdResponse ? (decision?.breakpoint === 'response' ? opts.onBreakpoint : undefined) : undefined, true);
  }

  /** The page a browser gets when it opens the proxy itself: how to use it, and the root certificate to download. */
  function servePage(req: IncomingMessage | Http2ServerRequest, res: ServerResponse) {
    const pem = opts.rootCertificatePem?.();
    if (/^\/testpion-root\.(pem|crt|cer)$/.test(req.url ?? '')) {
      if (!pem) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('HTTPS decryption is off: no root certificate to download.');
      return void res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="testpion-root.crt"' }).end(pem);
    }
    const here = `http://${req.headers.host ?? (req.headers[':authority'] as string | undefined) ?? 'this-computer'}`;
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestPion HTTP Debugger</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1b1f2a}code{background:#eef1f6;padding:0 .3em;border-radius:4px}a.b{display:inline-block;margin:.5rem 0;padding:.6rem 1rem;background:#4f6bff;color:#fff;border-radius:8px;text-decoration:none}</style>
<h1>TestPion HTTP Debugger</h1>
<p>This device can send its traffic through TestPion: set its Wi-Fi proxy to <b>manual</b>, server <code>${here.replace(/^http:\/\//, '').replace(/:\d+$/, '')}</code>, port <code>${here.split(':').pop()}</code>.</p>
${pem ? `<p>To see HTTPS too, install and trust TestPion's root certificate on this device:</p><p><a class="b" href="/testpion-root.crt">Download the root certificate</a></p><p>Android: Settings ▸ Security ▸ Encryption & credentials ▸ Install a certificate ▸ CA certificate. iOS: open the downloaded profile in Settings ▸ General ▸ VPN & Device Management, then Settings ▸ General ▸ About ▸ Certificate Trust Settings ▸ turn it on. Remove it when you are done.</p>` : '<p>HTTPS decryption is off in TestPion, so HTTPS shows as tunnels by host.</p>'}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
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
    const key = target.origin;
    let session = h2Sessions.get(key);
    if (!session || session.closed || session.destroyed) {
      session = h2connect(key, target.protocol === 'https:' ? { ...upstreamTls(), ALPNProtocols: ['h2'] } : {});
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
      e.responseHeaders = flat(withoutPseudo(h as Record<string, string>) as IncomingMessage['headers']);
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
      e.trailers = flat(withoutPseudo(t as Record<string, string>) as IncomingMessage['headers']);
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
    body: Buffer | undefined,
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
    if (e.redirectedTo) h.host = target.host;
    const hold = !!(decision?.responseHeaders || decision?.responseBody !== undefined || breakpoint);
    const secure = target.protocol === 'https:';
    const up = (secure ? httpsRequest : httpRequest)(target, { method, headers: h, timeout: 60_000, ...(secure ? upstreamTls() : {}) }, async (ures) => {
      e.sendMs ??= Date.now() - t0;
      e.waitMs = Date.now() - t0;
      e.status = ures.statusCode;
      e.statusText = ures.statusMessage;
      e.responseHeaders = flat(ures.headers);
      e.contentType = ures.headers['content-type'];
      const keep = textLike(e.contentType);
      if (!hold) {
        res.writeHead(ures.statusCode ?? 502, isH2(res) ? forH2(ures.headers) : ures.headers);
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
          if (keep && kept < maxBody) {
            chunks.push(c.subarray(0, maxBody - kept));
            kept += Math.min(c.length, maxBody - kept);
          }
          events?.push(c);
          res.write(c);
        });
        ures.on('end', () => {
          res.end();
          events?.end();
          if (keep) e.responseBody = Buffer.concat(chunks).toString('utf8');
          e.responseBodyTruncated = e.responseBodyBytes > maxBody;
          e.open = undefined;
          done();
        });
        ures.on('error', (err) => {
          e.error = err.message;
          e.open = undefined;
          res.end();
          done();
        });
        return;
      }
      // held: the whole body, then the rules' edits, then the breakpoint, then the client
      const whole = await collect(ures, Number.MAX_SAFE_INTEGER, true);
      e.responseBodyBytes = whole.bytes;
      let outBody: Buffer = Buffer.from(whole.text ?? '', 'utf8');
      let outHeaders = applyHeaderEdits(e.responseHeaders, decision?.responseHeaders);
      if (decision?.responseBody !== undefined) outBody = Buffer.from(decision.responseBody, 'utf8');
      if (keep) e.responseBody = outBody.subarray(0, maxBody).toString('utf8');
      if (breakpoint) {
        const edits = await breakpoint(e, 'response').catch(() => undefined);
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
          }
        }
      }
      delete outHeaders['content-length'];
      delete outHeaders['transfer-encoding'];
      delete outHeaders['content-encoding'];
      outHeaders['content-length'] = String(outBody.length);
      e.responseHeaders = outHeaders;
      e.responseBodyBytes = outBody.length;
      e.responseBodyTruncated = outBody.length > maxBody;
      res.writeHead(e.status ?? 502, isH2(res) ? forH2(outHeaders) : outHeaders).end(outBody);
      done();
    });
    const done = () => {
      e.durationMs = Date.now() - t0;
      if (decision) responseHighlight(e);
      if (listed) record(e, 'response');
    };
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
    });
    // the request is sent whole when the last byte has gone out
    up.once('finish', () => (e.sendMs = Date.now() - t0));
    up.end(body);
  }

  // WebSocket: the upgrade goes to the server; both directions are read frame by frame on the way
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const t0 = Date.now();
    let target: URL;
    const origin = tlsOrigins.get(req.socket);
    try {
      target = targetOf(req, origin);
    } catch {
      socket.destroy();
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
      requestHeaders: flat(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      frames: [],
      ...(origin?.scheme === 'https' ? { tls: true } : {}),
    };
    void application(e.clientPort).then((a) => {
      setApp(e, a);
    });
    const rules = rulesNow();
    const decision = rules.length ? decideAndCount(rules, e) : undefined;
    const listed = !decision?.ignore;
    if (decision?.highlight) e.highlight = decision.highlight;
    if (decision?.applied.length) e.rules = decision.applied;
    if (decision?.redirect) {
      const to = new URL(target.href);
      to.host = decision.redirect.host;
      if (decision.redirect.scheme) to.protocol = `${decision.redirect.scheme}:`;
      e.redirectedTo = to.href.replace(/^http/, 'ws');
      target = to;
    }
    if (listed) record(e, 'request');
    const h = { ...req.headers };
    delete h['proxy-connection'];
    if (e.redirectedTo) h.host = target.host;
    const secure = target.protocol === 'https:';
    const up = (secure ? httpsRequest : httpRequest)(target, { method: req.method, headers: h, ...(secure ? upstreamTls() : {}) });
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
      e.responseHeaders = flat(ures.headers);
      e.open = true;
      const lines = [
        `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`,
        ...Object.entries(ures.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : [])),
      ];
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      const sent = webSocketFrameParser('sent', frame);
      const received = webSocketFrameParser('received', frame);
      if (head.length) {
        sent.push(head);
        upSocket.write(head);
      }
      if (upHead.length) {
        received.push(upHead);
        socket.write(upHead);
      }
      socket.on('data', (c: Buffer) => (sent.push(c), upSocket.write(c)));
      upSocket.on('data', (c: Buffer) => (received.push(c), socket.write(c)));
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
      e.responseHeaders = flat(ures.headers);
      const lines = [
        `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`,
        ...Object.entries(ures.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : [])),
      ];
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      ures.on('data', (c: Buffer) => socket.write(c));
      ures.on('end', () => (socket.end(), finish()));
    });
    up.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOTFOUND' ? `Unknown host ${target.hostname}` : err.message);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    up.end();
  });

  // HTTPS: an opaque tunnel, listed by host; or, with decryption on, TLS to the program with a certificate for the
  // host signed by the TestPion root, and its requests captured like plain ones
  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const t0 = Date.now();
    const [host, portText] = (req.url ?? '').split(':');
    const port = Number(portText) || 443;
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'tunnel',
      method: 'CONNECT',
      url: `https://${host}:${port}`,
      host: `${host}:${port}`,
      clientPort: socket.remotePort ?? 0,
      requestHeaders: flat(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
    };
    void application(e.clientPort).then((a) => {
      setApp(e, a);
    });
    const rules = rulesNow();
    const decision = rules.length ? decideAndCount(rules, e) : undefined;
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
      const origin: TunnelOrigin = { scheme, host: host!, port, clientPort: e.clientPort, requests: 0, id: shortId('conn-') };
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
          secureContext: createSecureContext({ cert: leaf.cert, key: leaf.key }),
          SNICallback: (name, cb) => {
            try {
              const l = opts.decrypt!.leafFor(name);
              cb(null, createSecureContext({ cert: l.cert, key: l.key }));
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
      const to = decision?.redirect ? { host: decision.redirect.host.split(':')[0]!, port: Number(decision.redirect.host.split(':')[1]) || port } : { host, port };
      if (decision?.redirect) e.redirectedTo = `https://${to.host}:${to.port}`;
      e.connectionId = connectionOf(socket);
      if (listed) record(e, 'request');
      const upstream = tcpConnect(to.port, to.host!, () => {
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
  });

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
    exchanges,
    session,
    clear: () => session.clear(),
    ruleHits: () => Object.fromEntries(hits),
    resetRuleHits: () => hits.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
