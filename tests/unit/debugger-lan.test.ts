import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isLocalOnlyAddress, startDebuggerProxy, type DebuggerProxy } from '@testpion/core';

// the LAN mode of the Debugger: a device that is not this computer must be paired, and cannot reach this computer through the proxy
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

describe('isLocalOnlyAddress', () => {
  it('loopback, unspecified and link-local addresses (and their IPv6 costumes) only', () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '0.0.0.0', '169.254.169.254', '::1', '::', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1']) expect(isLocalOnlyAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '192.168.1.5', '10.0.0.7', '172.16.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isLocalOnlyAddress(ip), ip).toBe(false);
  });
});

describe.skipIf(!lanIp)('debugger proxy on the LAN', () => {
  let api: Server;
  let apiPort = 0;
  let proxy: DebuggerProxy;
  let hits = 0;
  beforeAll(async () => {
    api = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('local service');
    });
    await new Promise<void>((r) => api.listen(0, '0.0.0.0', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({ lan: true, applicationOf: async () => 'vitest' });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => api.close(() => r()));
  });

  // connecting to this computer's LAN address makes the client a non-loopback address, as a phone is
  const asDevice = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: lanIp, port: proxy.port, method: 'GET', path, headers: { host: new URL(path.startsWith('http') ? path : 'http://x/').host, ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      req.end();
    });

  it('has a pairing secret; an unpaired device gets 407 and nothing is forwarded', async () => {
    expect(proxy.pairingSecret).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const r = await asDevice(`http://${lanIp}:${apiPort}/x`);
    expect(r.status).toBe(407);
    expect(hits).toBe(0);
  });

  it('a device with the pairing secret as the proxy password is let in, but not to this computer’s loopback or link-local addresses', async () => {
    const auth = { 'proxy-authorization': `Basic ${Buffer.from(`phone:${proxy.pairingSecret}`).toString('base64')}` };
    const wrong = await asDevice(`http://${lanIp}:${apiPort}/x`, { 'proxy-authorization': `Basic ${Buffer.from('phone:nope').toString('base64')}` });
    expect(wrong.status).toBe(407);
    const ok = await asDevice(`http://${lanIp}:${apiPort}/x`, auth);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('local service');
    const before = hits;
    expect((await asDevice(`http://127.0.0.1:${apiPort}/x`, auth)).status).toBe(403);
    expect((await asDevice(`http://localhost:${apiPort}/x`, auth)).status).toBe(403);
    expect((await asDevice(`http://169.254.169.254/latest/meta-data`, auth)).status).toBe(403);
    expect(hits).toBe(before);
  });

  it('opening the page with the secret pairs the address; a CONNECT from an unpaired device is refused', async () => {
    const connectLine = (headers = '') =>
      new Promise<string>((resolve) => {
        const s = connect(proxy.port, lanIp!, () => s.write(`CONNECT ${lanIp}:${apiPort} HTTP/1.1\r\nHost: ${lanIp}:${apiPort}\r\n${headers}\r\n`));
        s.once('data', (d) => {
          resolve(d.toString().split('\r\n')[0]!);
          s.destroy();
        });
        s.on('error', () => resolve('error'));
      });
    expect(await connectLine()).toMatch(/^HTTP\/1\.1 407/);
    const bad = await asDevice('/?pair=not-the-secret');
    expect(bad.status).toBe(200); // the page itself is public (the root certificate download), but it pairs nobody
    expect(await connectLine()).toMatch(/^HTTP\/1\.1 407/);
    const page = await asDevice(`/?pair=${encodeURIComponent(proxy.pairingSecret!)}`);
    expect(page.status).toBe(200);
    // paired by its address now: no password needed any more
    expect((await asDevice(`http://${lanIp}:${apiPort}/x`)).status).toBe(200);
    expect(await connectLine()).toMatch(/^HTTP\/1\.1 200/);
  });

  it('a proxy that is not on the LAN has no secret and asks nobody', async () => {
    const local = await startDebuggerProxy({ applicationOf: async () => 'vitest' });
    try {
      expect(local.pairingSecret).toBeUndefined();
    } finally {
      await local.close();
    }
  });
});
