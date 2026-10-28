import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer, connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGateway, checkGatewayUrl, describeGateway, resolveGateway, startDebuggerProxy, type DebuggerProxy, type GatewayConfig } from '@testpion/core';
import { ensureRootCertificate, leafSigner } from '@testpion/core/desktop';

// FG-9: the Debugger's traffic leaves through the corporate gateway (an upstream proxy), with its bypass list, extra authorities
// and client certificates. The "corporate proxy" here is a local server that maps made-up names to local servers.

let dir: string;
let origin: Server;
let originPort = 0;
let secure: TlsServer;
let securePort = 0;
let gateway: Server;
let gatewayPort = 0;
let proxy: DebuggerProxy;
let config: GatewayConfig = { mode: 'none' };
let secrets: Record<string, string> = {};
const seen: Array<{ method?: string; url?: string; auth?: string }> = [];
let requireAuth = false;
let clientCertSeen: string | undefined;
let debuggerRoot: ReturnType<typeof ensureRootCertificate>;
let originRoot: ReturnType<typeof ensureRootCertificate>;

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const MAP: Record<string, number> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tp-gw-'));
  debuggerRoot = ensureRootCertificate(join(dir, 'debugger'));
  originRoot = ensureRootCertificate(join(dir, 'origin'));
  origin = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(`origin ${req.url}`));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  originPort = (origin.address() as { port: number }).port;

  // an HTTPS server with a certificate for secure.corp.test from its own root, asking for (not requiring) a client certificate
  const leaf = leafSigner(originRoot)('secure.corp.test');
  secure = createTlsServer({ cert: leaf.cert, key: leaf.key, requestCert: true, rejectUnauthorized: false }, (s) => {
    clientCertSeen = s.getPeerCertificate()?.subject?.CN;
    s.once('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nsecure ok'));
  });
  await new Promise<void>((r) => secure.listen(0, '127.0.0.1', () => r()));
  securePort = (secure.address() as { port: number }).port;

  MAP['api.corp.test'] = originPort;
  MAP['secure.corp.test:443'] = securePort;
  gateway = createServer((req, res) => {
    const auth = req.headers['proxy-authorization'] as string | undefined;
    seen.push({ method: req.method, url: req.url, auth });
    if (requireAuth && !auth) return res.writeHead(407).end();
    const u = new URL(req.url!);
    const port = MAP[u.hostname];
    if (!port) return res.writeHead(502).end('unknown name');
    const up = request({ host: '127.0.0.1', port, method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  gateway.on('connect', (req: IncomingMessage, socket) => {
    const auth = req.headers['proxy-authorization'] as string | undefined;
    seen.push({ method: 'CONNECT', url: req.url, auth });
    if (requireAuth && !auth) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    const port = MAP[req.url!];
    if (!port) return socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const up = netConnect({ host: '127.0.0.1', port }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
  gatewayPort = (gateway.address() as { port: number }).port;

  proxy = await startDebuggerProxy({
    applicationOf: async () => 'vitest',
    decrypt: { leafFor: leafSigner(debuggerRoot), enabled: () => true },
    gateway: () => resolveGateway(config, { secret: (n) => secrets[n] }),
  });
});
afterAll(async () => {
  await proxy.close();
  gateway.closeAllConnections?.();
  await new Promise<void>((r) => gateway.close(() => r()));
  await new Promise<void>((r) => origin.close(() => r()));
  await new Promise<void>((r) => secure.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const viaProxy = (url: string) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });

/** HTTPS through the proxy's decrypting tunnel, trusting the Debugger's root, as a program with the root installed does. */
const secureViaProxy = (host: string) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const c = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `${host}:443` });
    c.on('connect', (_r, socket) => {
      const tls = tlsConnect({ socket, servername: host, ca: debuggerRoot.certPem });
      const req = httpsRequest({ createConnection: () => tls, host, path: '/' }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      req.end();
    });
    c.on('error', reject);
    c.end();
  });

describe('gateway configuration', () => {
  it('checks the address and cleans loose input', () => {
    expect(checkGatewayUrl('proxy.corp.example:3128')).toBeUndefined();
    expect(checkGatewayUrl('https://proxy.corp.example')).toMatch(/http:\/\//);
    expect(checkGatewayUrl('')).toMatch(/Give the gateway/);
    expect(cleanGateway({ mode: 'manual', url: 'http://p:3128', bypass: '.corp.test', junk: 1 })).toEqual({ mode: 'manual', url: 'http://p:3128', bypass: '.corp.test' });
    expect(() => cleanGateway({ mode: 'manual', url: 'nope://' })).toThrow();
    expect(() => cleanGateway({ clientCerts: [{ host: 'a', certFile: 'x' }] })).toThrow(/key file/);
    expect(describeGateway({ mode: 'manual', url: 'http://p:3128', username: 'ann' }, { password: false })).toContain('password not set');
  });

  it('never sends loopback through the gateway and honours the bypass list and <local>', () => {
    const gw = resolveGateway({ mode: 'manual', url: 'http://p:3128', bypass: '.internal.test, <local>' }, { secret: () => undefined });
    expect(gw.proxyFor(new URL('http://api.example.com/'))).toMatchObject({ host: 'p', port: 3128 });
    expect(gw.proxyFor(new URL('http://127.0.0.1:9/'))).toBeUndefined();
    expect(gw.proxyFor(new URL('http://localhost/'))).toBeUndefined();
    expect(gw.proxyFor(new URL('https://db.internal.test/'))).toBeUndefined();
    expect(gw.proxyFor(new URL('http://intranet/'))).toBeUndefined();
  });

  it('follows the app network settings in system mode', () => {
    const gw = resolveGateway({ mode: 'system' }, { secret: () => undefined, systemProxyFor: (u) => (u.includes('skip') ? undefined : 'http://ann:pw@sys.corp:8080') });
    expect(gw.proxyFor(new URL('http://a.example/'))).toMatchObject({ host: 'sys.corp', port: 8080 });
    expect(gw.proxyFor(new URL('http://a.example/'))!.auth).toBe(`Basic ${Buffer.from('ann:pw').toString('base64')}`);
    expect(gw.proxyFor(new URL('http://skip.example/'))).toBeUndefined();
  });

  it('says which file is wrong', () => {
    expect(() => resolveGateway({ mode: 'none', caFiles: [join(dir, 'missing.pem')] }, { secret: () => undefined })).toThrow(/Cannot read the certificate file/);
  });
});

describe('through the gateway', () => {
  it('sends plain HTTP to the gateway in the absolute form, with the proxy credentials from the secret store', async () => {
    config = { mode: 'manual', url: `http://127.0.0.1:${gatewayPort}`, username: 'ann' };
    secrets = { 'debugger.gateway.password': 's3cret' };
    requireAuth = true;
    seen.length = 0;
    const r = await viaProxy('http://api.corp.test/orders?x=1');
    expect(r).toEqual({ status: 200, text: 'origin /orders?x=1' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: 'http://api.corp.test/orders?x=1', auth: `Basic ${Buffer.from('ann:s3cret').toString('base64')}` });
    await settle();
    const e = proxy.exchanges.find((x) => x.url.endsWith('/orders?x=1'))!;
    expect(e.status).toBe(200);
    expect(e.responseBody).toBe('origin /orders?x=1');
    // the program's own Proxy-Authorization is not the gateway's
    expect(e.requestHeaders['proxy-authorization']).toBeUndefined();
  });

  it('fails plainly when the gateway wants credentials we do not have', async () => {
    secrets = {};
    config = { mode: 'manual', url: `http://127.0.0.1:${gatewayPort}` };
    const r = await viaProxy('http://api.corp.test/denied');
    expect(r.status).toBe(407);
  });

  it('connects directly to a host on the bypass list', async () => {
    requireAuth = false;
    config = { mode: 'manual', url: `http://127.0.0.1:${gatewayPort}` };
    seen.length = 0;
    expect((await viaProxy('http://api.corp.test/a')).status).toBe(200);
    expect(seen).toHaveLength(1);
    config = { mode: 'manual', url: `http://127.0.0.1:${gatewayPort}`, bypass: '.corp.test' };
    seen.length = 0;
    const direct = await viaProxy('http://api.corp.test/b'); // the name does not resolve: it really went direct
    expect(direct.status).toBeGreaterThanOrEqual(500);
    expect(seen).toHaveLength(0);
  });

  it('tunnels HTTPS through the gateway with CONNECT, trusts the extra authority and presents the client certificate', async () => {
    const caFile = join(dir, 'corp-ca.pem');
    writeFileSync(caFile, originRoot.certPem);
    const clientRoot = ensureRootCertificate(join(dir, 'client'));
    const clientLeaf = leafSigner(clientRoot)('mtls-client');
    const certFile = join(dir, 'client.pem');
    const keyFile = join(dir, 'client.key');
    writeFileSync(certFile, clientLeaf.cert);
    writeFileSync(keyFile, clientLeaf.key);
    config = { mode: 'manual', url: `http://127.0.0.1:${gatewayPort}`, caFiles: [caFile], clientCerts: [{ id: 'c1', host: '*.corp.test', certFile, keyFile }] };
    seen.length = 0;
    clientCertSeen = undefined;
    const r = await secureViaProxy('secure.corp.test');
    expect(r).toEqual({ status: 200, text: 'secure ok' });
    expect(seen.some((s) => s.method === 'CONNECT' && s.url === 'secure.corp.test:443')).toBe(true);
    expect(clientCertSeen).toBeTruthy();
    await settle();
    const e = proxy.exchanges.find((x) => x.url === 'https://secure.corp.test/')!;
    expect(e).toMatchObject({ status: 200, tls: true });
  });

  it('refuses a server whose authority is not trusted', async () => {
    config = { mode: 'manual', url: `http://127.0.0.1:${gatewayPort}` };
    const r = await secureViaProxy('secure.corp.test');
    expect(r.status).toBeGreaterThanOrEqual(500);
  });

  it('opens an undecrypted tunnel through the gateway too, and does not count the gateway answer as the server data', async () => {
    const via = await startDebuggerProxy({ gateway: () => resolveGateway({ mode: 'manual', url: `http://127.0.0.1:${gatewayPort}` }, { secret: () => undefined }) });
    const direct = await startDebuggerProxy({});
    const tunnelTo = (p: DebuggerProxy, target: string, name: string) =>
      new Promise<string>((resolve, reject) => {
        const c = request({ host: '127.0.0.1', port: p.port, method: 'CONNECT', path: target });
        c.on('connect', (_r, socket) => {
          const tls = tlsConnect({ socket, servername: name, ca: originRoot.certPem });
          tls.write(`GET / HTTP/1.1\r\nhost: ${name}\r\n\r\n`);
          let out = '';
          tls.on('data', (d) => (out += d));
          tls.on('end', () => resolve(out));
          tls.on('error', reject);
        });
        c.on('error', reject);
        c.end();
      });
    seen.length = 0;
    expect(await tunnelTo(via, 'secure.corp.test:443', 'secure.corp.test')).toContain('secure ok');
    expect(seen.some((s) => s.method === 'CONNECT')).toBe(true);
    // the same server directly (its certificate is for secure.corp.test: the name is the tunnel's, the address ours)
    expect(await tunnelTo(direct, `127.0.0.1:${securePort}`, 'secure.corp.test')).toContain('secure ok');
    await settle();
    const a = via.exchanges.find((x) => x.kind === 'tunnel')!;
    const b = direct.exchanges.find((x) => x.kind === 'tunnel')!;
    expect(a.status).toBe(200);
    expect(a.responseBodyBytes).toBeGreaterThan(100);
    expect(Math.abs(a.responseBodyBytes - b.responseBodyBytes)).toBeLessThan(30); // the gateway's 39-byte answer is not counted
    await via.close();
    await direct.close();
  });
});
