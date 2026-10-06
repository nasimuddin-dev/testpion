import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { duplexPair } from 'node:stream';
import { execFile } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { trustedCa } from '../net/proxy.js';
import { applyHeaderEdits, decideRequest, highlightForResponse, type DebuggerRule } from './rules.js';
import { sseParser, webSocketFrameParser, type DebuggerSseEvent, type WebSocketFrame } from './frames.js';
import type { LeafCertificate } from './certificate.js';

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
  contentType?: string;
  /** Milliseconds: until the server answered its headers, and until the body ended. */
  waitMs?: number;
  durationMs?: number;
  error?: string;
  /** Set by the user (a star) or a rule (a colour). */
  bookmarked?: boolean;
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
  /** Listen on every interface (a phone, another computer), not only this one. */
  lan?: boolean;
  maxBodyBytes?: number;
  onExchange?(e: DebuggerExchange, phase: 'request' | 'response'): void;
  /** Which program owns a client port (see applicationOfPort); replaceable in tests. */
  applicationOf?(port: number): Promise<string | undefined>;
  /** The active rules, read for every request (so edits apply at once). */
  rules?(): DebuggerRule[];
  /** A breakpoint rule matched: show the exchange, resolve with edits (or nothing) to let it go on. */
  onBreakpoint?(e: DebuggerExchange, phase: 'request' | 'response'): Promise<BreakpointEdits | undefined>;
  /** HTTPS decryption: a certificate for each host, signed by the root the program trusts; `enabled` is asked per tunnel. */
  decrypt?: { leafFor(host: string): LeafCertificate; enabled(host: string): boolean; insecureUpstream?: boolean };
}

export interface DebuggerProxy {
  url: string;
  port: number;
  exchanges: DebuggerExchange[];
  close(): Promise<void>;
  /** Forget captured exchanges (the server keeps running). */
  clear(): void;
}

const MAX_FRAMES = 500;
const flat = (h: IncomingMessage['headers']): Record<string, string> =>
  Object.fromEntries(
    Object.entries(h)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
  );
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
export function applicationOfPort(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const done = (name?: string) => resolve(name?.trim() || undefined);
    const opts = { timeout: 3000, windowsHide: true };
    if (process.platform === 'win32') {
      const ps = `$c = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName }`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], opts, (err, out) => done(err ? undefined : String(out)));
    } else {
      execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fc'], opts, (err, out) => {
        if (err) return done(undefined);
        const m = /^c(.+)$/m.exec(String(out));
        done(m?.[1]);
      });
    }
  });
}

export async function startDebuggerProxy(opts: DebuggerProxyOptions = {}): Promise<DebuggerProxy> {
  const maxBody = opts.maxBodyBytes ?? 512 * 1024;
  const exchanges: DebuggerExchange[] = [];
  const appOf = opts.applicationOf ?? applicationOfPort;
  const appCache = new Map<number, Promise<string | undefined>>();
  /** Decrypted tunnels: which host a TLS socket (and the requests on it) belongs to. */
  const tlsOrigins = new WeakMap<object, { host: string; port: number; clientPort: number; requests: number }>();
  const application = (port: number) => {
    let p = appCache.get(port);
    if (!p) {
      p = appOf(port).catch(() => undefined);
      appCache.set(port, p);
      if (appCache.size > 500) appCache.clear();
    }
    return p;
  };
  const record = (e: DebuggerExchange, phase: 'request' | 'response') => {
    if (phase === 'request') {
      exchanges.push(e);
      if (exchanges.length > 5000) exchanges.shift();
    }
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
  const targetOf = (req: IncomingMessage): URL => {
    const origin = tlsOrigins.get(req.socket);
    if (origin) return new URL(req.url ?? '/', `https://${origin.host}:${origin.port}`);
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  };

  /** Every connection to the proxy, so close() ends them all (tunnels, upgrades and injected TLS sockets included). */
  const sockets = new Set<Duplex>();
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = Date.now();
    let target: URL;
    try {
      target = targetOf(req);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const origin = tlsOrigins.get(req.socket);
    if (origin) origin.requests++;
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'http',
      method: req.method ?? 'GET',
      url: target.href,
      host: target.host,
      clientPort: origin?.clientPort ?? req.socket.remotePort ?? 0,
      requestHeaders: flat(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      ...(origin ? { tls: true } : {}),
    };
    const appPromise = application(e.clientPort).then((a) => {
      if (a) e.application = a;
    });
    // the request body whole, before the rules: a breakpoint or a modify rule may change it
    const reqBody = await collectWhole(req);
    e.requestBodyBytes = reqBody.length;
    e.requestBodyTruncated = reqBody.length > maxBody;
    if (reqBody.length && textLike(req.headers['content-type'])) e.requestBody = reqBody.subarray(0, maxBody).toString('utf8');
    let bodyToSend: Buffer | undefined = reqBody.length ? reqBody : undefined;

    const rules = rulesNow();
    const decision = rules.length ? decideRequest(rules, e) : undefined;
    if (decision?.ignore) {
      // not listed; forwarded as is
      forward(target, e.method, { ...req.headers }, bodyToSend, res, e, undefined, undefined, false);
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
      res.writeHead(r.status, headers).end(body);
      record(e, 'response');
      void appPromise;
      return;
    }
    // modify rules on the response, or a response breakpoint: the body is held whole, then sent
    const holdResponse = !!(decision?.responseHeaders || decision?.responseBody !== undefined || decision?.breakpoint === 'response');
    forward(target, e.method, e.requestHeaders, bodyToSend, res, e, decision, holdResponse ? (decision?.breakpoint === 'response' ? opts.onBreakpoint : undefined) : undefined, true);
  });

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
      e.waitMs = Date.now() - t0;
      e.status = ures.statusCode;
      e.statusText = ures.statusMessage;
      e.responseHeaders = flat(ures.headers);
      e.contentType = ures.headers['content-type'];
      const keep = textLike(e.contentType);
      if (!hold) {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
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
      res.writeHead(e.status ?? 502, outHeaders).end(outBody);
      done();
    });
    const done = () => {
      e.durationMs = Date.now() - t0;
      const hl = decision ? highlightForResponse(rulesNow(), e) : undefined;
      if (hl) e.highlight = hl;
      if (listed) record(e, 'response');
    };
    up.on('error', (err: NodeJS.ErrnoException) => {
      e.error = err.code === 'ENOTFOUND' ? `Unknown host ${target.hostname}` : err.message;
      e.durationMs = Date.now() - t0;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`TestPion debugger: ${e.error}`);
      const hl = decision ? highlightForResponse(rulesNow(), e) : undefined;
      if (hl) e.highlight = hl;
      if (listed) record(e, 'response');
    });
    up.end(body);
  }

  // WebSocket: the upgrade goes to the server; both directions are read frame by frame on the way
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const t0 = Date.now();
    let target: URL;
    try {
      target = targetOf(req);
    } catch {
      socket.destroy();
      return;
    }
    const origin = tlsOrigins.get(req.socket);
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'websocket',
      method: req.method ?? 'GET',
      url: target.href.replace(/^http/, 'ws'),
      host: target.host,
      clientPort: origin?.clientPort ?? req.socket.remotePort ?? 0,
      requestHeaders: flat(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      frames: [],
      ...(origin ? { tls: true } : {}),
    };
    void application(e.clientPort).then((a) => {
      if (a) e.application = a;
    });
    const rules = rulesNow();
    const decision = rules.length ? decideRequest(rules, e) : undefined;
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
      if (a) e.application = a;
    });
    const rules = rulesNow();
    const decision = rules.length ? decideRequest(rules, e) : undefined;
    const listed = !decision?.ignore;
    if (decision?.highlight) e.highlight = decision.highlight;
    if (decision?.applied.length) e.rules = decision.applied;
    const decrypt = opts.decrypt && host && opts.decrypt.enabled(host);
    if (decrypt) {
      // the tunnel itself is not listed: its requests are, with tls: true
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      // the TLS server reads the tunnel itself (a hand-made TLSSocket is not read before the handshake, so a client
      // that rejects our certificate and hangs up would go unnoticed); the decrypted socket then goes to the HTTP server
      const origin = { host: host!, port, clientPort: e.clientPort, requests: 0 };
      let reported = false;
      // the program did not accept our certificate (an alert, or it hung up without a request): a tunnel that failed, with what to do
      const failed = (why?: string) => {
        if (origin.requests > 0 || reported) return;
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
      // TLS runs on one end of a pass-through pair; the raw socket stays ours, so its close is always seen (a TLS
      // socket on a handle taken over from the HTTP server reports nothing when the program hangs up)
      const [inner, outer] = duplexPair();
      socket.pipe(outer);
      outer.pipe(socket);
      const leaf = opts.decrypt!.leafFor(host!);
      const tlsSocket = new TLSSocket(inner, {
        isServer: true,
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
      tlsOrigins.set(tlsSocket, origin);
      tlsSocket.once('secure', () => {
        sockets.add(tlsSocket);
        tlsSocket.on('close', () => sockets.delete(tlsSocket));
        server.emit('connection', tlsSocket);
      });
      tlsSocket.on('error', (err: Error) => failed(err.message));
      socket.on('error', (err: Error) => failed(err.message));
      // the HTTP server's sockets allow half-open connections: the program hanging up is an 'end', not a 'close'
      const hangUp = () => {
        failed();
        tlsSocket.destroy();
        outer.destroy();
        socket.destroy();
      };
      socket.on('end', hangUp);
      socket.on('close', hangUp);
      return;
    }
    const to = decision?.redirect ? { host: decision.redirect.host.split(':')[0]!, port: Number(decision.redirect.host.split(':')[1]) || port } : { host, port };
    if (decision?.redirect) e.redirectedTo = `https://${to.host}:${to.port}`;
    if (listed) record(e, 'request');
    const upstream = tcpConnect(to.port, to.host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
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
  });

  server.on('connection', (socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
    clear: () => exchanges.splice(0),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
