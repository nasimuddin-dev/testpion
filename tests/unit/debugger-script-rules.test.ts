import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debuggerTools } from '../../packages/core/src/mcp-server/tools/debugger-tools';
import { Redactor } from '../../packages/core/src/util/redact';
import { checkRuleShape, decideRequest, describeRule, effectsInWords, runHook, scriptWantsResponse, startDebuggerProxy, testRuleScript, hookInputOf, type DebuggerExchange, type DebuggerProxy, type DebuggerRule } from '@testpion/core';

// FG-21: JS rule scripts (onRequest / onResponse) on the QuickJS sandbox.
const ex = (over: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: 'x',
  startedAt: new Date().toISOString(),
  kind: 'http',
  method: 'POST',
  url: 'http://api.test/items/42',
  host: 'api.test',
  clientPort: 1,
  requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer abc' },
  requestBody: '{"a":1}',
  requestBodyBytes: 7,
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"ok":true}',
  responseBodyBytes: 11,
  ...over,
});
const script = (code: string, over: Partial<DebuggerRule> = {}): DebuggerRule => ({ id: 's1', name: 'My script', enabled: true, kind: 'script', match: {}, script: { code, timeoutMs: 1500 }, ...over });
const input = (e: DebuggerExchange, phase: 'request' | 'response') => hookInputOf(e, phase);

describe('script rules: the hooks', () => {
  it('onRequest sets and removes headers, replaces the body, replies, delays, highlights and ignores', async () => {
    const r = await runHook(
      script(`function onRequest(ctx) {
        ctx.request.headers['X-Env'] = 'staging';
        delete ctx.request.headers.authorization;
        ctx.request.body = JSON.stringify({ ...JSON.parse(ctx.request.body), b: 2 });
        ctx.delay(200); ctx.highlight('red');
        if (ctx.request.url.includes('/items/42')) ctx.reply(403, { error: 'no' });
        console.log('seen', ctx.request.method);
      }`),
      input(ex(), 'request'),
      undefined,
    );
    expect(r.error).toBeUndefined();
    expect(r.ran).toBe(true);
    expect(r.effects.requestHeaders).toEqual(expect.arrayContaining([{ op: 'set', name: 'x-env', value: 'staging' }, { op: 'remove', name: 'authorization' }]));
    expect(r.effects.requestBody).toBe('{"a":1,"b":2}');
    expect(r.effects.reply).toMatchObject({ status: 403, body: '{"error":"no"}', headers: { 'content-type': 'application/json' } });
    expect(r.effects.delayMs).toBe(200);
    expect(r.effects.highlight).toBe('red');
    expect(r.logs).toEqual(['seen POST']);
    expect(effectsInWords(r.effects).join('|')).toContain('answers 403 itself');
  });

  it('onResponse changes the status, headers and body', async () => {
    const r = await runHook(
      script(`function onResponse(ctx) { if (ctx.response.status === 200) ctx.response.status = 201; ctx.response.headers['x-seen'] = '1'; ctx.response.body = ctx.response.body.replace('true', 'false'); }`),
      input(ex(), 'response'),
      undefined,
    );
    expect(r.effects).toMatchObject({ setStatus: 201, responseBody: '{"ok":false}', responseHeaders: [{ op: 'set', name: 'x-seen', value: '1' }] });
  });

  it('a script that defines only the other hook does nothing; a script without hooks is refused when saved', async () => {
    const r = await runHook(script('function onResponse(ctx) {}'), input(ex(), 'request'), undefined);
    expect(r.noHook).toBe(true);
    expect(r.effects).toEqual({});
    expect(checkRuleShape(script('const a = 1;'))).toMatch(/neither onRequest/);
    expect(checkRuleShape(script('function onRequest(){}', { script: { code: 'function onRequest(){}', timeoutMs: 99999 } }))).toMatch(/10 ms to/);
    expect(checkRuleShape(script('', { script: { file: '../x.js' } }))).toMatch(/inside the workspace/);
    expect(checkRuleShape(script('function onRequest(){}'))).toBeUndefined();
  });

  it('fails open: an error or a loop ends that hook with a message and changes nothing', async () => {
    const bad = await runHook(script('function onRequest(ctx) { throw new Error("boom"); }'), input(ex(), 'request'), undefined);
    expect(bad.error).toContain('boom');
    expect(bad.effects).toEqual({});
    const loop = await runHook(script('function onRequest(ctx) { while (true) {} }', { script: { code: 'function onRequest(ctx) { while (true) {} }', timeoutMs: 60 } }), input(ex(), 'request'), undefined);
    expect(loop.error).toMatch(/timed out/);
    expect(loop.ms).toBeLessThan(2000);
    // the engine still works after a runaway
    expect((await runHook(script('function onRequest(ctx) { ctx.delay(5); }'), input(ex(), 'request'), undefined)).effects.delayMs).toBe(5);
  });

  it('has no network, files, modules or secrets', async () => {
    const r = await runHook(
      script(`function onRequest(ctx) {
        ctx.log(typeof process, typeof fetch, typeof XMLHttpRequest, typeof WebSocket);
        ctx.log(JSON.stringify(tp.environment.toObject ? tp.environment.toObject() : {}), String(tp.vault && tp.vault.get ? 'vault' : 'no vault'));
      }`),
      input(ex(), 'request'),
      undefined,
    );
    expect(r.error).toBeUndefined();
    expect(r.logs[0]).toBe('undefined undefined undefined undefined');
    expect(r.logs[1]).toContain('{}');
    // tp.sendRequest is in the script API, but the host offers no sender: the call is not made, its callback does not run, and the rest of the hook goes on
    const sent = await runHook(script(`function onRequest(ctx) { tp.sendRequest('http://127.0.0.1:9/', () => {}); ctx.delay(1); }`), input(ex(), 'request'), undefined);
    expect(sent.effects).toEqual({ delayMs: 1 });
    expect(sent.logs.join(' ')).toMatch(/not available/);
  });

  it('reads a script file from the workspace, only inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-script-'));
    try {
      mkdirSync(join(dir, 'debugger', 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'debugger', 'scripts', 'a.js'), 'function onRequest(ctx) { ctx.highlight("blue"); }');
      const ok = await runHook(script('', { script: { file: 'debugger/scripts/a.js' } }), input(ex(), 'request'), dir);
      expect(ok.effects.highlight).toBe('blue');
      const miss = await runHook(script('', { script: { file: 'debugger/scripts/none.js' } }), input(ex(), 'request'), dir);
      expect(miss.error).toMatch(/could not be read/);
      const out = await runHook(script('', { script: { file: '../outside.js' } }), input(ex(), 'request'), dir);
      expect(out.error).toMatch(/inside the workspace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a rule kind: decideRequest collects it and holds the response only for onResponse', () => {
    const only = script('function onRequest(ctx) {}');
    const both = script('function onResponse(ctx) {}', { id: 's2' });
    expect(decideRequest([only], ex()).scripts).toHaveLength(1);
    expect(decideRequest([only], ex()).hold).toBe(false);
    expect(decideRequest([only, both], ex()).hold).toBe(true);
    expect(scriptWantsResponse(both)).toBe(true);
    expect(decideRequest([{ ...only, enabled: false }], ex()).scripts).toBeUndefined();
    expect(decideRequest([{ ...only, match: { host: 'other.test' } }], ex()).scripts).toBeUndefined();
    expect(describeRule(only)).toBe('Run a script on everything');
  });

  it('the test button says what a script would do on a captured exchange and sends nothing', async () => {
    const t = await testRuleScript(script('function onRequest(ctx) { ctx.request.headers.a = "1"; } function onResponse(ctx) { ctx.response.status = 202; }'), ex(), true, undefined);
    expect(t.ok).toBe(true);
    expect(t.phases.map((p) => p.phase)).toEqual(['request', 'response']);
    expect(t.phases[0]!.does).toEqual(['sets the request header a: 1']);
    expect(t.phases[1]!.does).toEqual(['changes the response status to 202']);
    const failed = await testRuleScript(script('function onRequest(ctx) { nope(); }'), ex(), true, undefined);
    expect(failed.ok).toBe(false);
    expect(failed.phases[0]!.error).toMatch(/nope/);
  });
});

describe('script rules in the proxy', () => {
  let api: Server;
  let apiPort = 0;
  let proxy: DebuggerProxy;
  let rules: DebuggerRule[] = [];
  const seen: Array<{ url?: string; headers: IncomingMessage['headers']; body: string }> = [];

  beforeAll(async () => {
    api = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url, got: body, secret: 'abc' }));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as { port: number }).port;
    proxy = await startDebuggerProxy({ applicationOf: async () => 'vitest', rules: () => rules });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => api.close(() => r()));
  });
  const via = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status?: number; text: string; headers: IncomingMessage['headers'] }>((resolve) => {
      let text = '';
      const req = request({ host: '127.0.0.1', port: proxy.port, method, path: `http://127.0.0.1:${apiPort}${path}`, headers: { host: `127.0.0.1:${apiPort}`, ...headers } }, (res) => {
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      });
      req.on('error', (e) => resolve({ text: e.message, headers: {} }));
      req.end(body);
    });

  it('edits the request the server receives and the response the program gets', async () => {
    rules = [
      script(`function onRequest(ctx) { ctx.request.headers['x-from-script'] = 'yes'; ctx.request.body = ctx.request.body.toUpperCase(); }
              function onResponse(ctx) { const j = JSON.parse(ctx.response.body); delete j.secret; ctx.response.body = JSON.stringify(j); ctx.response.status = 202; ctx.response.headers['x-patched'] = '1'; }`),
    ];
    seen.length = 0;
    const r = await via('POST', '/echo', 'hello');
    expect(seen[0]!.headers['x-from-script']).toBe('yes');
    expect(seen[0]!.body).toBe('HELLO');
    expect(r.status).toBe(202);
    expect(r.headers['x-patched']).toBe('1');
    expect(JSON.parse(r.text)).toEqual({ path: '/echo', got: 'HELLO' });
    const listed = proxy.exchanges.at(-1)!;
    expect(listed.rules).toEqual(['My script']);
  });

  it('answers by itself when the script replies; the server never sees the request', async () => {
    rules = [script(`function onRequest(ctx) { if (ctx.request.url.includes('/blocked')) ctx.reply(451, 'not here', { 'content-type': 'text/plain' }); }`)];
    seen.length = 0;
    const r = await via('GET', '/blocked');
    expect(r.status).toBe(451);
    expect(r.text).toBe('not here');
    expect(seen).toHaveLength(0);
    expect((await via('GET', '/fine')).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('a failing script lets the traffic through and says so on the exchange', async () => {
    rules = [script('function onRequest(ctx) { throw new Error("oops"); }')];
    const r = await via('GET', '/through');
    expect(r.status).toBe(200);
    expect(proxy.exchanges.at(-1)!.rules?.[0]).toMatch(/My script \(script error: .*oops/);
  });

  it('a rule that does not match its host never runs', async () => {
    rules = [script(`function onRequest(ctx) { ctx.reply(500, 'x'); }`, { match: { host: 'other.test' } })];
    expect((await via('GET', '/untouched')).status).toBe(200);
  });
});

describe('debugger_scripts for agents', () => {
  const run = async (t: ReturnType<typeof debuggerTools>, args: Record<string, unknown>) => (await t.find((x) => x.name === 'debugger_scripts')!.run(args as never)) as Record<string, any>;
  it('sets, lists, tests, switches off and removes script rules, and refuses what cannot work', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: [ex({ id: 'e1', requestHeaders: { authorization: 'Bearer abc' } })] });
    const set = await run(t, { action: 'set', name: 'Staging', host: 'api.test', code: 'function onRequest(ctx) { ctx.request.headers["x-env"] = "staging"; console.log("tok sk-abcdefghijklmnopqrstuvwx"); }' });
    expect(set.scripts).toHaveLength(1);
    const id = set.saved as string;
    const tested = await run(t, { action: 'test', id, exchange: 'e1' });
    expect(tested).toMatchObject({ ok: true, matches: true });
    expect(tested.phases[0].does).toEqual(['sets the request header x-env: staging']);
    expect(JSON.stringify(tested)).not.toContain('abcdefghijkl');
    expect((await run(t, { action: 'test', code: 'function onRequest(ctx) { ctx.delay(7); }', exchange: 'e1' })).phases[0].does).toEqual(['waits 7 ms before forwarding']);
    expect((await run(t, { action: 'set', id, timeout_ms: 500 })).scripts[0].script.timeoutMs).toBe(500);
    expect((await run(t, { action: 'disable', id })).scripts[0].enabled).toBe(false);
    await expect(run(t, { action: 'set', code: 'const a = 1;' })).rejects.toThrow(/neither onRequest/);
    await expect(run(t, { action: 'test', id, exchange: 'nope' })).rejects.toThrow(/captured exchange/);
    expect((await run(t, { action: 'remove', id })).scripts).toEqual([]);
    // the generic rule tool takes the kind too
    const rules = t.find((x) => x.name === 'debugger_rules')!;
    const added = (await rules.run({ action: 'add', rule: { kind: 'script', match: {}, script: { code: 'function onResponse(ctx) {}' } } } as never)) as Record<string, any>;
    expect(added.added.summary).toBe('Run a script on everything');
  });
});
