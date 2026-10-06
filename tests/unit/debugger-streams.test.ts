import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { duplexPair } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { ensureRootCertificate, exchangesFromSaz, leafSigner, parseRawHttp, sseParser, startDebuggerProxy, webSocketFrameParser, type DebuggerProxy } from '@testpion/core';

// DBG-4: HTTPS decrypted with the root certificate, WebSocket frames and SSE events read on the way, Fiddler SAZ files opened.

describe('debugger: frame and event parsers', () => {
  it('reads masked WebSocket frames, split across chunks', () => {
    const frames: Array<{ opcode: string; text?: string; bytes: number }> = [];
    const p = webSocketFrameParser('sent', (f) => frames.push({ opcode: f.opcode, text: f.text, bytes: f.bytes }));
    const payload = Buffer.from('hello');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!));
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
    p.push(frame.subarray(0, 3));
    expect(frames).toEqual([]);
    p.push(frame.subarray(3));
    expect(frames).toEqual([{ opcode: 'text', text: 'hello', bytes: 5 }]);
    p.push(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    expect(frames[1]).toMatchObject({ opcode: 'close', text: 'code 1000' });
  });

  it('reads Server-Sent Events with event names, ids and multi-line data', () => {
    const events: Array<{ event?: string; id?: string; data: string }> = [];
    const p = sseParser((e) => events.push({ event: e.event, id: e.id, data: e.data }));
    p.push(Buffer.from('event: tick\nid: 1\ndata: a\ndata: b\n\n: comment\ndata: {"x":1}\n\nretry: 100\ndata: last'));
    p.end();
    expect(events).toEqual([
      { event: 'tick', id: '1', data: 'a\nb' },
      { event: undefined, id: undefined, data: '{"x":1}' },
      { event: undefined, id: undefined, data: 'last' },
    ]);
  });
});

describe('debugger: Fiddler SAZ', () => {
  const zip = (files: Record<string, string>) => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameBuf = Buffer.from(name);
      const data = deflateRawSync(Buffer.from(text));
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(Buffer.byteLength(text), 22);
      local.writeUInt16LE(nameBuf.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(Buffer.byteLength(text), 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, data);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  };

  it('opens the sessions of a SAZ file with timings and the process', () => {
    const saz = zip({
      'raw/1_c.txt': 'POST /api/login HTTP/1.1\r\nHost: shop.test\r\nContent-Type: application/json\r\n\r\n{"user":"a"}',
      'raw/1_s.txt': 'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{"token":"t"}',
      'raw/1_m.xml':
        '<Session><SessionTimers ClientBeginRequest="2026-01-01T10:00:00.000+00:00" ServerBeginResponse="2026-01-01T10:00:00.250+00:00" ClientDoneResponse="2026-01-01T10:00:00.400+00:00" /><SessionFlags><SessionFlag N="x-ProcessInfo" V="chrome:1234" /><SessionFlag N="x-clientport" V="5" /></SessionFlags><ClientPort="51000"/></Session>',
      'raw/2_c.txt': 'CONNECT secure.test:443 HTTP/1.1\r\nHost: secure.test:443\r\n\r\n',
      'raw/2_s.txt': 'HTTP/1.1 200 Connection Established\r\n\r\n',
      '_index.htm': '<html></html>',
    });
    const list = exchangesFromSaz(saz);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      method: 'POST',
      url: 'http://shop.test/api/login',
      host: 'shop.test',
      status: 201,
      requestBody: '{"user":"a"}',
      responseBody: '{"token":"t"}',
      waitMs: 250,
      durationMs: 400,
      application: 'chrome',
      clientPort: 51000,
    });
    expect(list[1]).toMatchObject({ kind: 'tunnel', method: 'CONNECT', url: 'https://secure.test:443', status: 200 });
    expect(parseRawHttp('GET / HTTP/1.1\r\nA: 1\r\n\r\nbody').headers).toEqual({ a: '1' });
  });
});

describe('debugger: HTTPS decryption, WebSocket and SSE through the proxy', () => {
  let dir: string;
  let api: Server;
  let apiPort = 0;
  let secure: HttpsServer;
  let securePort = 0;
  let wss: WebSocketServer;
  let proxy: DebuggerProxy;
  let root: ReturnType<typeof ensureRootCertificate>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tp-dbg-'));
    root = ensureRootCertificate(dir);
    const leaf = leafSigner(root);
    // the "real" server also has a certificate from our root, so the proxy's upstream trusts it with the root as CA
    const serverCert = leaf('localhost');
    secure = createHttpsServer({ cert: serverCert.cert, key: serverCert.key }, (req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: hello\ndata: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 60);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ secret: 'decrypted', path: req.url, ua: req.headers['user-agent'] }));
    });
    await new Promise<void>((r) => secure.listen(0, '127.0.0.1', () => r()));
    securePort = (secure.address() as { port: number }).port;
    api = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('plain'));
    wss = new WebSocketServer({ server: api });
    wss.on('connection', (ws) => {
      ws.on('message', (m) => ws.send(`echo ${m.toString()}`));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({
      applicationOf: async () => 'vitest',
      decrypt: { leafFor: leaf, enabled: (host) => host !== 'opaque.test', insecureUpstream: true },
    });
  });
  afterAll(async () => {
    await proxy.close();
    wss.close();
    await new Promise<void>((r) => api.close(() => r()));
    await new Promise<void>((r) => secure.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  /** CONNECT through the proxy, then TLS inside it with the root as the trusted CA, then one request. */
  const viaTunnel = (path: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `localhost:${securePort}` });
      req.on('connect', (_res, socket) => {
        const tls = tlsConnect({ socket, servername: 'localhost', ca: root.certPem }, () => {
          const inner = httpsRequest({ createConnection: () => tls, host: 'localhost', port: securePort, path, headers: { 'user-agent': 'tunnel-app' } }, (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          });
          inner.on('error', reject);
          inner.end();
        });
        tls.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

  it('decrypts HTTPS: the request inside the tunnel is listed whole, marked tls', async () => {
    const r = await viaTunnel('/private?x=1');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ secret: 'decrypted', path: '/private?x=1', ua: 'tunnel-app' });
    await settle();
    const e = proxy.exchanges.find((x) => x.url === `https://localhost:${securePort}/private?x=1`)!;
    expect(e).toBeDefined();
    expect(e.kind).toBe('http');
    expect(e.tls).toBe(true);
    expect(e.status).toBe(200);
    expect(JSON.parse(e.responseBody!)).toMatchObject({ secret: 'decrypted' });
    expect(e.requestHeaders['user-agent']).toBe('tunnel-app');
    expect(proxy.exchanges.some((x) => x.kind === 'tunnel' && x.host === `localhost:${securePort}`)).toBe(false);
  });

  it('a program that does not trust the root gets a failed tunnel with the reason', async () => {
    // a program that hangs up after seeing a certificate it does not trust (a browser sends an alert, then closes)
    await new Promise<void>((resolve) => {
      const sock = netConnect(proxy.port, '127.0.0.1', () => sock.write(`CONNECT localhost:${securePort} HTTP/1.1\r\nHost: localhost:${securePort}\r\n\r\n`));
      sock.once('data', () => {
        const [a, b] = duplexPair();
        sock.pipe(b);
        b.pipe(sock);
        const tls = tlsConnect({ socket: a, servername: 'localhost' });
        tls.on('error', () => (sock.destroy(), resolve()));
      });
    });
    await settle();
    const e = proxy.exchanges.find((x) => x.kind === 'tunnel' && x.error);
    expect(e?.error).toMatch(/did not trust the TestPion root certificate/);
  });

  it('follows a WebSocket frame by frame', async () => {
    const echoed = await new Promise<string>((resolve, reject) => {
      // the upgrade goes to the proxy with the absolute URL, as a program with HTTP_PROXY would send it
      const req = request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: `http://127.0.0.1:${apiPort}/socket`,
        headers: { host: `127.0.0.1:${apiPort}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64') },
      });
      req.on('upgrade', (_res, socket) => {
        const payload = Buffer.from('ping!');
        const mask = Buffer.from([9, 8, 7, 6]);
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))]));
        socket.once('data', (c: Buffer) => {
          resolve(c.subarray(2).toString('utf8'));
          socket.end();
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(echoed).toBe('echo ping!');
    await settle(400);
    const e = proxy.exchanges.find((x) => x.kind === 'websocket')!;
    expect(e.url).toBe(`ws://127.0.0.1:${apiPort}/socket`);
    expect(e.status).toBe(101);
    expect(e.frames?.map((f) => [f.direction, f.text])).toEqual([
      ['sent', 'ping!'],
      ['received', 'echo ping!'],
    ]);
  });

  it('lists Server-Sent Events as they arrive, inside the decrypted tunnel', async () => {
    const r = await viaTunnel('/events');
    expect(r.text).toContain('data: two');
    await settle(400);
    const e = proxy.exchanges.find((x) => x.url.endsWith('/events'))!;
    expect(e.events?.map((ev) => [ev.event, ev.data])).toEqual([
      ['hello', 'one'],
      [undefined, 'two'],
    ]);
    expect(e.open).toBeUndefined();
  });

  it('keeps an opaque tunnel for hosts where decryption is off', async () => {
    const before = proxy.exchanges.length;
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: 'opaque.test:1' });
      req.on('connect', (_r, socket) => socket.end());
      req.on('response', () => resolve());
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.end();
    });
    await settle();
    const e = proxy.exchanges.slice(before).find((x) => x.kind === 'tunnel' && x.host === 'opaque.test:1');
    expect(e).toBeDefined();
  });
});

describe('debugger: the root certificate', () => {
  it('is created once per folder, with a fingerprint and ten years, and signs certificates per host with SANs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-root-'));
    try {
      const a = ensureRootCertificate(dir);
      const b = ensureRootCertificate(dir);
      expect(a.certPem).toBe(b.certPem);
      expect(a.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(Date.parse(a.notAfter) - Date.now()).toBeGreaterThan(9 * 365 * 24 * 3600_000);
      const leaf = leafSigner(a);
      const l1 = leaf('api.example.com:443');
      expect(leaf('API.example.com')).toBe(l1);
      expect(l1.cert).toContain('BEGIN CERTIFICATE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
