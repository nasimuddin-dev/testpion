import { describe, expect, it } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { watchSend } from '../../packages/core/src/protocols/http/socket-timing.js';

// P-3: connection timing waiters were capped at 200 (the oldest dropped: above 200 concurrent requests the connection data was
// lost and new-vs-reused undercounted) and each sendHeaders event scanned all of them
describe('connection data under concurrency', () => {
  const sendHeaders = channel('undici:client:sendHeaders');
  const socket = { remoteAddress: '10.0.0.1', remotePort: 80 };

  it('1,000 concurrent requests to one URL each get their own socket data, quickly', () => {
    const url = new URL('http://api.test/same?x=1');
    const watches = Array.from({ length: 1000 }, () => watchSend(url, 'GET'));
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) sendHeaders.publish({ request: { origin: 'http://api.test', path: '/same?x=1', method: 'GET' }, socket: { ...socket, remotePort: 1000 + i } });
    const ms = performance.now() - t0;
    console.log(`1,000 sendHeaders events: ${ms.toFixed(1)} ms`);
    // first come first served: the nth request got the nth socket
    expect(watches.every((w, i) => w.result()?.remotePort === 1000 + i)).toBe(true);
    watches.forEach((w) => w.stop());
    expect(ms).toBeLessThan(200 * Number(process.env.TESTPION_PERF_SLACK ?? 1));
  });

  it('another URL is not matched, and a stopped watch gets nothing', () => {
    const a = watchSend(new URL('http://api.test/a'), 'GET');
    const b = watchSend(new URL('http://api.test/b'), 'POST');
    a.stop();
    sendHeaders.publish({ request: { origin: 'http://api.test', path: '/b', method: 'GET' }, socket });
    sendHeaders.publish({ request: { origin: 'http://api.test', path: '/a', method: 'GET' }, socket });
    expect(a.result()).toBeUndefined();
    expect(b.result()).toBeUndefined();
    sendHeaders.publish({ request: { origin: 'http://api.test', path: '/b', method: 'POST' }, socket });
    expect(b.result()?.remoteAddress).toBe('10.0.0.1');
    b.stop();
  });
});
