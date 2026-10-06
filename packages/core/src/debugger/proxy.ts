import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';

/**
 * The HTTP Debugger's proxy (planning/http-debugger.md, DBG-1): a forward proxy other programs point at
 * (HTTP_PROXY, a browser's proxy setting, --proxy-server). Plain HTTP requests are captured whole; HTTPS goes through
 * as an opaque CONNECT tunnel, listed by host, until the root certificate of DBG-4 decrypts it. Every exchange
 * carries timings, sizes and, best effort, the program that sent it.
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
}

export interface DebuggerProxyOptions {
  port?: number;
  /** Listen on every interface (a phone, another computer), not only this one. */
  lan?: boolean;
  maxBodyBytes?: number;
  onExchange?(e: DebuggerExchange, phase: 'request' | 'response'): void;
  /** Which program owns a client port (see applicationOfPort); replaceable in tests. */
  applicationOf?(port: number): Promise<string | undefined>;
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
    void application(e.clientPort).then((a) => {
      if (a) e.application = a;
    });
    record(e, 'request');
    // the body is forwarded as it streams and kept (up to the limit) for the viewer
    const chunks: Buffer[] = [];
    let kept = 0;
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers, timeout: 60_000 }, async (ures) => {
      e.waitMs = Date.now() - t0;
      e.status = ures.statusCode;
      e.statusText = ures.statusMessage;
      e.responseHeaders = flat(ures.headers);
      e.contentType = ures.headers['content-type'];
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      const keep = textLike(e.contentType);
      const body: Buffer[] = [];
      let bkept = 0;
      ures.on('data', (c: Buffer) => {
        e.responseBodyBytes += c.length;
        if (keep && bkept < maxBody) {
          body.push(c.subarray(0, maxBody - bkept));
          bkept += Math.min(c.length, maxBody - bkept);
        }
        res.write(c);
      });
      ures.on('end', () => {
        res.end();
        if (keep) e.responseBody = Buffer.concat(body).toString('utf8');
        e.responseBodyTruncated = e.responseBodyBytes > maxBody;
        e.durationMs = Date.now() - t0;
        record(e, 'response');
      });
      ures.on('error', (err) => {
        e.error = err.message;
        e.durationMs = Date.now() - t0;
        res.end();
        record(e, 'response');
      });
    });
    up.on('error', (err: NodeJS.ErrnoException) => {
      e.error = err.code === 'ENOTFOUND' ? `Unknown host ${target.hostname}` : err.message;
      e.durationMs = Date.now() - t0;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`TestPion debugger: ${e.error}`);
      record(e, 'response');
    });
    req.on('data', (c: Buffer) => {
      e.requestBodyBytes += c.length;
      if (kept < maxBody) {
        chunks.push(c.subarray(0, maxBody - kept));
        kept += Math.min(c.length, maxBody - kept);
      }
      up.write(c);
    });
    req.on('end', () => {
      if (chunks.length && textLike(req.headers['content-type'])) e.requestBody = Buffer.concat(chunks).toString('utf8');
      e.requestBodyTruncated = e.requestBodyBytes > maxBody;
      up.end();
    });
  });

  // HTTPS: an opaque tunnel, listed by host (decrypting it is DBG-4)
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
    record(e, 'request');
    const upstream = tcpConnect(port, host, () => {
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
      record(e, 'response');
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
