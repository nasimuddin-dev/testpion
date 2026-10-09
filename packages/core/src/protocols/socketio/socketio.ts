import type { Socket } from 'socket.io-client';
import { ApsError } from '../../errors.js';
import type { KeyValue } from '../../model/types.js';
import { assertUrlAllowed } from '../../net/policy.js';
import { shortId } from '../../util/ids.js';
import { proxyAgentFor } from '../../net/proxy.js';

/**
 * Socket.IO client session: connect to a namespace, listen to every event, emit events with JSON
 * arguments and wait for acknowledgements. Messages are reported like WebSocket messages (with the
 * event name), so the same message log shows them.
 */
export interface SocketIoMessage {
  id: string;
  time: number;
  direction: 'sent' | 'received' | 'system';
  /** Event name (absent for connection messages). */
  event?: string;
  /** JSON text of the arguments (or the system message). */
  data: string;
  size: number;
  /** An acknowledgement (reply) to an emitted event. */
  ack?: boolean;
}

export interface SocketIoOptions {
  /** Path of the Socket.IO endpoint (default /socket.io). */
  path?: string;
  headers?: KeyValue[];
  /** The `auth` payload sent with the handshake (JSON object). */
  auth?: Record<string, unknown>;
  /** websocket only, or polling first then upgrade (the Socket.IO default). */
  transports?: Array<'websocket' | 'polling'>;
  timeoutMs?: number;
}

// the client library loads on the first connection (not at startup)
let socketIoMod: Promise<typeof import('socket.io-client')> | undefined;

export class SocketIoSession {
  readonly id = shortId('sio-');
  private socket?: Socket;
  private messageListeners: Array<(m: SocketIoMessage) => void> = [];
  private statusListeners: Array<(s: 'connecting' | 'open' | 'closed') => void> = [];
  status: 'connecting' | 'open' | 'closed' = 'closed';

  /** `url` is the server and namespace, e.g. http://localhost:3000/chat (ws:// and wss:// work too). */
  constructor(
    readonly url: string,
    private readonly opts: SocketIoOptions = {},
  ) {}

  onMessage(l: (m: SocketIoMessage) => void): void {
    this.messageListeners.push(l);
  }
  onStatus(l: (s: 'connecting' | 'open' | 'closed') => void): void {
    this.statusListeners.push(l);
  }

  private emitMessage(direction: SocketIoMessage['direction'], data: string, extra: Partial<SocketIoMessage> = {}): void {
    const m: SocketIoMessage = { id: shortId('m-'), time: Date.now(), direction, data, size: Buffer.byteLength(data), ...extra };
    for (const l of this.messageListeners) l(m);
  }
  private setStatus(s: SocketIoSession['status']): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  async connect(): Promise<void> {
    let target: URL;
    try {
      target = new URL(this.url.replace(/^ws(s?):/i, 'http$1:'));
    } catch (e) {
      throw new ApsError('ConfigurationError', `Invalid Socket.IO URL: ${(e as Error).message}`);
    }
    await assertUrlAllowed(target);
    const extraHeaders: Record<string, string> = {};
    for (const h of this.opts.headers ?? []) if (h.enabled !== false && h.key) extraHeaders[h.key] = h.value;
    this.setStatus('connecting');
    const { io } = await (socketIoMod ??= import('socket.io-client'));
    const socket = io(target.toString(), {
      path: this.opts.path || '/socket.io',
      extraHeaders,
      auth: this.opts.auth,
      transports: this.opts.transports ?? ['polling', 'websocket'],
      reconnection: false,
      timeout: this.opts.timeoutMs ?? 15_000,
      forceNew: true,
      // through the proxy (Settings ▸ Proxy / HTTP(S)_PROXY) when one applies
      ...(proxyAgentFor(target.toString()) ? { agent: proxyAgentFor(target.toString()) as never } : {}),
    });
    this.socket = socket;
    socket.onAny((event: string, ...args: unknown[]) => this.emitMessage('received', stringify(args), { event }));
    socket.on('disconnect', (reason) => {
      this.emitMessage('system', `Disconnected (${reason})`);
      this.setStatus('closed');
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        this.setStatus('open');
        this.emitMessage('system', `Connected (id ${socket.id}, transport ${socket.io.engine.transport.name})`);
        resolve();
      });
      socket.once('connect_error', (err: Error & { description?: unknown; context?: unknown; data?: unknown }) => {
        this.setStatus('closed');
        socket.close();
        const detail = err.data ? ` (${stringify([err.data])})` : '';
        const msg = `${err.message || 'connection failed'}${detail}`;
        this.emitMessage('system', `Error: ${msg}`);
        reject(
          new ApsError('NetworkError', `Socket.IO connection failed: ${msg}`, {
            suggestions: [
              /xhr poll error|websocket error|ECONNREFUSED/i.test(msg) ? 'Check the URL and that the server is running (Socket.IO servers use http:// / https:// URLs).' : 'The server refused the connection: check the auth payload and headers.',
              'Check the path (default /socket.io) and the namespace in the URL.',
            ],
          }),
        );
      });
    });
  }

  /** Emit an event with arguments; with `ack`, wait for the server's acknowledgement and return it. */
  async emit(event: string, args: unknown[], ack = false, timeoutMs = 10_000): Promise<unknown[] | undefined> {
    const s = this.socket;
    if (!s || this.status !== 'open') throw new ApsError('ProtocolError', 'Socket.IO is not connected');
    if (!event.trim()) throw new ApsError('ValidationError', 'Give the event name');
    this.emitMessage('sent', stringify(args), { event });
    if (!ack) {
      s.emit(event, ...args);
      return undefined;
    }
    try {
      const reply = (await s.timeout(timeoutMs).emitWithAck(event, ...args)) as unknown;
      const list = Array.isArray(reply) ? reply : [reply];
      this.emitMessage('received', stringify(list), { event, ack: true });
      return list;
    } catch {
      this.emitMessage('system', `No acknowledgement for "${event}" within ${timeoutMs} ms`);
      throw new ApsError('TimeoutError', `No acknowledgement for "${event}" within ${timeoutMs} ms`, { suggestions: ['The server may not acknowledge this event: send it without waiting for an acknowledgement.'] });
    }
  }

  close(): void {
    this.socket?.close();
    if (this.status !== 'closed') this.setStatus('closed');
  }
}

const stringify = (args: unknown[]) => {
  try {
    return JSON.stringify(args.length === 1 ? args[0] : args);
  } catch {
    return String(args);
  }
};
