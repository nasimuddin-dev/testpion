import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import {
  applyHeaderEdits,
  decideRequest,
  describeRule,
  patternToRegExp,
  ruleMatches,
  rulePresets,
  startDebuggerProxy,
  type BreakpointEdits,
  type DebuggerExchange,
  type DebuggerProxy,
  type DebuggerRule,
} from '@testpion/core';

// DBG-3: rules decide what the proxy does with matching traffic: ignore, highlight, modify, reply, redirect, breakpoints.
const ex = (over: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: 'x',
  startedAt: new Date().toISOString(),
  kind: 'http',
  method: 'GET',
  url: 'http://api.test:8080/orders/42?x=1',
  host: 'api.test:8080',
  clientPort: 1,
  application: 'node',
  requestHeaders: {},
  requestBodyBytes: 0,
  responseBodyBytes: 0,
  ...over,
});

describe('debugger rules: matching', () => {
  it('matches globs on host, URL and program, a regular expression on the URL, and methods', () => {
    expect(patternToRegExp('*.test')!.test('api.test')).toBe(true);
    expect(patternToRegExp('api.test')!.test('api.test:8080')).toBe(false);
    const r = (match: DebuggerRule['match']): DebuggerRule => ({ id: 'r', name: 'r', enabled: true, kind: 'highlight', match });
    expect(ruleMatches(r({ host: 'api.test' }), ex(), 'request')).toBe(true); // the port is forgiven
    expect(ruleMatches(r({ host: '*.test:8080' }), ex(), 'request')).toBe(true);
    expect(ruleMatches(r({ host: 'other.test' }), ex(), 'request')).toBe(false);
    expect(ruleMatches(r({ url: '*/orders/*' }), ex(), 'request')).toBe(true);
    expect(ruleMatches(r({ url: '/orders\\/\\d+/' }), ex(), 'request')).toBe(true);
    expect(ruleMatches(r({ method: 'post, put' }), ex(), 'request')).toBe(false);
    expect(ruleMatches(r({ method: 'GET' }), ex(), 'request')).toBe(true);
    expect(ruleMatches(r({ application: 'no*' }), ex(), 'request')).toBe(true);
  });

  it('waits for the response when the rule looks at status, time or size', () => {
    const slow: DebuggerRule = { id: 'r', name: 'r', enabled: true, kind: 'highlight', match: { minMs: 1000 }, color: 'yellow' };
    expect(ruleMatches(slow, ex(), 'request')).toBe(false);
    expect(ruleMatches(slow, ex({ durationMs: 1500 }), 'response')).toBe(true);
    expect(ruleMatches(slow, ex({ durationMs: 500 }), 'response')).toBe(false);
    const errs: DebuggerRule = { ...slow, match: { status: 'client-error' } };
    expect(ruleMatches(errs, ex({ status: 404 }), 'response')).toBe(true);
    expect(ruleMatches({ ...slow, match: { status: 418 } }, ex({ status: 418 }), 'response')).toBe(true);
    expect(ruleMatches({ ...slow, match: { status: 'error' } }, ex({ error: 'ECONNREFUSED' }), 'response')).toBe(true);
  });

  it('folds the active rules into one decision: the first reply wins, edits add up, disabled rules stay out', () => {
    const rules: DebuggerRule[] = [
      { id: '1', name: 'Header', enabled: true, kind: 'modify', match: { host: 'api.test' }, requestHeaders: [{ op: 'set', name: 'X-A', value: '1' }], delayMs: 10 },
      { id: '2', name: 'Header 2', enabled: true, kind: 'modify', match: {}, requestHeaders: [{ op: 'remove', name: 'Cookie' }], delayMs: 5 },
      { id: '3', name: 'Off', enabled: false, kind: 'reply', match: {}, reply: { status: 500 } },
      { id: '4', name: 'Offline', enabled: true, kind: 'reply', match: { url: '*/orders/*' }, reply: { status: 503 } },
      { id: '5', name: 'Second reply', enabled: true, kind: 'reply', match: {}, reply: { status: 200 } },
      { id: '6', name: 'Blue', enabled: true, kind: 'highlight', match: {}, color: 'blue' },
    ];
    const d = decideRequest(rules, ex());
    expect(d.applied).toEqual(['Header', 'Header 2', 'Offline', 'Second reply', 'Blue']);
    expect(d.reply?.status).toBe(503);
    expect(d.delayMs).toBe(15);
    expect(d.highlight).toBe('blue');
    expect(applyHeaderEdits({ cookie: 'a=b', host: 'x' }, d.requestHeaders)).toEqual({ host: 'x', 'x-a': '1' });
    expect(decideRequest([{ id: 'i', name: 'Ignore', enabled: true, kind: 'ignore', match: { host: 'api.test' } }], ex()).ignore).toBe(true);
  });

  it('describes rules and presets in one line', () => {
    expect(describeRule({ id: 'r', name: 'r', enabled: true, kind: 'reply', match: { host: 'api.test' }, reply: { status: 503 } })).toBe('Reply to api.test with 503');
    expect(describeRule({ id: 'r', name: 'r', enabled: true, kind: 'highlight', match: { minMs: 2000 }, color: 'yellow' })).toBe('Highlight everything when slower than 2000 ms in yellow');
    const presets = rulePresets('shop.test');
    expect(presets.map((p) => p.id)).toContain('cors');
    expect(presets.every((p) => p.rule.match.host === 'shop.test')).toBe(true);
  });
});

describe('debugger rules: in the proxy', () => {
  let api: Server;
  let apiPort = 0;
  let proxy: DebuggerProxy;
  let rules: DebuggerRule[] = [];
  const breakpoints: Array<{ e: DebuggerExchange; phase: string }> = [];
  let answer: BreakpointEdits | undefined;

  beforeAll(async () => {
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json', 'x-server': 'api', etag: 'abc' })
          .end(JSON.stringify({ path: req.url, host: req.headers.host, got: body, hdr: req.headers['x-a'] ?? null })),
      );
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({
      applicationOf: async () => 'vitest',
      rules: () => rules,
      onBreakpoint: async (e, phase) => {
        breakpoints.push({ e, phase });
        return answer;
      },
    });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => api.close(() => r()));
  });
  const via = (method: string, url: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('modify: request headers reach the server, response headers and the body are changed on the way back', async () => {
    rules = [
      {
        id: 'm',
        name: 'Mod',
        enabled: true,
        kind: 'modify',
        match: { url: '*/mod*' },
        requestHeaders: [{ op: 'set', name: 'X-A', value: 'added' }],
        responseHeaders: [
          { op: 'remove', name: 'etag' },
          { op: 'set', name: 'x-rule', value: 'yes' },
        ],
      },
    ];
    const r = await via('GET', `http://127.0.0.1:${apiPort}/mod`);
    expect(JSON.parse(r.text).hdr).toBe('added');
    expect(r.headers['x-rule']).toBe('yes');
    expect(r.headers.etag).toBeUndefined();
    await settle();
    const e = proxy.exchanges.find((x) => x.url.endsWith('/mod'))!;
    expect(e.rules).toEqual(['Mod']);
    rules = [{ id: 'b', name: 'Body', enabled: true, kind: 'modify', match: { url: '*/body*' }, responseBody: '{"replaced":true}' }];
    const r2 = await via('GET', `http://127.0.0.1:${apiPort}/body`);
    expect(JSON.parse(r2.text)).toEqual({ replaced: true });
    expect(r2.headers['content-length']).toBe('17');
  });

  it('reply: the server never sees it; redirect: another host gets it', async () => {
    let hits = 0;
    api.prependListener('request', () => hits++);
    rules = [{ id: 'r', name: 'Offline', enabled: true, kind: 'reply', match: { url: '*/offline*' }, reply: { status: 503, body: '{"down":true}' } }];
    const r = await via('GET', `http://127.0.0.1:${apiPort}/offline`);
    expect(r.status).toBe(503);
    expect(JSON.parse(r.text)).toEqual({ down: true });
    expect(hits).toBe(0);
    await settle();
    expect(proxy.exchanges.find((x) => x.url.endsWith('/offline'))!.repliedByRule).toBe(true);
    rules = [{ id: 'd', name: 'To api', enabled: true, kind: 'redirect', match: { host: 'nowhere.test' }, redirect: { host: `127.0.0.1:${apiPort}` } }];
    const r2 = await via('GET', 'http://nowhere.test/redirected');
    expect(r2.status).toBe(200);
    expect(JSON.parse(r2.text)).toMatchObject({ path: '/redirected', host: `127.0.0.1:${apiPort}` });
    await settle();
    const e = proxy.exchanges.find((x) => x.url.includes('nowhere.test'))!;
    expect(e.redirectedTo).toBe(`http://127.0.0.1:${apiPort}/redirected`);
  });

  it('ignore: forwarded but not listed; highlight: a colour on the row, also by response status', async () => {
    rules = [
      { id: 'i', name: 'Quiet', enabled: true, kind: 'ignore', match: { url: '*/quiet*' } },
      { id: 'ok', name: 'Fine', enabled: true, kind: 'highlight', match: { status: 'ok' }, color: 'green' },
      { id: 'h', name: 'Loud', enabled: true, kind: 'highlight', match: { url: '*/loud*' }, color: 'blue' },
    ];
    const before = proxy.exchanges.length;
    expect((await via('GET', `http://127.0.0.1:${apiPort}/quiet`)).status).toBe(200);
    await via('GET', `http://127.0.0.1:${apiPort}/loud`);
    await settle();
    expect(proxy.exchanges.some((x) => x.url.endsWith('/quiet'))).toBe(false);
    expect(proxy.exchanges.length).toBe(before + 1);
    const e = proxy.exchanges.find((x) => x.url.endsWith('/loud'))!;
    expect(e.highlight).toBe('green'); // first in the list wins once the response is in (status ok comes before Loud)
    expect(e.rules).toEqual(['Loud']);
  });

  it('breakpoint: the request is held, the edits go to the server; an abort answers 502', async () => {
    rules = [{ id: 'bp', name: 'Hold', enabled: true, kind: 'breakpoint', match: { url: '*/hold*' }, breakpoint: 'request' }];
    answer = { body: '{"edited":true}', headers: { host: `127.0.0.1:${apiPort}`, 'content-type': 'application/json', 'x-a': 'from-breakpoint' } };
    const r = await via('POST', `http://127.0.0.1:${apiPort}/hold`, '{"original":true}', { 'content-type': 'application/json' });
    expect(JSON.parse(r.text)).toMatchObject({ got: '{"edited":true}', hdr: 'from-breakpoint' });
    expect(breakpoints.map((b) => b.phase)).toEqual(['request']);
    await settle();
    expect(proxy.exchanges.find((x) => x.url.endsWith('/hold'))!.edited).toBe(true);
    answer = { abort: true };
    expect((await via('GET', `http://127.0.0.1:${apiPort}/hold2`)).status).toBe(502);
    rules = [{ id: 'bp2', name: 'Hold response', enabled: true, kind: 'breakpoint', match: { url: '*/resp*' }, breakpoint: 'response' }];
    answer = { status: 418, body: 'teapot' };
    const r3 = await via('GET', `http://127.0.0.1:${apiPort}/resp`);
    expect(r3.status).toBe(418);
    expect(r3.text).toBe('teapot');
  });
});
