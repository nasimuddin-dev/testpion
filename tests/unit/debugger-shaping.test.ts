import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { debuggerTools } from '../../packages/core/src/mcp-server/tools/debugger-tools';
import { Redactor } from '../../packages/core/src/util/redact';
import { WebSocketServer } from 'ws';
import {
  Pacer,
  NETWORK_SPEEDS,
  createFrameRelay,
  decideRequest,
  describeRule,
  encodeFrame,
  frameDecider,
  isInsidePath,
  localReply,
  parseHostsFile,
  parseNetworkSpeed,
  redirectTarget,
  replaceText,
  resolveInWorkspace,
  rewriteBody,
  rewritePath,
  rulePresets,
  startDebuggerProxy,
  webSocketFrameParser,
  type BreakpointEdits,
  type DebuggerExchange,
  type DebuggerProxy,
  type DebuggerRule,
  type NetworkSpeed,
} from '@testpion/core';

// FG-1, FG-4, FG-6, FG-7, FG-26: network speed, host remap, map local and URL rewrite, rewrite and fault actions, WebSocket frame rules.
const ex = (over: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: 'x',
  startedAt: new Date().toISOString(),
  kind: 'http',
  method: 'GET',
  url: 'http://api.test:8080/items/42?x=1',
  host: 'api.test:8080',
  clientPort: 1,
  requestHeaders: {},
  requestBodyBytes: 0,
  responseBodyBytes: 0,
  ...over,
});

describe('network speed (FG-1)', () => {
  it('paces bytes to the bandwidth on a fake clock, within 10%', async () => {
    let t = 0;
    const out: Buffer[] = [];
    const p = new Pacer(80, { now: () => t, wait: async (ms) => void (t += ms) }); // 80 kbit/s = 10 000 bytes a second
    p.on('data', (c: Buffer) => out.push(c));
    for (let i = 0; i < 7; i++) p.write(Buffer.alloc(16_384, 1));
    await new Promise<void>((r) => p.end(() => r()));
    const bytes = out.reduce((n, c) => n + c.length, 0);
    expect(bytes).toBe(7 * 16_384);
    const expected = (bytes / 10_000) * 1000;
    expect(t).toBeGreaterThan(expected * 0.9);
    expect(t).toBeLessThan(expected * 1.1);
  });

  it('knows the presets and checks a custom speed', () => {
    expect(NETWORK_SPEEDS.map((s) => s.preset)).toEqual(['modem', 'edge', 'slow-3g', '3g', 'slow-4g']);
    expect(parseNetworkSpeed('3g')).toMatchObject({ preset: '3g', downKbps: 1600 });
    expect(parseNetworkSpeed('off')).toBeUndefined();
    expect(parseNetworkSpeed({ preset: 'custom', downKbps: 500, latencyMs: 80 })).toEqual({ preset: 'custom', downKbps: 500, upKbps: 500, latencyMs: 80 });
    expect(() => parseNetworkSpeed('dialup')).toThrow(/No network speed/);
    expect(() => parseNetworkSpeed({ preset: 'custom', downKbps: 0 })).toThrow(/download speed/);
  });
});

describe('host remap, redirect and path rewrite (FG-4, FG-6)', () => {
  it('moves the host and scheme, and uses the new scheme\'s own port when none is given', () => {
    const from = new URL('http://shop.test:8080/a/b?q=1');
    expect(redirectTarget(from, { host: 'localhost:3000' }).href).toBe('http://localhost:3000/a/b?q=1');
    expect(redirectTarget(from, { host: '10.0.0.5', scheme: 'https' }).href).toBe('https://10.0.0.5/a/b?q=1');
    expect(redirectTarget(from, { host: 'x.test:9', scheme: 'https' }).href).toBe('https://x.test:9/a/b?q=1');
  });

  it('rewrites the path with a glob, a regular expression, or plain text', () => {
    expect(rewritePath('/api/v1/users?x=1', { from: '/api/v1/*', to: '/v2/$1' })).toBe('/v2/users?x=1');
    expect(rewritePath('/items/42/detail', { from: '/items/(\\d+)/(\\w+)', to: '/$2/$1', regex: true })).toBe('/detail/42');
    expect(rewritePath('/old/path', { from: '/old', to: '/new' })).toBe('/new/path');
    expect(rewritePath('/untouched', { from: '/nothing', to: '/x' })).toBe('/untouched');
    expect(redirectTarget(new URL('http://a.test/api/x'), { rewrite: { from: '/api/*', to: '/$1' } }).href).toBe('http://a.test/x');
  });

  it('reads an OS hosts file: addresses and names, comments and localhost left out', () => {
    expect(parseHostsFile('# c\n127.0.0.1 localhost\n10.1.1.1 api.test shop.test # note\n::1 localhost ip6-localhost\n\nbad line\n')).toEqual([
      { address: '10.1.1.1', host: 'api.test' },
      { address: '10.1.1.1', host: 'shop.test' },
    ]);
  });

  it('turns a remap rule into a redirect that can keep the Host header', () => {
    const rules: DebuggerRule[] = [{ id: 'm', name: 'Map', enabled: true, kind: 'remap', match: { host: 'api.test' }, remap: { to: 'localhost:3000', scheme: 'http', preserveHost: true } }];
    const d = decideRequest(rules, ex());
    expect(d.redirect).toEqual({ host: 'localhost:3000', scheme: 'http', preserveHost: true });
    expect(describeRule(rules[0]!)).toBe('Reach api.test at localhost:3000 over http, keeping the Host header');
  });
});

describe('map local (FG-6)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-maplocal-'));
    mkdirSync(join(dir, 'mocks', 'orders'), { recursive: true });
    writeFileSync(join(dir, 'mocks', 'orders', '1.json'), '{"id":1}');
    writeFileSync(join(dir, 'mocks', 'index.html'), '<h1>home</h1>');
    writeFileSync(join(dir, 'outside.txt'), 'private');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses paths that leave the workspace', async () => {
    expect(isInsidePath('mocks/a.json')).toBe(true);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\host\\share', 'a\0b', '']) expect(isInsidePath(bad)).toBe(false);
    await expect(resolveInWorkspace(join(dir, 'mocks'), '../outside.txt')).rejects.toThrow(/outside the workspace/);
    await expect(resolveInWorkspace(dir, 'mocks/orders/1.json')).resolves.toContain('1.json');
  });

  it('answers from a file with the type of its extension, a 404 for a missing one', async () => {
    const r = await localReply(dir, { status: 200, file: 'mocks/orders/1.json' }, new URL('http://a.test/x'));
    expect(r).toMatchObject({ status: 200, headers: { 'content-type': 'application/json' } });
    expect(r.body.toString()).toBe('{"id":1}');
    expect((await localReply(dir, { status: 200, file: 'mocks/none.json' }, new URL('http://a.test/x'))).status).toBe(404);
    expect((await localReply(dir, { status: 200, file: '../outside.txt' }, new URL('http://a.test/x'))).status).toBe(403);
    expect((await localReply(undefined, { status: 200, file: 'a' }, new URL('http://a.test/x'))).status).toBe(502);
  });

  it('maps a folder to the request path, index.html for the root, and never leaves the folder', async () => {
    const reply = { status: 200, folder: 'mocks', stripPrefix: '/api' };
    expect((await localReply(dir, reply, new URL('http://a.test/api/orders/1.json'))).body.toString()).toBe('{"id":1}');
    expect((await localReply(dir, reply, new URL('http://a.test/api/'))).body.toString()).toBe('<h1>home</h1>');
    expect((await localReply(dir, reply, new URL('http://a.test/api/..%2f..%2foutside.txt'))).status).toBe(403);
    expect((await localReply(dir, reply, new URL('http://a.test/api/..%5c..%5coutside.txt'))).status).toBe(403);
  });

  it('puts the groups of the rule\'s URL regular expression into the file name', () => {
    const rules: DebuggerRule[] = [{ id: 'r', name: 'Item', enabled: true, kind: 'reply', match: { url: '/items\\/(\\d+)/' }, reply: { status: 200, file: 'mocks/item-$1.json' } }];
    expect(decideRequest(rules, ex()).reply?.file).toBe('mocks/item-42.json');
  });
});

describe('rewrite and fault actions (FG-7)', () => {
  it('replaces text, plain or by regular expression, and reads a gzip body', () => {
    expect(replaceText('a-b-a', [{ find: 'a', replace: 'x' }])).toBe('x-b-x');
    expect(replaceText('id=12 id=34', [{ find: 'id=(\\d+)', replace: 'id#$1', regex: true }])).toBe('id#12 id#34');
    expect(replaceText('Hello', [{ find: 'hello', replace: 'bye', ignoreCase: true }])).toBe('bye');
    expect(replaceText('price $5', [{ find: '$5', replace: '$6' }])).toBe('price $6'); // plain text: no group syntax
    const gz = gzipSync(Buffer.from('{"name":"alice"}'));
    expect(rewriteBody(gz, 'application/json', 'gzip', [{ find: 'alice', replace: 'bob' }])?.toString()).toBe('{"name":"bob"}');
    expect(rewriteBody(Buffer.from('abc'), 'image/png', undefined, [{ find: 'a', replace: 'b' }])).toBeUndefined();
    expect(rewriteBody(Buffer.from('abc'), 'text/plain', undefined, [{ find: 'z', replace: 'b' }])).toBeUndefined();
  });

  it('rolls the dice once per request for a share of failures; an error fault is a reply', () => {
    const rules: DebuggerRule[] = [{ id: 'f', name: 'Fail', enabled: true, kind: 'fault', match: {}, fault: { action: 'error', status: 502, percent: 20 } }];
    expect(decideRequest(rules, ex(), () => 0.1).reply?.status).toBe(502);
    expect(decideRequest(rules, ex(), () => 0.5).reply).toBeUndefined();
    const hang = decideRequest([{ id: 'h', name: 'Hang', enabled: true, kind: 'fault', match: {}, fault: { action: 'timeout' } }], ex());
    expect(hang.fault?.action).toBe('timeout');
    const cut = decideRequest([{ id: 'c', name: 'Cut', enabled: true, kind: 'fault', match: {}, fault: { action: 'truncate', bytes: 10 } }], ex());
    expect(cut.hold).toBe(true);
    expect(describeRule(rules[0]!)).toBe('For everything: answer 502 in 20% of requests');
  });

  it('has presets for each', () => {
    const ids = rulePresets().map((p) => p.id);
    for (const id of ['status-500', 'remap-local', 'fault-drop', 'fault-timeout', 'fault-20', 'fault-cut', 'ws-drop', 'ws-break']) expect(ids).toContain(id);
  });
});

describe('shaping in the proxy', () => {
  let api: Server;
  let apiPort = 0;
  let dir: string;
  let proxy: DebuggerProxy;
  let rules: DebuggerRule[] = [];
  let speed: NetworkSpeed | undefined;
  let dice = 0;
  const seen: Array<{ host?: string; url?: string; body: string }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tp-shape-'));
    mkdirSync(join(dir, 'mocks'));
    writeFileSync(join(dir, 'mocks', 'hello.json'), '{"from":"file"}');
    api = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ host: req.headers.host, url: req.url, body });
        if (req.url?.startsWith('/big')) return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(8000, 7));
        if (req.url?.startsWith('/gz')) return void res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync('{"user":"alice","token":"abc123"}'));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url, host: req.headers.host, got: body }));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', rules: () => rules, speed: () => speed, workspaceRoot: () => dir, random: () => dice });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => api.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const via = (method: string, url: string, body?: string, headers: Record<string, string> = {}, timeout?: number) =>
    new Promise<{ status?: number; text: string; headers: IncomingMessage['headers']; error?: string; complete?: boolean; ms: number }>((resolve) => {
      const t0 = Date.now();
      let text = '';
      const req = request({ host: '127.0.0.1', port: proxy.port, method, path: url, timeout, headers: { host: new URL(url).host, ...headers } }, (res) => {
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, complete: res.complete, ms: Date.now() - t0 }));
        res.on('aborted', () => resolve({ status: res.statusCode, text, headers: res.headers, error: 'aborted', complete: false, ms: Date.now() - t0 }));
        res.on('error', (e) => resolve({ status: res.statusCode, text, headers: res.headers, error: e.message, complete: false, ms: Date.now() - t0 }));
      });
      req.on('timeout', () => req.destroy(new Error('client timeout')));
      req.on('error', (e) => resolve({ text, headers: {}, error: e.message, ms: Date.now() - t0 }));
      req.end(body);
    });

  it('remap: the server sees the original Host header only when the rule keeps it', async () => {
    rules = [{ id: 'm', name: 'Map', enabled: true, kind: 'remap', match: { host: 'shop.test' }, remap: { to: `127.0.0.1:${apiPort}`, preserveHost: true } }];
    const kept = JSON.parse((await via('GET', 'http://shop.test/where')).text);
    expect(kept).toMatchObject({ path: '/where', host: 'shop.test' });
    rules = [{ ...rules[0]!, remap: { to: `127.0.0.1:${apiPort}` } }];
    const moved = JSON.parse((await via('GET', 'http://shop.test/where')).text);
    expect(moved.host).toBe(`127.0.0.1:${apiPort}`);
    await settle();
    expect(proxy.exchanges.find((x) => x.url === 'http://shop.test/where')?.redirectedTo).toBe(`http://127.0.0.1:${apiPort}/where`);
  });

  it('redirect with a path rewrite (Map Remote)', async () => {
    rules = [{ id: 'r', name: 'Rewrite', enabled: true, kind: 'redirect', match: { host: 'old.test' }, redirect: { host: `127.0.0.1:${apiPort}`, rewrite: { from: '/api/*', to: '/v2/$1' } } }];
    expect(JSON.parse((await via('GET', 'http://old.test/api/users?x=1')).text).path).toBe('/v2/users?x=1');
  });

  it('map local: a file of the workspace answers, the server never sees the request', async () => {
    seen.length = 0;
    rules = [{ id: 'l', name: 'Local', enabled: true, kind: 'reply', match: { url: '*/local*' }, reply: { status: 200, file: 'mocks/hello.json' } }];
    const r = await via('GET', 'http://nowhere.test/local');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.text)).toEqual({ from: 'file' });
    writeFileSync(join(dir, 'mocks', 'hello.json'), '{"from":"edited"}'); // read at request time: an edit shows at once
    expect(JSON.parse((await via('GET', 'http://nowhere.test/local')).text)).toEqual({ from: 'edited' });
    rules = [{ id: 'l2', name: 'Escape', enabled: true, kind: 'reply', match: { url: '*/escape*' }, reply: { status: 200, file: '../secret.txt' } }];
    expect((await via('GET', 'http://nowhere.test/escape')).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('modify: regex replace in a gzip response body, a status rewrite, request body replace', async () => {
    rules = [{ id: 'm', name: 'Mask', enabled: true, kind: 'modify', match: { url: '*/gz*' }, responseReplace: [{ find: '"token":"\\w+"', replace: '"token":"***"', regex: true }], setStatus: 201 }];
    const r = await via('GET', `http://127.0.0.1:${apiPort}/gz`);
    expect(r.status).toBe(201);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.text)).toEqual({ user: 'alice', token: '***' });
    // untouched responses keep their encoding
    rules = [{ id: 'h', name: 'Header', enabled: true, kind: 'modify', match: { url: '*/gz*' }, responseHeaders: [{ op: 'set', name: 'x-rule', value: '1' }] }];
    const kept = await via('GET', `http://127.0.0.1:${apiPort}/gz`);
    expect(kept.headers['content-encoding']).toBe('gzip');
    rules = [{ id: 'q', name: 'Req', enabled: true, kind: 'modify', match: { url: '*/echo*' }, requestReplace: [{ find: 'draft', replace: 'final' }] }];
    const echoed = JSON.parse((await via('POST', `http://127.0.0.1:${apiPort}/echo`, '{"state":"draft"}', { 'content-type': 'application/json' })).text);
    expect(echoed.got).toBe('{"state":"final"}');
  });

  it('fault: drop cuts the connection, timeout never answers, a share fails with an error status', async () => {
    rules = [{ id: 'd', name: 'Drop', enabled: true, kind: 'fault', match: { url: '*/drop*' }, fault: { action: 'drop' } }];
    const dropped = await via('GET', `http://127.0.0.1:${apiPort}/drop`);
    expect(dropped.status).toBeUndefined();
    expect(dropped.error).toBeDefined();
    await settle();
    expect(proxy.exchanges.find((x) => x.url.endsWith('/drop'))?.error).toBe('Connection dropped by a rule');
    rules = [{ id: 't', name: 'Hang', enabled: true, kind: 'fault', match: { url: '*/hang*' }, fault: { action: 'timeout', timeoutMs: 5000 } }];
    const hung = await via('GET', `http://127.0.0.1:${apiPort}/hang`, undefined, {}, 250);
    expect(hung.error).toBe('client timeout');
    expect(hung.ms).toBeLessThan(2000);
    await settle();
    expect(proxy.exchanges.find((x) => x.url.endsWith('/hang'))?.error).toMatch(/No answer, by a rule/);
    rules = [{ id: 'p', name: 'Fail 30%', enabled: true, kind: 'fault', match: { url: '*/flaky*' }, fault: { action: 'error', status: 503, percent: 30 } }];
    dice = 0.1;
    expect((await via('GET', `http://127.0.0.1:${apiPort}/flaky`)).status).toBe(503);
    dice = 0.9;
    expect((await via('GET', `http://127.0.0.1:${apiPort}/flaky`)).status).toBe(200);
  });

  it('fault: truncate sends part of the body and cuts the connection', async () => {
    rules = [{ id: 'c', name: 'Cut', enabled: true, kind: 'fault', match: { url: '*/big*' }, fault: { action: 'truncate', bytes: 1000 } }];
    const r = await via('GET', `http://127.0.0.1:${apiPort}/big`);
    expect(r.complete).toBe(false);
    expect(r.text.length).toBeLessThan(8000);
    await settle();
    expect(proxy.exchanges.find((x) => x.url.endsWith('/big'))?.error).toMatch(/cut after 1000 of 8000 bytes/);
  });

  it('network speed: the response takes the time its size needs at the bandwidth, and the latency is added', async () => {
    rules = [];
    speed = { preset: 'custom', downKbps: 160, upKbps: 160, latencyMs: 150 }; // 20 000 bytes a second
    const slow = await via('GET', `http://127.0.0.1:${apiPort}/big`);
    expect(slow.text.length).toBe(8000);
    expect(slow.ms).toBeGreaterThan(400 * 0.8 + 150 * 0.8 - 50); // 8000 B at 20 kB/s is 400 ms, plus 150 ms of latency (the first piece is free)
    speed = undefined;
    const fast = await via('GET', `http://127.0.0.1:${apiPort}/big`);
    expect(fast.ms).toBeLessThan(slow.ms);
  });
});

describe('WebSocket frame rules (FG-26)', () => {
  it('encodes frames the way a program and a server write them', () => {
    const sent = encodeFrame(1, Buffer.from('hi'), true);
    expect(sent[1]! & 0x80).toBe(0x80); // masked
    const read: string[] = [];
    webSocketFrameParser('sent', (f) => read.push(f.text ?? '')).push(sent);
    expect(read).toEqual(['hi']);
    expect(encodeFrame(1, Buffer.alloc(300, 1), false).subarray(0, 4).toString('hex')).toBe('817e012c');
  });

  it('the decider drops, replaces, delays and pauses frames by direction and content', async () => {
    const pause = async (text: string) => (text.includes('edit') ? { text: 'edited' } : text.includes('kill') ? { drop: true } : undefined);
    const decide = frameDecider(
      [
        { direction: 'received', action: 'drop', when: 'noise' },
        { direction: 'received', action: 'replace', find: 'secret-(\\d+)', replace: 'hidden-$1', regex: true },
        { direction: 'sent', action: 'delay', delayMs: 5 },
        { action: 'break', when: '/^(edit|kill)/' },
      ],
      'received',
      pause,
    );
    expect(await decide('some noise')).toEqual({ drop: true });
    expect(await decide('has secret-7')).toEqual({ text: 'has hidden-7' });
    expect(await decide('edit me')).toEqual({ text: 'edited', held: true });
    expect(await decide('kill me')).toEqual({ drop: true, held: true });
    expect(await decide('plain')).toEqual({});
  });

  it('the relay forwards what the rules let through, in order, and lists dropped and edited frames', async () => {
    const wire: Buffer[] = [];
    const listed: Array<{ text?: string; ruled?: string }> = [];
    const decide = frameDecider([{ action: 'drop', when: 'drop' }, { action: 'replace', find: 'a', replace: 'b' }], 'received');
    const relay = createFrameRelay({ direction: 'received', decide, write: (b) => void wire.push(b), onFrame: (f) => listed.push({ text: f.text, ruled: f.ruled }) });
    const all = Buffer.concat([encodeFrame(1, Buffer.from('aaa'), false), encodeFrame(1, Buffer.from('drop me'), false), Buffer.from([0x89, 0x00]), encodeFrame(1, Buffer.from('zzz'), false)]);
    relay.push(all.subarray(0, 7)); // split in the middle of a frame
    relay.push(all.subarray(7));
    await new Promise((r) => setTimeout(r, 50));
    const out: string[] = [];
    webSocketFrameParser('received', (f) => out.push(f.opcode === 'ping' ? 'ping' : (f.text ?? ''))).push(Buffer.concat(wire));
    expect(out).toEqual(['bbb', 'ping', 'zzz']);
    expect(listed.map((l) => [l.text, l.ruled])).toEqual([
      ['bbb', 'edited'],
      ['drop me', 'dropped'],
      [undefined, undefined],
      ['zzz', undefined],
    ]);
  });

  describe('through the proxy', () => {
    let api: Server;
    let wss: WebSocketServer;
    let apiPort = 0;
    let proxy: DebuggerProxy;
    let rules: DebuggerRule[] = [];
    let answer: BreakpointEdits | undefined;
    const held: string[] = [];
    const fromClient: string[] = [];

    beforeAll(async () => {
      api = createServer((_req, res) => res.writeHead(200).end('plain'));
      wss = new WebSocketServer({ server: api });
      wss.on('connection', (ws) => {
        ws.on('message', (m) => {
          fromClient.push(m.toString());
          ws.send(`echo ${m.toString()}`);
        });
      });
      await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
      apiPort = (api.address() as { port: number }).port;
      proxy = await startDebuggerProxy({
        applicationOf: async () => 'vitest',
        rules: () => rules,
        onBreakpoint: async (e, phase) => {
          held.push(`${phase}:${phase === 'request' ? e.requestBody : e.responseBody}`);
          return answer;
        },
      });
    });
    afterAll(async () => {
      await proxy.close();
      wss.close();
      await new Promise<void>((r) => api.close(() => r()));
    });

    /** Upgrade through the proxy, send the texts one after another, collect what comes back for `ms`. */
    const talk = (send: string[], ms = 400) =>
      new Promise<string[]>((resolve, reject) => {
        const got: string[] = [];
        const req = request({
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: `http://127.0.0.1:${apiPort}/socket`,
          headers: { host: `127.0.0.1:${apiPort}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'), 'sec-websocket-extensions': 'permessage-deflate' },
        });
        req.on('upgrade', (res, socket) => {
          expect(res.headers['sec-websocket-extensions']).toBeUndefined(); // the server was asked not to compress
          const reader = webSocketFrameParser('received', (f) => f.text !== undefined && got.push(f.text));
          socket.on('data', (c: Buffer) => reader.push(c));
          send.forEach((t, i) => setTimeout(() => socket.write(encodeFrame(1, Buffer.from(t), true)), i * 40));
          setTimeout(() => (socket.destroy(), resolve(got)), ms);
        });
        req.on('error', reject);
        req.end();
      });

    it('drops, replaces and lists frames', async () => {
      fromClient.length = 0;
      rules = [
        { id: 'a', name: 'No private', enabled: true, kind: 'frame', match: {}, frame: { direction: 'sent', action: 'drop', when: 'private' } },
        { id: 'b', name: 'Mask', enabled: true, kind: 'frame', match: {}, frame: { direction: 'received', action: 'replace', find: 'secret', replace: '[hidden]' } },
      ];
      const got = await talk(['hello secret', 'private note', 'bye']);
      expect(fromClient).toEqual(['hello secret', 'bye']);
      expect(got).toEqual(['echo hello [hidden]'.replace('echo hello [hidden]', 'echo hello [hidden]'), 'echo bye']);
      await new Promise((r) => setTimeout(r, 300));
      const e = proxy.exchanges.filter((x) => x.kind === 'websocket').at(-1)!;
      expect(e.frames?.map((f) => [f.direction, f.text, f.ruled])).toContainEqual(['sent', 'private note', 'dropped']);
      expect(e.frames?.map((f) => [f.direction, f.text, f.ruled])).toContainEqual(['received', 'echo hello [hidden]', 'edited']);
    });

    it('break: a frame waits in the breakpoint panel, and the edit is what goes on', async () => {
      fromClient.length = 0;
      held.length = 0;
      rules = [{ id: 'k', name: 'Pause', enabled: true, kind: 'frame', match: {}, frame: { direction: 'sent', action: 'break' } }];
      answer = { body: 'changed by hand' };
      await talk(['original'], 300);
      expect(held).toEqual(['request:original']);
      expect(fromClient).toEqual(['changed by hand']);
      answer = { abort: true };
      fromClient.length = 0;
      await talk(['never arrives'], 300);
      expect(fromClient).toEqual([]);
    });
  });
});

describe('debugger_rules for agents', () => {
  const run = async (t: ReturnType<typeof debuggerTools>, name: string, args: Record<string, unknown>) => {
    const r = await t.find((x) => x.name === name)!.run(args as never);
    return r as Record<string, any>;
  };
  it('takes the new rule kinds, refuses the ones that cannot work, and sets the network speed', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: [] });
    const remap = await run(t, 'debugger_rules', { action: 'add', rule: { kind: 'remap', match: { host: 'api.test' }, remap: { to: 'localhost:3000', preserveHost: true } } });
    expect(remap.added.summary).toBe('Reach api.test at localhost:3000, keeping the Host header');
    await run(t, 'debugger_rules', { action: 'add', rule: { kind: 'fault', match: {}, fault: { action: 'drop' } } });
    await run(t, 'debugger_rules', { action: 'add', rule: { kind: 'frame', match: {}, frame: { action: 'drop', direction: 'received' } } });
    await expect(run(t, 'debugger_rules', { action: 'add', rule: { kind: 'fault', match: {}, fault: { action: 'truncate' } } })).rejects.toThrow(/bytes to keep/);
    await expect(run(t, 'debugger_rules', { action: 'add', rule: { kind: 'reply', match: {}, reply: { status: 200, file: '../x' } } })).rejects.toThrow(/inside the workspace/);
    expect((await run(t, 'debugger_rules', { action: 'list' })).rules).toHaveLength(3);
    expect((await run(t, 'debugger_rules', { action: 'speed' })).speed).toBeNull();
    expect((await run(t, 'debugger_rules', { action: 'speed', speed: '3g' })).speed).toMatchObject({ preset: '3g' });
    expect((await run(t, 'debugger_rules', { action: 'speed', speed: 'custom', down_kbps: 256, latency_ms: 50 })).label).toBe('Custom: 256 down / 256 up kbit/s, 50 ms');
    await expect(run(t, 'debugger_rules', { action: 'speed', speed: 'dialup' })).rejects.toThrow(/No network speed/);
    expect((await run(t, 'debugger_rules', { action: 'speed', speed: 'off' })).speed).toBeNull();
  });
});
