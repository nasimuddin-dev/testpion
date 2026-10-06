import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { startDebuggerProxy, type DebuggerProxy } from '@testpion/core';

// DBG-1: a program's traffic through the proxy is captured whole, with timings, sizes and the program's name.
let api: Server;
let apiPort = 0;
let proxy: DebuggerProxy;

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/slow') return setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('late'), 120);
      if (req.url === '/big') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(100_000, 1));
      res
        .writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ path: req.url, method: req.method, got: body, ua: req.headers['user-agent'] ?? null }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiPort = (api.address() as { port: number }).port;
  proxy = await startDebuggerProxy({ maxBodyBytes: 1024, applicationOf: async () => 'vitest' });
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => api.close(() => r()));
});

/** Send through the proxy the way a program with HTTP_PROXY does: the absolute URL on the request line. */
const viaProxy = (method: string, url: string, body?: string) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: new URL(url).host, 'user-agent': 'demo-app/1.0', ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });

describe('debugger proxy', () => {
  it('captures requests and responses whole, with timings, and names the program', async () => {
    const r = await viaProxy('POST', `http://127.0.0.1:${apiPort}/orders?x=1`, '{"a":1}');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ path: '/orders?x=1', method: 'POST', got: '{"a":1}', ua: 'demo-app/1.0' });
    await new Promise((r) => setTimeout(r, 50));
    const e = proxy.exchanges.find((x) => x.url.endsWith('/orders?x=1'))!;
    expect(e.kind).toBe('http');
    expect(e.method).toBe('POST');
    expect(e.host).toBe(`127.0.0.1:${apiPort}`);
    expect(e.requestBody).toBe('{"a":1}');
    expect(e.requestHeaders['user-agent']).toBe('demo-app/1.0');
    expect(e.status).toBe(200);
    expect(JSON.parse(e.responseBody!)).toMatchObject({ method: 'POST' });
    expect(e.contentType).toContain('application/json');
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(e.waitMs).toBeLessThanOrEqual(e.durationMs!);
    expect(e.application).toBe('vitest');
  });

  it('keeps status codes and the wait before the first byte', async () => {
    expect((await viaProxy('GET', `http://127.0.0.1:${apiPort}/missing`)).status).toBe(404);
    await viaProxy('GET', `http://127.0.0.1:${apiPort}/slow`);
    await new Promise((r) => setTimeout(r, 50));
    expect(proxy.exchanges.find((x) => x.url.endsWith('/missing'))!.status).toBe(404);
    expect(proxy.exchanges.find((x) => x.url.endsWith('/slow'))!.waitMs).toBeGreaterThanOrEqual(100);
  });

  it('counts a large or binary body without keeping it', async () => {
    const r = await viaProxy('GET', `http://127.0.0.1:${apiPort}/big`);
    expect(r.text.length).toBe(100_000);
    await new Promise((r) => setTimeout(r, 50));
    const e = proxy.exchanges.find((x) => x.url.endsWith('/big'))!;
    expect(e.responseBodyBytes).toBe(100_000);
    expect(e.responseBody).toBeUndefined();
  });

  it('reports a host that does not answer as an error on the exchange, not a crash', async () => {
    const r = await viaProxy('GET', 'http://127.0.0.1:1/nothing');
    expect(r.status).toBe(502);
    await new Promise((r) => setTimeout(r, 50));
    const e = proxy.exchanges.find((x) => x.url.includes(':1/nothing'))!;
    expect(e.error).toBeTruthy();
    proxy.clear();
    expect(proxy.exchanges).toEqual([]);
  });
});
