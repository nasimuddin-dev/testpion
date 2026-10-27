import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { NetConfig, currentNet, executeHttp, netFetch, withNet } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// Cloud stage 1, step 2: the proxy, the trusted certificates and the connection pools belong to a session (NetConfig), not to the
// process. Two sessions in one process, each with its own proxy and CA, send at the same time and never meet.
const tmp = tempDir('tp-netcfg-');
const pem = (f: string) => readFileSync(join('tests/fixtures/tls', f), 'utf8');
const listen = <T extends HttpServer | HttpsServer>(s: T) => new Promise<T>((r) => s.listen(0, '127.0.0.1', () => r(s)));
const port = (s: HttpServer | HttpsServer) => (s.address() as AddressInfo).port;
const sendOf = (be: Backend, id: string, url: string) => be.invoke('http.send', { id, request: { method: 'GET', url, headers: [] } }) as Promise<{ response?: { body?: unknown; bodyPreview?: string }; error?: unknown }>;
const text = (r: unknown) => JSON.stringify(r);

describe('NetConfig per session', () => {
  const seen: Record<string, string[]> = { A: [], B: [] };
  let proxyA: HttpServer;
  let proxyB: HttpServer;
  let secure: HttpsServer;
  let a: Backend;
  let b: Backend;

  beforeAll(async () => {
    // two forward proxies: they answer every request with their own name and note what they were asked for
    const proxy = (name: 'A' | 'B') =>
      createHttp((req, res) => {
        seen[name]!.push(req.url ?? '');
        res.setHeader('content-type', 'text/plain');
        res.end(`proxy ${name}`);
      });
    proxyA = await listen(proxy('A'));
    proxyB = await listen(proxy('B'));
    secure = await listen(createHttps({ cert: pem('server.crt'), key: pem('server.key') }, (_req, res) => res.end('secure hello')));
    a = new Backend({ appDir: join(tmp.dir, 'a'), emit: () => {}, noMonitors: true, serverMode: true });
    b = new Backend({ appDir: join(tmp.dir, 'b'), emit: () => {}, noMonitors: true, serverMode: true });
    a.net.setProxy({ mode: 'custom', url: `http://127.0.0.1:${port(proxyA)}` });
    b.net.setProxy({ mode: 'custom', url: `http://127.0.0.1:${port(proxyB)}` });
  });
  afterAll(async () => {
    await a.dispose();
    await b.dispose();
    for (const s of [proxyA, proxyB, secure]) await new Promise((r) => s.close(r));
    tmp.cleanup();
  });

  it('each session sends through its own proxy, 30 concurrent sends interleaved', async () => {
    const jobs = Array.from({ length: 30 }, (_, i) => (i % 2 ? sendOf(b, `b${i}`, `http://upstream.test/b${i}`) : sendOf(a, `a${i}`, `http://upstream.test/a${i}`)));
    const results = await Promise.all(jobs);
    results.forEach((r, i) => expect(text(r), `send ${i}`).toContain(i % 2 ? 'proxy B' : 'proxy A'));
    expect(seen.A!.length).toBe(15);
    expect(seen.B!.length).toBe(15);
    expect(seen.A!.every((u) => /\/a\d+$/.test(u))).toBe(true);
    expect(seen.B!.every((u) => /\/b\d+$/.test(u))).toBe(true);
  });

  it('a session proxy does not change the other session or the process default', () => {
    expect(a.net.settings.url).toContain(String(port(proxyA)));
    expect(b.net.settings.url).toContain(String(port(proxyB)));
    expect(currentNet().settings.mode).toBe('env'); // outside any call: the process default, untouched
    expect(a.net.id).not.toBe(b.net.id);
  });

  it('a private CA added in one session is trusted there and nowhere else (requests and fetch)', async () => {
    const url = `https://127.0.0.1:${port(secure)}/`;
    const direct = { mode: 'off' as const };
    a.net.setProxy(direct);
    b.net.setProxy(direct);
    a.net.setTrust({ extraCa: pem('ca.crt') });
    const ok = await withNet(a.net, () => executeHttp({ method: 'GET', url }));
    expect(ok.response.status).toBe(200);
    expect(await withNet(a.net, async () => (await netFetch(url)).text())).toBe('secure hello');
    // the other session never added it
    expect(String(await withNet(b.net, () => executeHttp({ method: 'GET', url }).then((r) => r.response.status, (e: Error) => e.message)))).not.toBe('200');
    await expect(withNet(b.net, () => netFetch(url))).rejects.toThrow();
    // both at the same time
    const [x, y] = await Promise.all([withNet(a.net, () => executeHttp({ method: 'GET', url }).then((r) => r.response.status)), withNet(b.net, () => executeHttp({ method: 'GET', url }).then((r) => r.response.status, () => 'refused'))]);
    expect([x, y]).toEqual([200, 'refused']);
  });

  it('connection pools are named by configuration: changing one session settings drops only its pool', () => {
    const before = [a.net.generation, b.net.generation];
    a.net.setTrust({});
    expect(a.net.generation).toBeGreaterThan(before[0]!);
    expect(b.net.generation).toBe(before[1]);
    expect(a.net.baseDispatcher()).not.toBe(b.net.baseDispatcher());
  });

  it('the services of an engine context carry the session configuration', () => {
    const ctx = a.context({});
    expect(ctx.services.net).toBe(a.net);
    void ctx.dispose();
    expect(new NetConfig().settings.mode).toBe('env');
  });
});
