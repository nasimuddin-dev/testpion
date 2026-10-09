import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { assertUrlAllowed } from '../../net/policy.js';
import { ensureProxyApplied, websocketDispatcher } from '../../net/proxy.js';
import type { WebSocket as UndiciWebSocket } from 'undici';
import { ApsError } from '../../errors.js';
import { shortId } from '../../util/ids.js';
import type { KeyValue } from '../../model/types.js';
import type { CookieJar } from '../../cookies/cookie-jar.js';
import { watchSend } from '../http/socket-timing.js';

export interface WsMessage {
  id: string;
  time: number;
  direction: 'sent' | 'received' | 'system';
  data: string;
  binary?: boolean;
  size: number;
}

/** Interactive WebSocket session with a bounded in-memory message log. */
let undiciMod: Promise<typeof import('undici')> | undefined;

export class WebSocketSession {
  private ws?: InstanceType<typeof UndiciWebSocket>;
  readonly id = shortId('ws-');
  private listeners: Array<(m: WsMessage) => void> = [];
  private statusListeners: Array<(s: string) => void> = [];
  status: 'connecting' | 'open' | 'closed' = 'closed';
  /** How the last connection was set up: DNS, TCP and TLS (on a new connection) and the upgrade handshake, in ms. */
  connectTiming?: { totalMs: number; dnsMs?: number; tcpMs?: number; tlsMs?: number; upgradeMs?: number; tlsProtocol?: string };

  constructor(
    readonly url: string,
    /** `cookieJar`: cookies for the handshake URL (e.g. a login session) are sent, like with HTTP requests. */
    private opts: { protocols?: string[]; headers?: KeyValue[]; cookieJar?: CookieJar } = {},
  ) {}

  onMessage(l: (m: WsMessage) => void): () => void {
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }

  onStatus(l: (s: string) => void): () => void {
    this.statusListeners.push(l);
    return () => (this.statusListeners = this.statusListeners.filter((x) => x !== l));
  }

  private emit(direction: WsMessage['direction'], data: string, binary = false, size = data.length) {
    const m: WsMessage = { id: shortId(), time: Date.now(), direction, data: data.length > 256 * 1024 ? data.slice(0, 256 * 1024) + '… [truncated]' : data, binary, size };
    for (const l of this.listeners) l(m);
  }

  private setStatus(s: WebSocketSession['status']) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    // the handshake is an HTTP request: the network policy applies as for http:// and https://
    try {
      await assertUrlAllowed(this.url.replace(/^ws(s?):/i, 'http$1:'));
    } catch (e) {
      if (e instanceof ApsError) throw e;
      /* an invalid URL is reported below */
    }
    return this.open(timeoutMs);
  }

  private open(timeoutMs: number): Promise<void> {
    const headers: Record<string, string> = {};
    for (const h of this.opts.headers ?? []) if (h.enabled !== false && h.key) headers[h.key] = h.value;
    // the handshake is an HTTP request: ws:// and wss:// use the cookies of http:// and https://
    if (this.opts.cookieJar && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
      try {
        const cookie = this.opts.cookieJar.headerFor(this.url.replace(/^ws(s?):/i, 'http$1:'));
        if (cookie) headers.Cookie = cookie;
      } catch {
        /* invalid URL: reported by the connection below */
      }
    }
    this.setStatus('connecting');
    const t0 = performance.now();
    let watch: ReturnType<typeof watchSend> | undefined;
    try {
      // the handshake is an HTTP GET to the http(s) form of the URL: its connection's timing is measured like a request's
      watch = watchSend(new URL(this.url.replace(/^ws(s?):/i, 'http$1:')), 'GET');
    } catch {
      /* an invalid URL is reported below */
    }
    // undici loads on the first connection (not at startup)
    return ensureProxyApplied()
      .then(() => (undiciMod ??= import('undici')))
      .then(({ WebSocket: UndiciWebSocket }) => new Promise<void>((resolve, reject) => {
      let ws: InstanceType<typeof UndiciWebSocket>;
      try {
        // the proxy settings (Settings ▸ Proxy / HTTP(S)_PROXY) apply to the handshake too
        ws = new UndiciWebSocket(this.url, { protocols: this.opts.protocols, headers, dispatcher: websocketDispatcher() } as never);
      } catch (e) {
        this.setStatus('closed');
        return reject(new ApsError('ConfigurationError', `Invalid WebSocket URL: ${(e as Error).message}`));
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        ws.close();
        reject(new ApsError('TimeoutError', `WebSocket connection timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        const now = performance.now();
        const sent = watch?.result();
        watch?.stop();
        const t = sent?.times;
        const r = (v?: number) => (v === undefined ? undefined : Math.round(v * 10) / 10);
        const fresh = !!t && t.created >= t0 - 1;
        this.connectTiming = {
          totalMs: r(now - t0)!,
          ...(fresh ? { dnsMs: t!.lookup !== undefined ? r(t!.lookup - t!.created) : undefined, tcpMs: t!.connect !== undefined ? r(t!.connect - (t!.lookup ?? t!.created)) : undefined, tlsMs: t!.secure !== undefined && t!.connect !== undefined ? r(t!.secure - t!.connect) : undefined } : {}),
          upgradeMs: sent ? r(now - sent.sentAt) : undefined,
          tlsProtocol: sent?.tlsProtocol,
        };
        this.setStatus('open');
        const c = this.connectTiming;
        const parts = [c.dnsMs !== undefined && `DNS ${c.dnsMs} ms`, c.tcpMs !== undefined && `TCP ${c.tcpMs} ms`, c.tlsMs !== undefined && `TLS ${c.tlsMs} ms`, c.upgradeMs !== undefined && `upgrade ${c.upgradeMs} ms`].filter(Boolean);
        this.emit('system', `Connected${ws.protocol ? ` (protocol ${ws.protocol})` : ''} in ${Math.round(c.totalMs)} ms${parts.length ? `: ${parts.join(' · ')}` : ''}`);
        resolve();
      });
      ws.addEventListener('message', (ev) => {
        const d = ev.data;
        if (typeof d === 'string') this.emit('received', d);
        else {
          const buf = Buffer.from(d as ArrayBuffer);
          this.emit('received', buf.toString('base64'), true, buf.length);
        }
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        watch?.stop();
        const e = ev as unknown as { error?: Error & { cause?: unknown }; message?: string };
        const msg = e.error?.message || e.message || '';
        if (this.status !== 'connecting') {
          this.emit('system', `Error: ${msg || 'the connection failed'}`);
          return;
        }
        // undici reports failed handshakes without a message: find out what went wrong
        void diagnoseWebSocketFailure(this.url, msg || (e.error?.cause ? String(e.error.cause) : '')).then((err) => {
          this.emit('system', `Error: ${err.message}`);
          reject(err);
        });
      });
      ws.addEventListener('close', (ev) => {
        clearTimeout(timer);
        this.emit('system', `Closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`);
        this.setStatus('closed');
      });
    }));
  }

  /** The subprotocol the server picked ('' when none). */
  get protocol(): string {
    return this.ws?.protocol ?? '';
  }

  send(data: string): void {
    if (!this.ws || this.status !== 'open') throw new ApsError('ProtocolError', 'WebSocket is not open');
    this.ws.send(data);
    this.emit('sent', data);
  }

  close(code = 1000, reason = ''): void {
    this.ws?.close(code, reason);
  }
}

/**
 * Why a WebSocket handshake failed, in words: the server's name doesn't resolve, nothing listens on
 * the port, TLS fails, or the server answered with HTTP instead of switching to WebSocket.
 */
export async function diagnoseWebSocketFailure(url: string, hint = ''): Promise<ApsError> {
  let u: URL;
  try {
    u = new URL(url);
  } catch (e) {
    return new ApsError('ConfigurationError', `Invalid WebSocket URL: ${(e as Error).message}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  try {
    await lookup(host);
  } catch {
    return new ApsError('NetworkError', `Can't find the server "${host}" (its name doesn't resolve)`, {
      suggestions: ['Check the address for typos.', 'Public echo services come and go: try another one, or the local demo server (ws://127.0.0.1:4013).', 'Check your internet connection or VPN.'],
    });
  }
  const reachable = await new Promise<boolean | string>((ok) => {
    const s = connect({ host, port, timeout: 5000 });
    s.once('connect', () => (s.destroy(), ok(true)));
    s.once('timeout', () => (s.destroy(), ok('timeout')));
    s.once('error', (e: NodeJS.ErrnoException) => ok(e.code ?? e.message));
  });
  if (reachable !== true)
    return new ApsError('NetworkError', reachable === 'ECONNREFUSED' ? `Nothing is listening on ${host}:${port} (connection refused)` : `Can't reach ${host}:${port} (${reachable === 'timeout' ? 'no answer' : reachable})`, {
      suggestions: ['Check that the server is running and the port is right.', u.protocol === 'wss:' ? 'If the server has no TLS, use ws:// instead of wss://.' : 'If the server uses TLS, use wss:// instead of ws://.'],
    });
  // the server is there: ask it over HTTP what it thinks of the upgrade request
  // (node:http, since fetch won't send Connection / Upgrade headers)
  const probe = await new Promise<{ status?: number; statusText?: string; error?: NodeJS.ErrnoException }>((ok) => {
    const req = (u.protocol === 'wss:' ? httpsRequest : httpRequest)(
      { host, port, path: `${u.pathname}${u.search}`, method: 'GET', timeout: 5000, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', host: u.host } },
      (res) => {
        res.resume();
        req.destroy();
        ok({ status: res.statusCode, statusText: res.statusMessage });
      },
    );
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      ok({ status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer'), { code: 'TIMEOUT' })));
    req.on('error', (error: NodeJS.ErrnoException) => ok({ error }));
    req.end();
  });
  if (probe.status && probe.status !== 101)
    return new ApsError('ProtocolError', `The server answered HTTP ${probe.status}${probe.statusText ? ` ${probe.statusText}` : ''} instead of opening a WebSocket`, {
      suggestions: [probe.status === 401 || probe.status === 403 ? 'The server wants credentials: add them under Handshake headers (e.g. Authorization) or in the URL.' : probe.status === 404 ? 'Check the path: this URL is not a WebSocket endpoint.' : 'Check the URL, path and subprotocols the server expects.'],
    });
  if (probe.error && /wrong version number|packet length too long/i.test(probe.error.message))
    return new ApsError('NetworkError', `${u.host} doesn't use TLS on this port, but the URL starts with wss://`, { suggestions: ['Use ws:// instead of wss://.'] });
  if (probe.error?.code && /CERT|SSL|TLS|EPROTO/i.test(probe.error.code))
    return new ApsError('NetworkError', `TLS failed: ${probe.error.message.split('\n')[0]}`, { suggestions: ['Check the server certificate, or use ws:// if the server has no TLS.'] });
  return new ApsError('NetworkError', `The WebSocket connection to ${u.host} failed${hint ? `: ${hint}` : ''}`, { suggestions: ['Check the URL, subprotocols and handshake headers.'] });
}
