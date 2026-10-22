import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeHttp } from '../../packages/core/src/index.js';

let server: Server;
let base: string;
const hits: Record<string, number> = {};
beforeAll(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits[key] = (hits[key] ?? 0) + 1;
    // fails twice, then answers
    if (hits[key]! <= 2) return res.writeHead(503, { 'retry-after': '0' }).end('busy');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('request retries', () => {
  it('retries 5xx for safe methods until it succeeds, and reports the attempts', async () => {
    const { response } = await executeHttp({ method: 'GET', url: `${base}/a`, settings: { retries: 2, retryDelayMs: 1 } });
    expect(response.status).toBe(200);
    expect(response.attempts).toBe(3);
  });

  it('gives up after the configured retries', async () => {
    const { response } = await executeHttp({ method: 'GET', url: `${base}/b`, settings: { retries: 1, retryDelayMs: 1 } });
    expect(response.status).toBe(503);
    expect(response.attempts).toBe(2);
  });

  it('does not repeat a POST that reached the server', async () => {
    const { response } = await executeHttp({ method: 'POST', url: `${base}/c`, settings: { retries: 3, retryDelayMs: 1 } });
    expect(response.status).toBe(503);
    expect(hits['POST /c']).toBe(1);
  });

  it('retries a refused connection, then reports the error', async () => {
    const t0 = Date.now();
    await expect(executeHttp({ method: 'POST', url: 'http://127.0.0.1:1/x', settings: { retries: 2, retryDelayMs: 50, retryJitter: false } })).rejects.toThrow();
    // two waits: 50 + 100 ms (exact: jitter off)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('without retries nothing changes', async () => {
    const { response } = await executeHttp({ method: 'GET', url: `${base}/d` });
    expect(response.status).toBe(503);
    expect(response.attempts).toBeUndefined();
  });
});
