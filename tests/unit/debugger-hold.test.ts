import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { startDebuggerProxy, type DebuggerProxy, type DebuggerRule } from '@testpion/core';

// Mem-1: the proxy held request bodies whole with no limit, and held responses went through a UTF-8 string (binary bytes were changed)
let api: Server;
let apiPort = 0;
let proxy: DebuggerProxy;
let rules: DebuggerRule[] = [];
const binary = randomBytes(200_000);
const received: Array<{ url: string; bytes: number; sha: string }> = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    const hash = createHash('sha256');
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      hash.update(c);
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', bytes, sha: hash.digest('hex') });
      if (req.url === '/binary') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(binary);
      if (req.url === '/huge') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(3 * 1024 * 1024, 9));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiPort = (api.address() as { port: number }).port;
  // a hold limit of 1 MB stands in for 64 MB
  proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', rules: () => rules, holdLimitBytes: 1024 * 1024 });
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => api.close(() => r()));
});

const viaProxy = (method: string, path: string, body?: Buffer) =>
  new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
    const url = `http://127.0.0.1:${apiPort}${path}`;
    const req = request({ host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: `127.0.0.1:${apiPort}`, ...(body ? { 'content-type': 'application/octet-stream' } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });

describe('held bodies', () => {
  it('a held binary response arrives byte for byte (it went through UTF-8 text before)', async () => {
    rules = [{ id: 'h', name: 'Add header', enabled: true, kind: 'modify', match: { url: '*/binary*' }, responseHeaders: [{ op: 'set', name: 'x-edited', value: '1' }] }];
    const r = await viaProxy('GET', '/binary');
    expect(r.status).toBe(200);
    expect(r.headers['x-edited']).toBe('1'); // the rule held it
    expect(createHash('sha256').update(r.body).digest('hex')).toBe(createHash('sha256').update(binary).digest('hex'));
  });

  it('a response over the hold limit still arrives whole, unchanged', async () => {
    rules = [{ id: 'h', name: 'Add header', enabled: true, kind: 'modify', match: { url: '*/huge*' }, responseHeaders: [{ op: 'set', name: 'x-edited', value: '1' }] }];
    const r = await viaProxy('GET', '/huge');
    expect(r.headers['x-edited']).toBeUndefined(); // too big to hold: sent on unchanged
    expect(r.body.length).toBe(3 * 1024 * 1024);
    expect(r.body.every((b) => b === 9)).toBe(true);
  });

  it('an upload over the hold limit reaches the server whole, counted, with only its first part kept', async () => {
    rules = [];
    received.length = 0;
    const upload = randomBytes(5 * 1024 * 1024);
    const r = await viaProxy('POST', '/upload', upload);
    expect(r.status).toBe(200);
    expect(received).toEqual([{ url: '/upload', bytes: upload.length, sha: createHash('sha256').update(upload).digest('hex') }]);
    await new Promise((r2) => setTimeout(r2, 100));
    const e = proxy.exchanges.find((x) => x.url.endsWith('/upload'))!;
    expect(e.requestBodyBytes).toBe(upload.length);
    expect(e.requestBodyTruncated).toBe(true);
  });
});
