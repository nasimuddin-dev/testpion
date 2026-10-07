import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { conditionHolds, decideRequest, describeCondition, describeRule, ruleMatches, startDebuggerProxy, type DebuggerExchange, type DebuggerProxy, type DebuggerRule } from '@testpion/core';

// The Debugger workbench: Capture only and Filter out rules the user makes, highlight conditions on a column (the
// Highlight Rule editor), hits per rule, and per exchange the program's process id, the server's address and the
// send / wait / receive times (the Summary and Timeline panels).
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
const rule = (over: Partial<DebuggerRule>): DebuggerRule => ({ id: over.id ?? 'r', name: over.name ?? 'r', enabled: true, kind: 'highlight', match: {}, ...over });

describe('column conditions', () => {
  it('compares numbers, ranges and text', () => {
    const e = ex({ status: 404, durationMs: 250, contentType: 'application/json', responseBodyBytes: 2048 });
    expect(conditionHolds({ column: 'status', op: 'between', value: '400', value2: '499' }, e)).toBe(true);
    expect(conditionHolds({ column: 'status', op: 'between', value: '500', value2: '599' }, e)).toBe(false);
    expect(conditionHolds({ column: 'status', op: 'equals', value: '404' }, e)).toBe(true);
    expect(conditionHolds({ column: 'duration', op: 'greater-than', value: '200' }, e)).toBe(true);
    expect(conditionHolds({ column: 'size', op: 'less-than', value: '1000' }, e)).toBe(false);
    expect(conditionHolds({ column: 'type', op: 'contains', value: 'JSON' }, e)).toBe(true);
    expect(conditionHolds({ column: 'url', op: 'starts-with', value: 'http://api.test' }, e)).toBe(true);
    expect(conditionHolds({ column: 'url', op: 'contains', value: 'orders/\\d+', regex: true }, e)).toBe(true);
    expect(conditionHolds({ column: 'method', op: 'not-equals', value: 'post' }, e)).toBe(true);
    // a bad regular expression matches nothing (no throw)
    expect(conditionHolds({ column: 'url', op: 'matches', value: '(' }, e)).toBe(false);
    expect(describeCondition({ column: 'status', op: 'between', value: '400', value2: '499' })).toBe('Status is between 400 and 499');
  });

  it('the server address is known only once connected: an IP condition is checked with the response', () => {
    const r = rule({ match: { where: { column: 'ip', op: 'equals', value: '127.0.0.1:80' } } });
    expect(ruleMatches(r, ex({ serverAddress: '127.0.0.1:80' }), 'request')).toBe(false);
    expect(ruleMatches(r, ex({ serverAddress: '127.0.0.1:80', status: 200 }), 'response')).toBe(true);
  });

  it('a pattern is tested on a capped text, and an invalid or huge one matches nothing', () => {
    // the end of a very long URL is past what is tested
    const long = ex({ url: 'http://x/' + 'a'.repeat(50_000) + 'END' });
    expect(conditionHolds({ column: 'url', op: 'matches', value: 'END$' }, long)).toBe(false);
    expect(conditionHolds({ column: 'url', op: 'matches', value: '^http://x/a' }, long)).toBe(true);
    expect(conditionHolds({ column: 'url', op: 'matches', value: 'x'.repeat(600) }, long)).toBe(false);
    expect(conditionHolds({ column: 'url', op: 'matches', value: '[' }, long)).toBe(false);
  });

  it('a condition on the response waits for it', () => {
    const r = rule({ match: { where: { column: 'status', op: 'between', value: '400', value2: '499' } }, style: { dark: '#00ff00', bold: true } });
    expect(ruleMatches(r, ex(), 'request')).toBe(false);
    expect(ruleMatches(r, ex({ status: 404 }), 'response')).toBe(true);
    expect(describeRule(r)).toMatch(/where Status is between 400 and 499 in #00ff00, bold/);
  });
});

describe('capture only and filter out', () => {
  it('capture only lists just what one of them matches', () => {
    const only = rule({ id: 'o1', kind: 'only', match: { host: 'api.test:*' } });
    expect(decideRequest([only], ex()).ignore).toBe(false);
    expect(decideRequest([only], ex()).appliedIds).toEqual(['o1']);
    expect(decideRequest([only], ex({ host: 'other.test', url: 'http://other.test/' })).ignore).toBe(true);
    // turned off: everything is listed again
    expect(decideRequest([{ ...only, enabled: false }], ex({ host: 'other.test' })).ignore).toBe(false);
    expect(describeRule(only)).toBe('Capture only api.test:*');
  });

  it('filter out hides what it matches; ids come back for the hit counts', () => {
    const out = rule({ id: 'f1', kind: 'ignore', match: { application: 'node' } });
    const d = decideRequest([out], ex());
    expect(d.ignore).toBe(true);
    expect(d.appliedIds).toEqual(['f1']);
    expect(describeRule(out)).toBe('Filter out from node');
  });
});

describe('through the proxy', () => {
  let api: Server;
  let apiPort = 0;
  let proxy: DebuggerProxy;
  let rules: DebuggerRule[] = [];
  beforeAll(async () => {
    api = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(req.url?.startsWith('/missing') ? 404 : 200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({ applicationOf: async () => ({ name: 'vitest', pid: 4242 }), rules: () => rules });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => api.close(() => r()));
  });
  const via = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const url = `http://127.0.0.1:${apiPort}${path}`;
      const req = request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: url, headers: { host: `127.0.0.1:${apiPort}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end('{"a":1}');
    });
  const settle = () => new Promise((r) => setTimeout(r, 80));

  it('a program found after the exchange was listed is reported as an update', async () => {
    let answer!: (v: { name: string; pid: number }) => void;
    const updates: string[] = [];
    const slow = await startDebuggerProxy({
      applicationOf: () => new Promise((r) => (answer = r)),
      onExchange: (e, phase) => phase === 'update' && updates.push(`${e.application}:${e.pid}`),
    });
    try {
      const done = new Promise<void>((resolve, reject) => {
        const url = `http://127.0.0.1:${apiPort}/late`;
        const req = request({ host: '127.0.0.1', port: slow.port, method: 'GET', path: url, headers: { host: `127.0.0.1:${apiPort}` } }, (res) => (res.resume(), res.on('end', () => resolve())));
        req.on('error', reject);
        req.end();
      });
      await done;
      expect(slow.exchanges.at(-1)!.application).toBeUndefined();
      answer({ name: 'late-app', pid: 7 });
      await settle();
      expect(updates).toEqual(['late-app:7']);
    } finally {
      await slow.close();
    }
  });

  it('records the program and its process id, the server address and the three times', async () => {
    rules = [];
    proxy.clear();
    await via('/ok');
    await settle();
    const e = proxy.exchanges.at(-1)!;
    expect(e.application).toBe('vitest');
    expect(e.pid).toBe(4242);
    expect(e.serverAddress).toBe(`127.0.0.1:${apiPort}`);
    expect(e.sendMs).toBeGreaterThanOrEqual(0);
    expect(e.waitMs).toBeGreaterThanOrEqual(e.sendMs!);
    expect(e.durationMs).toBeGreaterThanOrEqual(e.waitMs!);
  });

  it('counts hits per rule, a highlight once even when it matches on the response too', async () => {
    rules = [
      rule({ id: 'hl-404', kind: 'highlight', match: { where: { column: 'status', op: 'between', value: '400', value2: '499' } }, style: { dark: '#00ff00', bold: true, row: false } }),
      rule({ id: 'hl-all', kind: 'highlight', match: { method: 'POST' }, color: 'blue' }),
      rule({ id: 'hide', kind: 'ignore', match: { url: '*/hidden*' } }),
    ];
    proxy.clear();
    proxy.resetRuleHits();
    await via('/missing');
    await via('/ok');
    await via('/hidden');
    await settle();
    const hits = proxy.ruleHits();
    expect(hits['hl-all']).toBe(3);
    expect(hits['hl-404']).toBe(1);
    expect(hits['hide']).toBe(1);
    // the hidden one is not listed; the 404 carries the condition's style
    expect(proxy.exchanges.map((e) => new URL(e.url).pathname)).toEqual(['/missing', '/ok']);
    const missing = proxy.exchanges.find((e) => e.url.includes('/missing'))!;
    expect(missing.highlightStyle).toEqual({ dark: '#00ff00', bold: true, row: false });
  });

  it('capture only through the proxy', async () => {
    rules = [rule({ id: 'only-ok', kind: 'only', match: { url: '*/ok*' } })];
    proxy.clear();
    proxy.resetRuleHits();
    await via('/ok');
    await via('/missing');
    await settle();
    expect(proxy.exchanges.map((e) => new URL(e.url).pathname)).toEqual(['/ok']);
    expect(proxy.ruleHits()['only-ok']).toBe(1);
  });
});
