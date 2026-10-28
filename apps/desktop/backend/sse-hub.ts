/**
 * Server-sent events to the clients of a bridge, with the socket's backpressure honoured: `res.write()` answering false means the
 * client is not reading as fast as events come, so that client's events wait in a bounded queue and go on at `drain`. When the queue
 * is full the oldest events that can be lost (run progress, console lines, streamed text) are dropped first; events a window
 * cannot do without (`data.changed`, a run's end) are never dropped, and a client that falls so far behind that even those pile up is
 * disconnected (it reconnects and reads again). One slow client never holds memory without bound, or slows the others.
 */
import type { ServerResponse } from 'node:http';

/** Channels whose events must arrive: dropping one leaves the window showing stale data or a run that never ends. */
const KEEP = /^(data\.changed|run\.finished|run\.error|workspace\.|monitor\.result|secrets\.blocked|scripts\.blocked)/;

interface Client {
  res: ServerResponse;
  queue: Array<{ data: string; keep: boolean }>;
  blocked: boolean;
  dropped: number;
  /** Characters waiting in the queue (an event can be megabytes: a count alone does not bound the memory). */
  bytes: number;
}

export class SseHub {
  private readonly clients = new Set<Client>();

  constructor(
    private readonly maxQueue = 1000,
    /** The most characters one slow client may hold in its queue. */
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  /** Characters waiting in the queues of the slow clients now (diagnostics, tests). */
  get queuedBytes(): number {
    let n = 0;
    for (const c of this.clients) n += c.bytes;
    return n;
  }

  /** Events dropped for clients that were slow, in total (diagnostics, tests). */
  dropped = 0;
  disconnected = 0;

  /** Add a client; the answer removes it. */
  add(res: ServerResponse): () => void {
    const c: Client = { res, queue: [], blocked: false, dropped: 0, bytes: 0 };
    this.clients.add(c);
    res.on('drain', () => this.flush(c));
    res.on('close', () => this.clients.delete(c));
    return () => this.clients.delete(c);
  }

  broadcast(channel: string, payload: unknown): void {
    const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    const keep = KEEP.test(channel);
    for (const c of this.clients) this.send(c, { data, keep });
  }

  private send(c: Client, m: { data: string; keep: boolean }): void {
    if (c.res.destroyed) return void this.clients.delete(c);
    if (c.blocked) {
      c.queue.push(m);
      c.bytes += m.data.length;
      if (c.queue.length > this.maxQueue || c.bytes > this.maxBytes) this.trim(c);
      return;
    }
    if (!c.res.write(m.data)) c.blocked = true;
  }

  /** Over the limit (events or characters): drop the oldest events that can be lost; if only must-keep events are left, the client is too far behind. */
  private trim(c: Client): void {
    let excess = c.queue.length - this.maxQueue;
    let excessBytes = c.bytes - this.maxBytes;
    let lost = 0;
    c.queue = c.queue.filter((m) => {
      if ((excess > 0 || excessBytes > 0) && !m.keep) {
        excess--;
        excessBytes -= m.data.length;
        c.bytes -= m.data.length;
        lost++;
        return false;
      }
      return true;
    });
    c.dropped += lost;
    this.dropped += lost;
    if (c.queue.length > this.maxQueue || c.bytes > this.maxBytes) {
      this.clients.delete(c);
      this.disconnected++;
      c.queue = [];
      c.bytes = 0;
      c.res.destroy();
    }
  }

  private flush(c: Client): void {
    c.blocked = false;
    while (c.queue.length && !c.blocked) {
      const m = c.queue.shift()!;
      c.bytes -= m.data.length;
      if (!c.res.write(m.data)) c.blocked = true;
    }
  }
}
