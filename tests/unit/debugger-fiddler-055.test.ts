import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../apps/desktop/src/api', () => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({ toast: vi.fn() }) } }));

import { createServer, request, type Server } from 'node:http';
import {
  MARK_COLORS,
  annotateHarEntry,
  autoBreakpointMode,
  autoBreakpointRule,
  cleanAnnotation,
  decideRequest,
  exchangesFromHar,
  exchangesToHar,
  hasCustomBreakpoint,
  parseAutoBreakpointMode,
  rulePresets,
  ruleMatches,
  startDebuggerProxy,
  withAutoBreakpoint,
  type DebuggerExchange,
  type DebuggerProxy,
  type DebuggerRule,
} from '@testpion/core';
import { browserLaunch } from '../../packages/core/src/debugger/capture';
import { debuggerTools } from '../../packages/core/src/mcp-server/tools/debugger-tools';
import { Redactor } from '../../packages/core/src/util/redact';
import { filterRows, type ListFilter } from '../../apps/desktop/src/components/debugger/useExchangeList';
import { REQUIRE_AUTH_PRESET, TRAFFIC_PRESETS, USER_AGENT_PRESETS } from '../../apps/desktop/src/components/debugger/presets';
import { MARKS } from '../../apps/desktop/src/components/debugger/marks';

const ex = (o: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: 'e1',
  startedAt: '2026-10-28T10:00:00.000Z',
  kind: 'http',
  method: 'GET',
  url: 'http://api.test/items',
  host: 'api.test',
  clientPort: 1,
  requestHeaders: {},
  requestBodyBytes: 0,
  responseBodyBytes: 0,
  ...o,
});

describe('FG-5 automatic breakpoints: the managed rule', () => {
  it('every mode makes one rule with a fixed id, and reads back as the same mode', () => {
    for (const mode of ['request', 'response', 'post', 'errors'] as const) {
      const r = autoBreakpointRule(mode)!;
      expect(r.id).toBe('auto-breakpoint');
      expect(r.name).toBe('Auto breakpoint');
      expect(r.kind).toBe('breakpoint');
      expect(autoBreakpointMode([r])).toBe(mode);
    }
    expect(autoBreakpointRule('off')).toBeUndefined();
    expect(autoBreakpointMode([])).toBe('off');
    expect(autoBreakpointMode([{ ...autoBreakpointRule('post')!, enabled: false }])).toBe('off');
  });

  it('replaces the managed rule in place, appends it when new, removes it for off, and never touches the persons own rules', () => {
    const mine: DebuggerRule = { id: 'mine', name: 'Mine', enabled: true, kind: 'breakpoint', match: { host: 'x.test' }, breakpoint: 'request' };
    const other: DebuggerRule = { id: 'o', name: 'Other', enabled: true, kind: 'highlight', match: {}, color: 'red' };
    const a = withAutoBreakpoint([mine, other], 'post');
    expect(a.map((r) => r.id)).toEqual(['mine', 'o', 'auto-breakpoint']);
    const b = withAutoBreakpoint(a, 'errors');
    expect(b.map((r) => r.id)).toEqual(['mine', 'o', 'auto-breakpoint']);
    expect(autoBreakpointMode(b)).toBe('errors');
    expect(withAutoBreakpoint(b, 'off').map((r) => r.id)).toEqual(['mine', 'o']);
    expect(hasCustomBreakpoint([mine])).toBe(true);
    expect(hasCustomBreakpoint(a.filter((r) => r.id !== 'mine'))).toBe(false);
  });

  it('accepts the words people and agents use, and refuses the rest', () => {
    expect(parseAutoBreakpointMode('every-request')).toBe('request');
    expect(parseAutoBreakpointMode('Only POST')).toBe('post');
    expect(parseAutoBreakpointMode('error')).toBe('errors');
    expect(() => parseAutoBreakpointMode('sometimes')).toThrow(/Unknown breakpoint mode/);
  });

  it('a request breakpoint decides at once; an errors breakpoint waits for the status', () => {
    const post = [autoBreakpointRule('post')!];
    expect(decideRequest(post, ex({ method: 'POST' })).breakpoint).toBe('request');
    expect(decideRequest(post, ex({ method: 'GET' })).breakpoint).toBeUndefined();
    const errors = [autoBreakpointRule('errors')!];
    const d = decideRequest(errors, ex());
    expect(d.breakpoint).toBeUndefined();
    expect(d.lateBreakpoints).toHaveLength(1);
    expect(ruleMatches(errors[0]!, ex({ status: 500 }), 'response')).toBe(true);
    expect(ruleMatches(errors[0]!, ex({ status: 200 }), 'response')).toBe(false);
    expect(ruleMatches(errors[0]!, ex({ status: 404 }), 'response')).toBe(true);
  });
});

describe('FG-15 presets', () => {
  const presets = rulePresets();
  const get = (id: string) => presets.find((p) => p.id === id)!.rule;

  it('Disable caching, Remove all encodings, Ask for gzip', () => {
    expect(get('no-cache').requestHeaders).toEqual(expect.arrayContaining([{ op: 'remove', name: 'If-None-Match' }, { op: 'set', name: 'Cache-Control', value: 'no-cache' }]));
    expect(get('no-encoding').requestHeaders).toEqual([{ op: 'remove', name: 'Accept-Encoding' }]);
    expect(get('gzip').requestHeaders).toEqual([{ op: 'set', name: 'Accept-Encoding', value: 'gzip' }]);
  });

  it('a user agent preset per browser, phone and bot, each setting User-Agent', () => {
    const uas = presets.filter((p) => p.id.startsWith('ua-'));
    expect(uas.map((p) => p.id)).toEqual(['ua-chrome', 'ua-firefox', 'ua-safari', 'ua-iphone', 'ua-android', 'ua-bot']);
    for (const p of uas) expect(p.rule.requestHeaders?.[0]).toMatchObject({ op: 'set', name: 'User-Agent' });
    expect(get('ua-iphone').requestHeaders![0]!.value).toMatch(/iPhone/);
    expect(get('ua-bot').requestHeaders![0]!.value).toMatch(/Googlebot/);
  });

  it('presets are filled in for a host', () => {
    const forHost = rulePresets('shop.test');
    expect(forHost.every((p) => p.rule.match.host === 'shop.test')).toBe(true);
  });

  it('Require proxy sign-in answers 407 to plain HTTP without credentials, and lets the rest by', () => {
    const rule = { ...get('require-auth'), id: 'r' } as DebuggerRule;
    expect(rule.reply?.status).toBe(407);
    expect(rule.reply?.headers?.['proxy-authenticate']).toMatch(/^Basic/);
    expect(decideRequest([rule], ex()).reply?.status).toBe(407);
    expect(decideRequest([rule], ex({ requestHeaders: { 'proxy-authorization': 'Basic dTpw' } })).reply).toBeUndefined();
    // inside a decrypted tunnel the request is https and carries no proxy credentials: it must not be refused
    expect(decideRequest([rule], ex({ url: 'https://api.test/items' })).reply).toBeUndefined();
  });

  it('the windows menu names exactly the presets the engine has', () => {
    const label = new Map(presets.map((p) => [p.id, p.label]));
    for (const p of TRAFFIC_PRESETS) expect(label.get(p.id), p.id).toBe(p.label);
    for (const u of USER_AGENT_PRESETS) expect(label.get(u.id), u.id).toBe(`User agent: ${u.label}`);
    expect(label.get(REQUIRE_AUTH_PRESET.id)).toBe(REQUIRE_AUTH_PRESET.label);
    expect(MARKS.map((m) => m.id)).toEqual([...MARK_COLORS]);
  });
});

describe('FG-15 Hide 304s', () => {
  const filter: ListFilter = { application: '', type: '', text: '', deep: false, host: '', method: '', status: '', bookmarked: false, hideTunnels: false, quick: [] };
  it('leaves out the 304 answers and nothing else', () => {
    const rows = [ex({ id: 'a', status: 200 }), ex({ id: 'b', status: 304 }), ex({ id: 'c', status: 404 })] as never[];
    expect(filterRows(rows, { ...filter, hide304: true }).map((e) => (e as DebuggerExchange).id)).toEqual(['a', 'c']);
    expect(filterRows(rows, filter)).toHaveLength(3);
  });
});

describe('FG-11 notes and marks', () => {
  it('survive a HAR round trip: the note is the entry comment, the mark is kept in _testpion', () => {
    const e = ex({ id: 'n1', application: 'curl', note: 'login fails here', mark: 'red', status: 401 });
    const har = JSON.parse(JSON.stringify(exchangesToHar([e, ex({ id: 'n2', application: 'curl' })], new Redactor())));
    expect(har.log.entries[0].comment).toBe('login fails here');
    expect(har.log.entries[0]._testpion.mark).toBe('red');
    // an exchange without a note still names the program in the comment, as before
    expect(har.log.entries[1].comment).toBe('application: curl');
    const back = exchangesFromHar(har);
    expect(back[0]).toMatchObject({ note: 'login fails here', mark: 'red', application: 'curl' });
    expect(back[1]!.note).toBeUndefined();
    expect(back[1]!.application).toBe('curl');
  });

  it('a note that carries a secret is masked on the way out', () => {
    const redactor = new Redactor();
    redactor.addSecret('hunter2-secret-value');
    const har = exchangesToHar([ex({ note: 'login used hunter2-secret-value here' })], redactor);
    expect(JSON.stringify(har)).not.toContain('hunter2-secret-value');
  });

  it('checks a mark and caps a note', () => {
    expect(cleanAnnotation({ mark: 'Red' }).mark).toBe('red');
    expect(cleanAnnotation({ mark: '' }).mark).toBe('');
    expect(() => cleanAnnotation({ mark: 'pink' })).toThrow(/Unknown mark colour/);
    expect(cleanAnnotation({ note: 'x'.repeat(3000) }).note).toHaveLength(2000);
  });

  it('annotateHarEntry edits one entry in the file by id or place and leaves the rest alone', () => {
    const har = JSON.parse(JSON.stringify(exchangesToHar([ex({ id: 'a', application: 'curl' }), ex({ id: 'b' })], new Redactor())));
    const r = annotateHarEntry(har, 'b', { note: 'second', mark: 'blue' });
    expect(r).toMatchObject({ entry: 'b', note: 'second', mark: 'blue' });
    expect(har.log.entries[1].comment).toBe('second');
    expect(har.log.entries[0].comment).toBe('application: curl');
    annotateHarEntry(har, '#2', { note: '', mark: '' });
    expect(har.log.entries[1].comment).toBeUndefined();
    expect(har.log.entries[1]._testpion.mark).toBeUndefined();
    // the program name in the comment is not a note, and is kept
    annotateHarEntry(har, '#1', { mark: 'green' });
    expect(har.log.entries[0].comment).toBe('application: curl');
    expect(() => annotateHarEntry(har, 'zzz', { note: 'x' })).toThrow(/No entry/);
    expect(() => annotateHarEntry({}, 'a', { note: 'x' })).toThrow(/Not a HAR/);
  });
});

describe('FG-27 browsers do not use HTTP/3', () => {
  it('Chromium browsers get --disable-quic next to the proxy switch', () => {
    const { args, userJs } = browserLaunch('chrome', 'http://127.0.0.1:8899', '/tmp/p', 'http://example.test/');
    expect(args).toContain('--proxy-server=http://127.0.0.1:8899');
    expect(args).toContain('--disable-quic');
    expect(userJs).toBeUndefined();
    expect(browserLaunch('edge', 'http://127.0.0.1:1', '/p', 'http://x.test/').args).toContain('--disable-quic');
  });
  it('Firefox gets network.http.http3.enable=false in its profile', () => {
    const { args, userJs } = browserLaunch('firefox', 'http://127.0.0.1:8899', '/tmp/p', 'http://example.test/');
    expect(userJs).toContain('user_pref("network.http.http3.enable", false);');
    expect(userJs).toContain('user_pref("network.proxy.http_port", 8899);');
    expect(args).toEqual(['-profile', '/tmp/p', '-no-remote', 'http://example.test/']);
  });
});

describe('FG-13 pause listing and FG-5 breakpoints in the proxy', () => {
  let api: Server;
  let apiPort = 0;
  let proxy: DebuggerProxy;
  let listing = true;
  let rules: DebuggerRule[] = [];
  const held: Array<{ url: string; phase: string }> = [];
  const via = (method: string, path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method, path: `http://127.0.0.1:${apiPort}${path}`, headers: { host: `127.0.0.1:${apiPort}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });

  beforeAll(async () => {
    api = createServer((req, res) => res.writeHead(req.url?.startsWith('/fail') ? 500 : 200, { 'content-type': 'text/plain' }).end('x'));
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({
      applicationOf: async () => 'vitest',
      rules: () => rules,
      listing: () => listing,
      onBreakpoint: async (e, phase) => {
        held.push({ url: e.url, phase });
        return undefined;
      },
    });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => api.close(() => r()));
  });

  it('while paused the traffic is still forwarded, nothing is listed; after resume it is listed again', async () => {
    listing = false;
    expect(await via('GET', '/paused')).toBe(200);
    expect(proxy.exchanges.some((e) => e.url.endsWith('/paused'))).toBe(false);
    listing = true;
    expect(await via('GET', '/listed')).toBe(200);
    expect(proxy.exchanges.some((e) => e.url.endsWith('/listed'))).toBe(true);
  });

  it('pausing works with no rules at all', async () => {
    rules = [];
    listing = false;
    expect(await via('GET', '/norules')).toBe(200);
    listing = true;
    expect(proxy.exchanges.some((e) => e.url.endsWith('/norules'))).toBe(false);
  });

  it('Only POST holds the POST request and lets a GET through', async () => {
    held.length = 0;
    rules = withAutoBreakpoint([], 'post');
    expect(await via('GET', '/g')).toBe(200);
    expect(held).toEqual([]);
    expect(await via('POST', '/p')).toBe(200);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ phase: 'request' });
  });

  it('Only errors holds the response of a 500 and not of a 200', async () => {
    held.length = 0;
    rules = withAutoBreakpoint([], 'errors');
    expect(await via('GET', '/fine')).toBe(200);
    expect(held).toEqual([]);
    expect(await via('GET', '/fail')).toBe(500);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ phase: 'response' });
    expect(held[0]!.url).toContain('/fail');
  });

  it('Every response holds each response', async () => {
    held.length = 0;
    rules = withAutoBreakpoint([], 'response');
    await via('GET', '/a');
    await via('GET', '/b');
    expect(held.map((h) => h.phase)).toEqual(['response', 'response']);
    rules = [];
  });
});

describe('the MCP tools: pause, breakpoints, annotate', () => {
  const run = async (tools: ReturnType<typeof debuggerTools>, name: string, args: Record<string, unknown>) => (await tools.find((t) => t.name === name)!.run(args)) as Record<string, any>;

  it('debugger_capture pause and resume change the status, and a stop clears the pause', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: [] });
    const started = await run(t, 'debugger_capture', { action: 'start' });
    expect(started.paused).toBe(false);
    expect((await run(t, 'debugger_capture', { action: 'pause' })).paused).toBe(true);
    expect((await run(t, 'debugger_capture', { action: 'status' })).paused).toBe(true);
    expect((await run(t, 'debugger_capture', { action: 'resume' })).paused).toBe(false);
    await run(t, 'debugger_capture', { action: 'pause' });
    expect((await run(t, 'debugger_capture', { action: 'stop' })).paused).toBe(false);
  });

  it('debugger_rules breakpoints keeps one managed rule; held and resume work on what it holds', async () => {
    const session: DebuggerExchange[] = [];
    const t = debuggerTools({ redactor: new Redactor(), session });
    const api = createServer((_req, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    const apiPort = (api.address() as { port: number }).port;
    const started = await run(t, 'debugger_capture', { action: 'start' });
    try {
      const set = await run(t, 'debugger_rules', { action: 'breakpoints', mode: 'request' });
      expect(set.mode).toBe('request');
      expect(set.autoBreakpoint).toBe('request');
      expect(set.rules.filter((r: DebuggerRule) => r.name === 'Auto breakpoint')).toHaveLength(1);
      expect((await run(t, 'debugger_rules', { action: 'breakpoints', mode: 'post' })).rules.filter((r: DebuggerRule) => r.id === 'auto-breakpoint')).toHaveLength(1);
      await run(t, 'debugger_rules', { action: 'breakpoints', mode: 'request' });
      const done = new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: started.port as number, method: 'GET', path: `http://127.0.0.1:${apiPort}/x`, headers: { host: `127.0.0.1:${apiPort}` } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      let heldNow: Array<{ id: string; phase: string }> = [];
      for (let i = 0; i < 100 && !heldNow.length; i++) {
        await new Promise((r) => setTimeout(r, 20));
        heldNow = (await run(t, 'debugger_rules', { action: 'held' })).held;
      }
      expect(heldNow).toHaveLength(1);
      expect(heldNow[0]!.phase).toBe('request');
      expect((await run(t, 'debugger_rules', { action: 'resume' })).released).toBe(1);
      expect(await done).toBe(200);
      expect((await run(t, 'debugger_rules', { action: 'held' })).held).toEqual([]);
      const off = await run(t, 'debugger_rules', { action: 'breakpoints', mode: 'off' });
      expect(off.rules).toEqual([]);
      await expect(run(t, 'debugger_rules', { action: 'breakpoints', mode: 'sometimes' })).rejects.toThrow(/Unknown breakpoint mode/);
    } finally {
      await run(t, 'debugger_capture', { action: 'stop' });
      await new Promise<void>((r) => api.close(() => r()));
    }
  });

  it('debugger_exchange annotate sets and removes a note and a mark; a read-only server refuses', async () => {
    const session = [ex({ id: 'x1' })];
    const t = debuggerTools({ redactor: new Redactor(), session });
    const a = await run(t, 'debugger_exchange', { id: 'x1', action: 'annotate', note: 'check this', mark: 'purple' });
    expect(a).toMatchObject({ note: 'check this', mark: 'purple' });
    expect(session[0]).toMatchObject({ note: 'check this', mark: 'purple' });
    const b = await run(t, 'debugger_exchange', { id: 'x1', action: 'annotate', note: '', mark: '' });
    expect(b.note).toBeUndefined();
    expect(session[0]!.mark).toBeUndefined();
    await expect(run(t, 'debugger_exchange', { id: 'x1', action: 'annotate', mark: 'pink' })).rejects.toThrow(/Unknown mark colour/);
    const ro = debuggerTools({ redactor: new Redactor(), session, readOnly: true });
    await expect(run(ro, 'debugger_exchange', { id: 'x1', action: 'annotate', note: 'x' })).rejects.toThrow(/read-only/);
    // reading is always allowed
    expect((await run(ro, 'debugger_exchange', { id: 'x1' })).id).toBe('x1');
  });

  it('debugger_exchanges hide_304 leaves out Not Modified', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: [ex({ id: 'a', status: 200 }), ex({ id: 'b', status: 304 })] });
    expect((await run(t, 'debugger_exchanges', { hide_304: true })).exchanges.map((e: DebuggerExchange) => e.id)).toEqual(['a']);
    expect((await run(t, 'debugger_exchanges', {})).exchanges).toHaveLength(2);
  });
});
