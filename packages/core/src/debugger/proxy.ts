import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { applyHeaderEdits, decideRequest, highlightForResponse, type DebuggerRule } from './rules.js';

/**
 * The HTTP Debugger's proxy (planning/http-debugger.md, DBG-1): a forward proxy other programs point at
 * (HTTP_PROXY, a browser's proxy setting, --proxy-server). Plain HTTP requests are captured whole; HTTPS goes through
 * as an opaque CONNECT tunnel, listed by host, until the root certificate of DBG-4 decrypts it. Every exchange
 * carries timings, sizes and, best effort, the program that sent it. Rules (DBG-3) act on the way: ignore, highlight,
 * modify, reply, redirect, breakpoints.
 */
export interface DebuggerExchange {
  id: string;
  /** When the request arrived (ISO). */
  startedAt: string;
  /** 'http' for a captured request, 'tunnel' for an HTTPS CONNECT (host only). */
  kind: 'http' | 'tunnel';
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
}

export interface DebuggerProxy {
  url: string;
  port: number;
  exchanges: DebuggerExchange[];
  close(): Promise<void>;
  /** Forget captured exchanges (the server keeps running). */
  clear(): void;
}

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
  const rulesNow = () => opts.rules?.() ?? [];

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = Date.now();
    let target: URL;
    try {
      // a proxy request carries the absolute URL; a direct request to the proxy carries a path only
      target = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const e: DebuggerExchange = {
      id: shortId('dbg-'),
      startedAt: new Date(t0).toISOString(),
      kind: 'http',
      method: req.method ?? 'GET',
      url: target.href,
      host: target.host,
      clientPort: req.socket.remotePort ?? 0,
      requestHeaders: flat(req.headers),
      requestBodyBytes: 0,
      responseBodyBytes: 0,
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
    const up = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers: h, timeout: 60_000 }, async (ures) => {
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
        ures.on('data', (c: Buffer) => {
          e.responseBodyBytes += c.length;
          if (keep && kept < maxBody) {
            chunks.push(c.subarray(0, maxBody - kept));
            kept += Math.min(c.length, maxBody - kept);
          }
          res.write(c);
        });
        ures.on('end', () => {
          res.end();
          if (keep) e.responseBody = Buffer.concat(chunks).toString('utf8');
          e.responseBodyTruncated = e.responseBodyBytes > maxBody;
          done();
        });
        ures.on('error', (err) => {
          e.error = err.message;
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

  // HTTPS: an opaque tunnel, listed by host (decrypting it is DBG-4); ignore and highlight rules apply by host
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
    const to = decision?.redirect ? { host: decision.redirect.host.split(':')[0]!, port: Number(decision.redirect.host.split(':')[1]) || port } : { host, port };
    if (decision?.redirect) e.redirectedTo = `https://${to.host}:${to.port}`;
    if (listed) record(e, 'request');
    const upstream = tcpConnect(to.port, to.host, () => {
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
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
