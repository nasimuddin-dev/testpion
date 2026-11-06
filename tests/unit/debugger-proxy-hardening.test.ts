import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRules, rulePresets, startDebuggerProxy, withAutoBreakpoint, type DebuggerProxy, type DebuggerRule } from '@testpion/core';
import { createUpstream } from '../../packages/core/src/debugger/upstream-route.js';
import { relayWriter, safeDecode } from '../../packages/core/src/debugger/http-util.js';
import { localReply } from '../../packages/core/src/debugger/shaping.js';
import { checkedRulesFile, rulesOf } from '../../apps/desktop/backend/handlers/debugger-rules.js';
import { newDebuggerState } from '../../apps/desktop/backend/handlers/debugger-state.js';

// The review fixes of the Debugger's proxy: the loopback guard inside a tunnel, backpressure, errors that are answered, and the rules file checked on load.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

const listen = (server: Server, host: string) => new Promise<number>((r) => server.listen(0, host, () => r((server.address() as { port: number }).port)));
const closed = (server: Server) => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));

describe('upstream options for a device on the network', () => {
  const up = createUpstream({ trustedCa: () => undefined, insecure: () => false, gateway: () => undefined });
  afterAll(() => up.destroy());

  it('an address of this computer written out is refused without a gateway too: request options, HTTP/2 and tunnels', async () => {
    for (const host of ['127.0.0.1', '127.8.8.8', '[::1]', '169.254.169.254', '[::ffff:127.0.0.1]', 'localhost', 'app.localhost']) {
      expect(() => up.options(new URL(`http://${host}:8080/x`), {}, true), host).toThrow(/is this computer/);
      expect(() => up.options(new URL(`https://${host}/x`), {}, true), host).toThrow(/is this computer/);
      expect(() => up.h2(new URL(`http://${host}:8080/x`), true), host).toThrow(/is this computer/);
    }
    const refused = up.connect({ host: '127.0.0.1', port: 9 }, true, () => undefined);
    const err = await new Promise<Error>((r) => refused.once('error', r));
    expect(err.message).toMatch(/is this computer/);
    expect(err.name).toBe('AuthorizationError');
  });

  it('other hosts, and this computer’s own clients, are not refused', () => {
    for (const host of ['example.com', '192.168.1.20', '10.0.0.7', '[2606:4700::1111]']) {
      expect(() => up.options(new URL(`http://${host}/x`), {}, true), host).not.toThrow();
      expect(() => up.h2(new URL(`https://${host}/x`), true), host).not.toThrow();
    }
    expect(() => up.options(new URL('http://127.0.0.1:8080/x'), {}, false)).not.toThrow();
    expect(() => up.h2(new URL('http://[::1]:8080/x'), false)).not.toThrow();
    // a name is checked when it is resolved: the options carry the guarded lookup
    expect(up.options(new URL('http://example.com/x'), {}, true).lookup).toBeTypeOf('function');
  });

  it('a name that is not an address is not taken for this computer when a gateway is set', () => {
    const gw = createUpstream({
      trustedCa: () => undefined,
      insecure: () => false,
      gateway: () => ({ config: { mode: 'manual' }, extraCa: [], proxyFor: () => ({ host: '10.0.0.1', port: 3128, label: 'gw' }), clientCertFor: () => undefined }),
    });
    try {
      expect(() => gw.options(new URL('http://example.com/x'), {}, true)).not.toThrow();
      expect(() => gw.options(new URL('http://127.0.0.1/x'), {}, true)).toThrow(/is this computer/);
    } finally {
      gw.destroy();
    }
  });
});

describe.skipIf(!lanIp)('a device on the network inside a tunnel', () => {
  let lanApi: Server;
  let loopApi: Server;
  let lanPort = 0;
  let loopPort = 0;
  let proxy: DebuggerProxy;
  const lanPaths: string[] = [];
  let loopHits = 0;
  beforeAll(async () => {
    lanApi = createServer((req, res) => {
      lanPaths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }).end('lan service');
    });
    loopApi = createServer((_req, res) => {
      loopHits++;
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }).end('loopback secret');
    });
    lanPort = await listen(lanApi, '0.0.0.0');
    loopPort = await listen(loopApi, '127.0.0.1');
    proxy = await startDebuggerProxy({ lan: true, applicationOf: async () => 'vitest' });
  });
  afterAll(async () => {
    await proxy.close();
    await closed(lanApi);
    await closed(loopApi);
  });

  /** Open a tunnel to the LAN service as a paired device, then send one raw request line inside it; the whole answer. */
  const insideTunnel = (requestLine: string, host: string) =>
    new Promise<string>((resolve, reject) => {
      const auth = `Basic ${Buffer.from(`phone:${proxy.pairingSecret}`).toString('base64')}`;
      const s: Socket = connect(proxy.port, lanIp!, () => s.write(`CONNECT ${lanIp}:${lanPort} HTTP/1.1\r\nHost: ${lanIp}:${lanPort}\r\nProxy-Authorization: ${auth}\r\n\r\n`));
      let text = '';
      let sent = false;
      s.on('data', (d) => {
        text += d.toString('latin1');
        if (!sent && text.includes('\r\n\r\n')) {
          sent = true;
          expect(text).toMatch(/^HTTP\/1\.1 200/);
          text = '';
          s.write(`${requestLine}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        }
      });
      s.on('close', () => resolve(text));
      s.on('error', reject);
      setTimeout(() => s.destroy(), 8000).unref();
    });

  it('an absolute URL in the request line does not leave the tunnel’s host: the loopback service is never reached', async () => {
    const answer = await insideTunnel(`GET http://127.0.0.1:${loopPort}/secret?a=1 HTTP/1.1`, `127.0.0.1:${loopPort}`);
    expect(loopHits).toBe(0);
    expect(answer).not.toContain('loopback secret');
    // only the path and the query are used, against the host the tunnel was opened for
    expect(answer).toContain('lan service');
    expect(lanPaths).toContain('/secret?a=1');
    const listed = proxy.exchanges.find((e) => e.url.includes('/secret'));
    expect(listed?.url).toBe(`http://${lanIp}:${lanPort}/secret?a=1`);
  });

  it('a path that starts with two slashes stays a path', async () => {
    const answer = await insideTunnel(`GET //127.0.0.1:${loopPort}/twice HTTP/1.1`, `${lanIp}:${lanPort}`);
    expect(loopHits).toBe(0);
    expect(answer).toContain('lan service');
    expect(lanPaths).toContain(`//127.0.0.1:${loopPort}/twice`);
  });
});

describe('backpressure', () => {
  it('relayWriter pauses the source while the destination is full, and lets it go on drain or close', () => {
    const calls: string[] = [];
    const listeners: Record<string, () => void> = {};
    let full = false;
    const from = { pause: () => calls.push('pause'), resume: () => calls.push('resume') };
    const to = { write: (c: Buffer) => (calls.push(`write ${c.length}`), !full), on: (ev: string, fn: () => void) => void (listeners[ev] = fn) };
    const waits: boolean[] = [];
    const write = relayWriter(from, to, (w) => waits.push(w));
    write(Buffer.alloc(3));
    expect(calls).toEqual(['write 3']);
    full = true;
    write(Buffer.alloc(4));
    write(Buffer.alloc(5)); // a chunk that was already on its way: written, the source is paused once
    expect(calls).toEqual(['write 3', 'write 4', 'pause', 'write 5']);
    listeners.drain!();
    listeners.drain!();
    expect(calls.slice(4)).toEqual(['resume']);
    expect(waits).toEqual([true, false]);
    write(Buffer.alloc(1));
    listeners.close!();
    expect(calls.slice(5)).toEqual(['write 1', 'pause', 'resume']);
    // a closed destination takes nothing: the source is not paused for it again
    write(Buffer.alloc(1));
    expect(calls.slice(8)).toEqual(['write 1']);
  });

  /** A server that answers with `total` bytes, as fast as they are taken. */
  const bigApi = (total: number) =>
    createServer((_req, res) => {
      const chunk = Buffer.alloc(256 * 1024, 7);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) });
      let sent = 0;
      const more = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', more);
        }
        res.end();
      };
      more();
    });
  const download = (proxyPort: number, apiPort: number) => {
    const client = connect(proxyPort, '127.0.0.1', () => client.write(`GET http://127.0.0.1:${apiPort}/big HTTP/1.1\r\nHost: 127.0.0.1:${apiPort}\r\nConnection: close\r\n\r\n`));
    const state = { got: 0, client, done: new Promise<void>((r) => client.once('close', () => r())) };
    client.on('data', (c) => (state.got += c.length));
    client.on('error', () => undefined);
    return state;
  };

  it('a large download under a slow Network speed is taken from the server as it is passed on, not queued whole in the proxy', async () => {
    const TOTAL = 48 * 1024 * 1024;
    const api = bigApi(TOTAL);
    const apiPort = await listen(api, '127.0.0.1');
    // 8 Mbit/s: one megabyte a second goes to the program
    const proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', speed: () => ({ preset: 'custom', downKbps: 8000, upKbps: 8000, latencyMs: 0 }) });
    try {
      const d = download(proxy.port, apiPort);
      await new Promise((r) => setTimeout(r, 1500));
      // without backpressure the proxy had read all 48 MB from the server by now and held them for the pacer
      const read = proxy.exchanges[0]!.responseBodyBytes;
      expect(read).toBeGreaterThan(0);
      expect(read).toBeLessThan(8 * 1024 * 1024);
      expect(d.got).toBeGreaterThan(0);
      expect(d.got).toBeLessThan(4 * 1024 * 1024);
      d.client.destroy();
      await d.done;
    } finally {
      await proxy.close();
      await closed(api);
    }
  });

  it('a paced download arrives whole, with the same count and the same end of the exchange', async () => {
    const TOTAL = 6 * 1024 * 1024;
    const api = bigApi(TOTAL);
    const apiPort = await listen(api, '127.0.0.1');
    const proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', speed: () => ({ preset: 'custom', downKbps: 64_000, upKbps: 64_000, latencyMs: 0 }) });
    const plain = await startDebuggerProxy({ applicationOf: async () => 'vitest' });
    try {
      for (const p of [proxy, plain]) {
        const d = download(p.port, apiPort);
        await d.done;
        expect(d.got).toBeGreaterThan(TOTAL);
        expect(d.got).toBeLessThan(TOTAL + 4096);
        const e = p.exchanges[0]!;
        expect(e.responseBodyBytes).toBe(TOTAL);
        expect(e.responseBodyTruncated).toBe(true);
        expect(e.status).toBe(200);
        expect(e.durationMs).toBeTypeOf('number');
        expect(e.error).toBeUndefined();
      }
    } finally {
      await proxy.close();
      await plain.close();
      await closed(api);
    }
  });
});

describe('values the other side controls', () => {
  it('safeDecode: text that is not valid percent-encoding stays as it came', () => {
    expect(safeDecode('caf%C3%A9%20ok')).toBe('café ok');
    expect(safeDecode('bad %zz value')).toBe('bad %zz value');
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('map local: a path that is not valid percent-encoding is answered (404), not thrown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-local-'));
    try {
      mkdirSync(join(root, 'site'));
      writeFileSync(join(root, 'site', 'a b.txt'), 'hello');
      expect((await localReply(root, { status: 200, folder: 'site' }, new URL('http://x/a%20b.txt'))).body.toString()).toBe('hello');
      const bad = await localReply(root, { status: 200, folder: 'site' }, new URL('http://x/%zz'));
      expect(bad.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an error on the way to the server is answered with 502 and kept on the exchange; the program does not wait forever', async () => {
    const gateway = { config: { mode: 'manual' as const }, extraCa: [], clientCertFor: () => undefined, proxyFor: () => { throw new Error('the gateway settings are broken'); } }; // prettier-ignore
    const proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', gateway: () => gateway });
    try {
      const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: 'http://127.0.0.1:9/x', headers: { host: '127.0.0.1:9' }, timeout: 8000 }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on('timeout', () => req.destroy(new Error('the proxy did not answer')));
        req.on('error', reject);
        req.end();
      });
      expect(answer.status).toBe(502);
      expect(answer.text).toContain('the gateway settings are broken');
      expect(proxy.exchanges).toHaveLength(1);
      expect(proxy.exchanges[0]!.error).toBe('the gateway settings are broken');
      expect(proxy.exchanges[0]!.durationMs).toBeTypeOf('number');
    } finally {
      await proxy.close();
    }
  });

  it('a WebSocket upgrade that fails before the server is asked gets an answer too', async () => {
    const gateway = { config: { mode: 'manual' as const }, extraCa: [], clientCertFor: () => undefined, proxyFor: () => { throw new Error('the gateway settings are broken'); } }; // prettier-ignore
    const proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', gateway: () => gateway });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        const s = connect(proxy.port, '127.0.0.1', () =>
          s.write(
            'GET http://127.0.0.1:9/ws HTTP/1.1\r\nHost: 127.0.0.1:9\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          ),
        );
        s.once('data', (d) => resolve(d.toString().split('\r\n')[0]!));
        s.on('error', reject);
        setTimeout(() => (s.destroy(), reject(new Error('the proxy did not answer'))), 8000).unref();
      });
      expect(first).toBe('HTTP/1.1 502 Bad Gateway');
      expect(proxy.exchanges[0]!.error).toBe('the gateway settings are broken');
    } finally {
      await proxy.close();
    }
  });
});

describe('debugger/rules.json checked on load', () => {
  const good: DebuggerRule = { id: 'r1', name: 'Staging', enabled: true, kind: 'highlight', match: { host: '*.staging.test' }, color: 'blue' };

  it('a profile that is not a list and rules that fail the rule check are left out, with a warning each', () => {
    const warnings: string[] = [];
    const file = checkedRulesFile(
      {
        active: 'Team',
        profiles: {
          Team: [
            good,
            { id: 'r2', name: 'No kind', enabled: true, match: {} },
            { id: 'r3', name: 'Host is a number', enabled: true, kind: 'ignore', match: { host: 42 } },
            { id: 'r4', name: 'Remap to nowhere', enabled: true, kind: 'remap', match: { host: 'a.test' } },
            { id: 'r5', name: 'No match', enabled: true, kind: 'highlight' },
            'not a rule',
            null,
            { id: 'r6', name: 'Bad pattern', enabled: true, kind: 'highlight', match: { where: { column: 'url', op: 'matches', value: '(' } } },
            { id: 'r7', name: 'Headers are text', enabled: true, kind: 'modify', match: {}, requestHeaders: 'X-A: 1' },
          ],
          Broken: { not: 'a list' },
          Empty: [],
        },
        filterPresets: [{ name: 'Errors', filter: { status: 'error' } }, 'nope'],
      },
      (m) => warnings.push(m),
    );
    expect(file?.active).toBe('Team');
    expect(Object.keys(file!.profiles)).toEqual(['Team', 'Empty']);
    expect(file!.profiles.Team).toEqual([good]);
    expect(file!.filterPresets).toEqual([{ name: 'Errors', filter: { status: 'error' } }]);
    expect(warnings).toHaveLength(10);
    expect(warnings.join('\n')).toMatch(/rule 2 of the profile "Team" is left out: Unknown rule kind/);
    expect(warnings.join('\n')).toMatch(/the profile "Broken" is not a list of rules/);
  });

  it('the rules the app writes itself pass unchanged', () => {
    const own = [...withAutoBreakpoint(defaultRules(), 'errors'), ...rulePresets('api.test').map((p, i) => ({ ...p.rule, id: `preset-${i}` }) as DebuggerRule)];
    const warnings: string[] = [];
    const file = checkedRulesFile({ active: 'Default', profiles: { Default: own } }, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(file!.profiles.Default).toEqual(own);
  });

  it('not a rules file at all: nothing; the active profile falls back to the first one', () => {
    for (const raw of [null, 7, 'text', [], { profiles: [] }, { profiles: 'x' }, { profiles: {} }, { profiles: { A: 'x' } }])
      expect(
        checkedRulesFile(raw, () => undefined),
        JSON.stringify(raw),
      ).toBeUndefined();
    expect(checkedRulesFile({ active: 'constructor', profiles: { A: [good] } }, () => undefined)?.active).toBe('A');
  });

  it('rulesOf reads a damaged file without throwing: the proxy gets the rules that are whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-rules-'));
    try {
      mkdirSync(join(root, 'debugger'));
      writeFileSync(join(root, 'debugger', 'rules.json'), JSON.stringify({ active: 'Default', profiles: { Default: [good, { kind: 'reply', match: 'everything' }], Other: 5 } }));
      const warnings: string[] = [];
      const be = { ws: { path: (rel: string) => join(root, rel) }, logger: { warn: (m: string) => warnings.push(m) } };
      const file = rulesOf(be as never, newDebuggerState());
      expect(file.profiles).toEqual({ Default: [good] });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/^debugger\/rules\.json: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
