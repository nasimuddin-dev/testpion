import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { request, type Server } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangesFromHar, exchangesToHar, startDebuggerProxy, type DebuggerProxy } from '@testpion/core';
import { ensureRootCertificate, leafSigner } from '@testpion/core/desktop';
import { exchangeView, tlsFindings } from '@testpion/shared';
import { Redactor } from '../../packages/core/src/util/redact';
import { debuggerTools } from '../../packages/core/src/mcp-server/tools/debugger-tools';

// FG-8 / FG-10 / FG-19 / FG-20: binary bodies kept for views, the TLS connection recorded, a HAR round trip, and the MCP `view` option.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 0, 5, 0, 0, 0, 7, 8, 6, 0, 0, 0])]);
const MSGPACK = Buffer.from([0x82, 0xa4, 0x6e, 0x61, 0x6d, 0x65, 0xa3, 0x74, 0x6f, 0x6d, 0xa5, 0x74, 0x6f, 0x6b, 0x65, 0x6e, 0xa6, 0x73, 0x33, 0x63, 0x72, 0x33, 0x74]);

let dir: string;
let api: Server;
let secure: HttpsServer;
let apiPort = 0;
let securePort = 0;
let proxy: DebuggerProxy;
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tp-insp-'));
  const cert = leafSigner(ensureRootCertificate(dir))('localhost');
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    req.resume();
    if (req.url === '/logo.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    if (req.url === '/big.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(3000, 7));
    if (req.url === '/mp') return res.writeHead(200, { 'content-type': 'application/x-msgpack' }).end(MSGPACK);
    if (req.url === '/gql') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { user: null }, errors: [{ message: 'nope' }] }));
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=60' }).end('ok');
  };
  api = createServer(handler);
  secure = createHttps({ cert: cert.cert, key: cert.key }, handler);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => secure.listen(0, '127.0.0.1', () => r()));
  apiPort = (api.address() as { port: number }).port;
  securePort = (secure.address() as { port: number }).port;
  proxy = await startDebuggerProxy({ maxBodyBytes: 2048, applicationOf: async () => 'vitest', decrypt: { leafFor: leafSigner(ensureRootCertificate(dir)), enabled: () => true, insecureUpstream: true } });
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => secure.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const via = (url: string, body?: string, type = 'application/json') =>
  new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, method: body ? 'POST' : 'GET', path: url, headers: { host: new URL(url).host, ...(body ? { 'content-type': type } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end(body);
  });
const find = (suffix: string) => proxy.exchanges.find((x) => x.url.endsWith(suffix))!;

describe('bodies kept as bytes for a view', () => {
  it('keeps an image and MessagePack whole as base64 when they fit; a body over the limit is counted, not kept', async () => {
    await via(`http://127.0.0.1:${apiPort}/logo.png`);
    await via(`http://127.0.0.1:${apiPort}/mp`);
    await via(`http://127.0.0.1:${apiPort}/big.png`);
    await settle();
    const png = find('/logo.png');
    expect(png.responseBody).toBeUndefined();
    expect(Buffer.from(png.responseBodyBase64!, 'base64').equals(PNG)).toBe(true);
    expect(exchangeView(png, 'image')).toMatchObject({ ok: true, data: { format: 'png', width: 5, height: 7 } });
    const mp = find('/mp');
    expect(exchangeView(mp, 'msgpack')).toMatchObject({ ok: true, data: { value: { name: 'tom', token: 's3cr3t' } } });
    const big = find('/big.png');
    expect(big.responseBodyBase64).toBeUndefined();
    expect(big.responseBodyBytes).toBe(3000);
    expect(exchangeView(big, 'image')).toMatchObject({ ok: false, error: expect.stringMatching(/not kept/) });
  });

  it('an image goes into the HAR as base64 and comes back; MessagePack is not written (a redactor cannot read bytes)', async () => {
    const har = exchangesToHar([find('/logo.png'), find('/mp')], new Redactor(), 'test');
    const entries = (har as unknown as { log: { entries: Array<{ response: { content: { encoding?: string; text?: string } } }> } }).log.entries;
    expect(entries[0]!.response.content.encoding).toBe('base64');
    expect(entries[1]!.response.content.text).toBe('');
    const back = exchangesFromHar(JSON.parse(JSON.stringify(har)));
    expect(back[0]!.responseBody).toBeUndefined();
    expect(back[0]!.responseBodyBase64).toBe(find('/logo.png').responseBodyBase64);
    // a base64 that is not an image, or not base64 at all, is not taken
    const bad = JSON.parse(JSON.stringify(har));
    bad.log.entries[0].response.content.text = 'not base64 !!';
    expect(exchangesFromHar(bad)[0]!.responseBodyBase64).toBeUndefined();
  });
});

describe('the TLS connection', () => {
  it('records version, cipher, ALPN and the certificate chain of an https upstream; findings are plain', async () => {
    await via(`https://localhost:${securePort}/hello`);
    await settle(150);
    const e = find('/hello');
    expect(e.connection?.version).toMatch(/^TLSv1\.[23]$/);
    expect(e.connection?.cipher).toBeTruthy();
    expect(e.connection?.chain?.[0]?.san).toContain('localhost');
    expect(e.connection?.chain?.[0]?.validTo).toBeTruthy();
    const f = tlsFindings(e.connection!, 'localhost');
    expect(f.some((x) => x.level === 'bad' && /expired/.test(x.text))).toBe(false);
    expect(exchangeView(e, 'tls')).toMatchObject({ ok: true });
    expect(exchangeView(e, 'caching')).toMatchObject({ ok: true, data: { verdict: 'fresh-cacheable', freshSeconds: 60 } });
    // a HAR carries the connection
    const har = exchangesToHar([e], new Redactor(), 'test');
    expect(exchangesFromHar(JSON.parse(JSON.stringify(har)))[0]!.connection?.version).toBe(e.connection?.version);
  });
});

describe('MCP debugger_exchange view', () => {
  it('reads a body as a view, masks what a decoder reads out, and never returns the raw bytes', async () => {
    const session = proxy.exchanges;
    const tools = debuggerTools({ redactor: new Redactor(), session });
    const tool = tools.find((t) => t.name === 'debugger_exchange')!;
    const mp = find('/mp');
    const r = (await tool.run({ id: mp.id, view: 'msgpack' }, {} as never)) as { ok: boolean; text: string; data: unknown };
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).toContain('"name":"tom"');
    expect(JSON.stringify(r)).not.toContain('s3cr3t'); // the data and the text drawn from it are masked
    const whole = JSON.stringify(await tool.run({ id: find('/logo.png').id }, {} as never));
    expect(whole).not.toContain('responseBodyBase64');
    await expect(Promise.resolve().then(() => tool.run({ id: mp.id, view: 'bogus' }, {} as never))).rejects.toThrow(/Unknown view/);
    // GraphQL: the list can carry the operation
    await via(`http://127.0.0.1:${apiPort}/gql`, JSON.stringify({ query: 'query Me { user { id } }', variables: { a: 1 } }));
    await settle();
    const list = (await tools.find((t) => t.name === 'debugger_exchanges')!.run({ include: ['graphql'], text: '/gql' }, {} as never)) as { exchanges: Array<{ graphql?: { label: string; errors: unknown[] } }> };
    expect(list.exchanges[0]!.graphql).toMatchObject({ label: 'query Me', errors: [{ message: 'nope' }] });
  });
});
