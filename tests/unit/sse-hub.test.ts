import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SseHub } from '../../apps/desktop/backend/sse-hub.js';

// The bridge honours the socket's backpressure: a client that does not read cannot make the process hold events without bound,
// and it does not slow the clients that do read.
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections?.(), s.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bridge(hub: SseHub): Promise<number> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
    hub.add(res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

/** A client; with `read: false` it connects and never reads (its socket buffers fill). */
function client(port: number, read: boolean): { got: () => number; lastSeq: () => number; close(): void } {
  let bytes = 0;
  let last = -1;
  const req = request({ host: '127.0.0.1', port, path: '/events' }, (res) => {
    if (!read) return void res.pause();
    res.on('data', (b: Buffer) => {
      bytes += b.length;
      for (const m of b.toString().matchAll(/"seq":(\d+)/g)) last = Number(m[1]);
    });
  });
  req.end();
  return { got: () => bytes, lastSeq: () => last, close: () => req.destroy() };
}

describe('SSE hub with backpressure', () => {
  it('a client that never reads holds a bounded queue; the events it can lose are dropped, the ones it cannot are kept', async () => {
    const hub = new SseHub(200);
    const port = await bridge(hub);
    const slow = client(port, false);
    const fast = client(port, true);
    await sleep(150);
    expect(hub.size).toBe(2);
    const big = 'x'.repeat(16 * 1024); // 16 KB per event: the slow socket's buffers fill after a few MB
    const N = 3000;
    for (let i = 0; i < N; i++) {
      hub.broadcast('run.events', { seq: i, pad: big });
      if (i % 50 === 0) await sleep(8); // let the reading client keep up
    }
    hub.broadcast('data.changed', { seq: N, pad: '' });
    await sleep(500);
    // the fast client got everything up to the last event
    expect(fast.lastSeq()).toBe(N);
    expect(fast.got()).toBeGreaterThan(20 * 1024 * 1024); // it read most of it (a burst faster than any reader is trimmed too)
    // the slow one: events were dropped instead of queued without end, and the client is still connected (the must-keep event fits)
    expect(hub.dropped).toBeGreaterThan(1000);
    slow.close();
    fast.close();
  });

  it('a client that falls behind on events that must not be lost is disconnected', async () => {
    const hub = new SseHub(50);
    const port = await bridge(hub);
    const slow = client(port, false);
    await sleep(150);
    const big = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 2000; i++) hub.broadcast('data.changed', { seq: i, pad: big });
    await sleep(100);
    expect(hub.disconnected).toBe(1);
    expect(hub.size).toBe(0);
    slow.close();
  });

  it('the queue empties on drain when the client starts reading again', async () => {
    const hub = new SseHub(5000);
    const port = await bridge(hub);
    let bytes = 0;
    let resume!: () => void;
    const req = request({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      res.pause();
      resume = () => res.resume();
      res.on('data', (b: Buffer) => (bytes += b.length));
    });
    req.end();
    await sleep(150);
    const big = 'y'.repeat(16 * 1024);
    for (let i = 0; i < 600; i++) hub.broadcast('data.changed', { seq: i, pad: big });
    resume();
    await sleep(800);
    expect(bytes).toBeGreaterThan(600 * 16 * 1024);
    expect(hub.dropped).toBe(0);
    req.destroy();
  });
});
