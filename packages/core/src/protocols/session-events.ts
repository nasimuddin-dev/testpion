import { shortId } from '../util/ids.js';

export type SessionStatus = 'connecting' | 'open' | 'closed';

/** What every message of a real-time session carries. */
export interface SessionMessage {
  id: string;
  time: number;
  direction: 'sent' | 'received' | 'system';
  data: string;
  size: number;
}

/**
 * The listeners, status and message log the Socket.IO, MQTT and Kafka sessions share. `emitMessage` stamps a message
 * (id, time, size of the full text) and cuts its text at `maxText` characters.
 */
export class SessionEvents<M extends SessionMessage> {
  status: SessionStatus = 'closed';
  private messageListeners: Array<(m: M) => void> = [];
  private statusListeners: Array<(s: SessionStatus) => void> = [];

  constructor(private readonly maxText = Infinity) {}

  onMessage(l: (m: M) => void): void {
    this.messageListeners.push(l);
  }
  onStatus(l: (s: SessionStatus) => void): void {
    this.statusListeners.push(l);
  }

  protected emitMessage(direction: M['direction'], data: string, extra: Partial<M> = {}): void {
    const m = { id: shortId('m-'), time: Date.now(), direction, data: data.length > this.maxText ? data.slice(0, this.maxText) + '… [truncated]' : data, size: Buffer.byteLength(data), ...extra } as M;
    for (const l of this.messageListeners) l(m);
  }
  protected setStatus(s: SessionStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }
}
