import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DebuggerSession,
  SessionSpool,
  createShareBundle,
  describeDiff,
  diffSessions,
  exchangesFromSaz,
  exchangesToHar,
  exchangesToSaz,
  kindOf,
  openShareBundle,
  planLaunch,
  rulesFromFarx,
  type DebuggerExchange,
} from '@testpion/core';
import { readZip, writeZip } from '../../packages/core/src/transfer/zip.js';

// FG-22 SAZ export and FARX import, FG-23 compare two captures, FG-24 share bundle, FG-28 large-session mode, FG-14 launcher.

const dir = mkdtempSync(join(tmpdir(), 'tp-ent-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const redactor = {
  redactString: (s: string) => s.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED]'),
  redactUrl: (u: string) => u.replace(/token=[^&]+/, 'token=[REDACTED]'),
  redactHeaders: (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /^authorization$/i.test(k) ? '[REDACTED]' : v])),
};

let n = 0;
const ex = (o: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: `e${++n}`,
  startedAt: new Date(Date.UTC(2026, 9, 28, 12, 0, n)).toISOString(),
  kind: 'http',
  method: 'GET',
  url: `http://api.test/item/${n}`,
  host: 'api.test',
  clientPort: 5000 + n,
  application: 'curl',
  requestHeaders: { accept: 'application/json' },
  requestBodyBytes: 0,
  status: 200,
  statusText: 'OK',
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"ok":true}',
  responseBodyBytes: 11,
  contentType: 'application/json',
  waitMs: 20,
  durationMs: 30,
  ...o,
});

describe('SAZ export (FG-22)', () => {
  it('round-trips through the SAZ import, masked, with timings and the program', async () => {
    const a = ex({ method: 'POST', url: 'http://api.test/login?token=abc', requestHeaders: { authorization: 'Bearer sk-secret1', 'content-type': 'application/json' }, requestBody: '{"key":"sk-abc123"}', requestBodyBytes: 19, status: 401, statusText: 'Unauthorized', responseBody: 'no' });
    const t = ex({ kind: 'tunnel', method: 'CONNECT', url: 'https://secure.test:443', host: 'secure.test:443', responseBody: undefined, status: 200 });
    const saz = await exchangesToSaz([a, t], redactor);
    const names = readZip(saz).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['raw/1_c.txt', 'raw/1_s.txt', 'raw/1_m.xml', 'raw/2_c.txt', '_index.htm', '[Content_Types].xml']));
    const raw = readZip(saz).find((e) => e.name === 'raw/1_c.txt')!.data.toString();
    expect(raw).toContain('POST http://api.test/login?token=[REDACTED] HTTP/1.1');
    expect(raw).not.toContain('sk-secret1');
    expect(raw).not.toContain('sk-abc123');
    const back = exchangesFromSaz(saz);
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ method: 'POST', status: 401, application: 'curl', waitMs: 20, durationMs: 30, clientPort: a.clientPort });
    expect(back[0]!.requestHeaders.authorization).toBe('[REDACTED]');
    expect(back[1]).toMatchObject({ kind: 'tunnel', method: 'CONNECT', host: 'secure.test' });
  });
});

describe('FARX import (FG-22)', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AutoResponder LatencyMs="0"><State Enabled="true" Fallthrough="true" UseLatency="false">
<ResponseRule Match="EXACT:http://api.test/a?x=1" Action="*redir:https://other.test/b" Enabled="true" />
<ResponseRule Match="regex:(?insx)^https?://api\\.test/v\\d+/users" Action="404_Plain.dat" Enabled="false" />
<ResponseRule Match="orders" Action="*bpu" Enabled="true" />
<ResponseRule Match="/slow" Action="*delay:1500" />
<ResponseRule Match="api.test/old" Action="https://new.test:8443/new/path?q=1" />
<ResponseRule Match="cfg.json" Action="C:\\Fiddler\\Responses\\cfg.json" />
<ResponseRule Match="NOT:static" Action="*drop" />
<ResponseRule Match="x" Action="*exit" />
<ResponseRule Match="METHOD:POST /pay" Action="*drop" />
</State></AutoResponder>`;

  it('maps what it can and says what happened to the rest', () => {
    const r = rulesFromFarx(xml);
    expect(r.autoResponderEnabled).toBe(true);
    expect(r.items).toHaveLength(9);
    const byMatch = (m: string) => r.items.find((i) => i.match === m)!;
    expect(byMatch('EXACT:http://api.test/a?x=1').result).toBe('imported');
    const redir = r.rules.find((x) => x.id === byMatch('EXACT:http://api.test/a?x=1').rule)!;
    expect(redir).toMatchObject({ kind: 'reply', reply: { status: 302, headers: { location: 'https://other.test/b' } } });
    expect(redir.match.url).toBe(String.raw`/^http:\/\/api\.test\/a\?x=1$/i`); // an exact URL with a ? is matched as a regular expression, since ? is a wildcard in a glob
    const off = r.rules.find((x) => x.reply?.status === 404)!;
    expect(off.enabled).toBe(false); // Enabled="false" is kept
    expect(off.match.url).toMatch(/^\/\^https\?/);
    expect(r.rules.find((x) => x.breakpoint === 'request')!.match.url).toBe('*orders*');
    expect(r.rules.find((x) => x.delayMs === 1500)).toBeTruthy();
    const remote = r.rules.find((x) => x.kind === 'redirect')!;
    expect(remote.redirect).toMatchObject({ host: 'new.test:8443', scheme: 'https', rewrite: { to: '/new/path?q=1', regex: true } });
    expect(byMatch('cfg.json')).toMatchObject({ result: 'off' });
    expect(byMatch('cfg.json').note).toContain('cfg.json');
    expect(r.rules.find((x) => x.reply?.file === 'cfg.json')!.enabled).toBe(false);
    expect(byMatch('NOT:static')).toMatchObject({ result: 'skipped' });
    expect(byMatch('x')).toMatchObject({ result: 'skipped' });
    expect(byMatch('METHOD:POST /pay')).toMatchObject({ result: 'skipped' });
  });

  it('refuses a file that is not an AutoResponder archive', () => {
    expect(() => rulesFromFarx('<html/>')).toThrow(/No AutoResponder rules/);
  });

  it('reads the rules out of a zip too', () => {
    const zip = writeZip([{ name: 'rules.xml', data: Buffer.from(xml) }]);
    expect(rulesFromFarx(zip).rules.length).toBeGreaterThan(3);
  });
});

describe('compare two captures (FG-23)', () => {
  it('finds added, removed, status and timing changes, matching by method and URL', () => {
    const green = [ex({ url: 'http://api.test/a', durationMs: 50 }), ex({ url: 'http://api.test/b', durationMs: 40 }), ex({ url: 'http://api.test/gone' }), ex({ url: 'http://api.test/a', durationMs: 60 }), ex({ kind: 'tunnel', url: 'https://t:443', method: 'CONNECT' })];
    const red = [ex({ url: 'http://api.test/a', durationMs: 55 }), ex({ url: 'http://api.test/b', status: 500, durationMs: 45 }), ex({ url: 'http://api.test/new' }), ex({ url: 'http://api.test/a', durationMs: 900 })];
    const d = diffSessions(green, red);
    expect(d.removed.map((x) => x.url)).toEqual(['http://api.test/gone']);
    expect(d.added.map((x) => x.url)).toEqual(['http://api.test/new']);
    expect(d.changed.map((x) => [x.url, x.changes])).toEqual([
      ['http://api.test/b', ['status']],
      ['http://api.test/a', ['timing']], // the second request for /a met the second one: 60 ms became 900 ms
    ]);
    expect(d.unchanged).toBe(1);
    expect(describeDiff(d)).toBe('1 added, 1 removed, 2 changed, 1 the same (4 vs 4 requests)');
  });

  it('can ignore the query and counts a different size when asked', () => {
    const a = [ex({ url: 'http://x.test/p?t=1', responseBodyBytes: 10 })];
    const b = [ex({ url: 'http://x.test/p?t=2', responseBodyBytes: 99 })];
    expect(diffSessions(a, b).added).toHaveLength(1);
    const d = diffSessions(a, b, { ignoreQuery: true, includeSize: true });
    expect(d.added).toHaveLength(0);
    expect(d.changed[0]!.changes).toEqual(['size']);
  });

  it('is linear: thousands of exchanges compare at once', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ex({ url: `http://api.test/i/${i}` }));
    const t = performance.now();
    const d = diffSessions(many, many.slice(100));
    expect(d.removed).toHaveLength(100);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('share bundle (FG-24)', () => {
  it('writes a masked bundle that opens again with its rules, environment and notes', async () => {
    const e = ex({ url: 'http://api.test/x?token=abc', requestHeaders: { authorization: 'Bearer sk-live1234567890abcdef' }, requestBody: '{"password":"hunter2hunter2","k":"sk-zzz"}', note: 'this one fails on Tuesdays' });
    const { bytes, manifest } = await createShareBundle({
      name: 'bug-123',
      exchanges: [e],
      rules: [{ id: 'r1', name: 'auth', enabled: true, kind: 'modify', match: { host: 'api.test' }, requestHeaders: [{ op: 'set', name: 'Authorization', value: 'Bearer sk-ruleSecret999' }] }],
      notes: 'Steps: log in, then open /x. Key sk-notesecret1.',
      state: { running: true, decrypt: true, networkSpeed: 'Slow 3G', gatewayConfig: { mode: 'manual', url: 'http://user:pw@proxy.corp:3128', username: 'ann', caFiles: ['C:/Users/ann/ca.pem'] }, passwordSet: true },
      redactor,
      now: new Date('2026-10-28T12:00:00Z'),
      env: { HTTPS_PROXY: 'http://ann:pw@proxy.corp:3128', NO_PROXY: 'localhost' },
    });
    expect(manifest).toMatchObject({ format: 'testpion-bundle', exchanges: 1, rules: 1, masked: true, hasNotes: true });
    const text = readZip(bytes).map((z) => z.data.toString('utf8')).join('\n');
    for (const secret of ['hunter2hunter2', 'sk-live1234567890abcdef', 'sk-ruleSecret999', 'sk-notesecret1', 'pw@', 'ann', 'C:/Users', 'token=abc']) expect(text, secret).not.toContain(secret);
    const open = openShareBundle(bytes);
    expect(open.manifest.name).toBe('bug-123');
    expect(open.exchanges).toHaveLength(1);
    expect(open.exchanges[0]!.note).toBe('this one fails on Tuesdays');
    expect(open.rules[0]!.id).toBe('r1');
    expect(open.environment!.proxyEnvironment).toEqual({ HTTPS_PROXY: 'proxy.corp:3128', NO_PROXY: 'localhost' });
    expect(open.environment!.debugger.gateway).toContain('proxy.corp:3128');
    expect(open.environment!.debugger.networkSpeed).toBe('Slow 3G');
    expect(open.notes).toContain('log in');
  });

  it('refuses what is not a bundle or comes from a newer TestPion', () => {
    expect(() => openShareBundle(Buffer.from('nope'))).toThrow(/not a zip/i);
    expect(() => openShareBundle(writeZip([{ name: 'manifest.json', data: Buffer.from('{"format":"other"}') }]))).toThrow(/Not a TestPion bundle/);
    expect(() => openShareBundle(writeZip([{ name: 'manifest.json', data: Buffer.from('{"format":"testpion-bundle","version":99}') }]))).toThrow(/version 99/);
    expect(() => openShareBundle(writeZip([{ name: 'manifest.json', data: Buffer.from('{"format":"testpion-bundle","version":1}') }]))).toThrow(/session.har is missing/);
  });
});

describe('large-session mode (FG-28)', () => {
  it('spills the oldest exchanges to disk instead of forgetting them, and gives the whole session back', async () => {
    const spool = new SessionSpool(join(dir, 'spool.jsonl'), redactor);
    const s = new DebuggerSession({ maxExchanges: 100 });
    s.setSpool(spool);
    for (let i = 0; i < 350; i++) s.add(ex({ url: `http://api.test/n/${i}`, requestHeaders: { authorization: 'Bearer sk-spooled' } }));
    expect(s.items.length).toBeLessThanOrEqual(102);
    expect(s.spilled + s.items.length).toBe(350);
    const all = await s.everything();
    expect(all.map((e) => e.url)).toEqual(Array.from({ length: 350 }, (_, i) => `http://api.test/n/${i}`));
    expect(readFileSync(spool.file, 'utf8')).not.toContain('sk-spooled'); // masked on disk
    s.clear();
    expect(s.spilled).toBe(0);
    expect(existsSync(spool.file)).toBe(false);
  });

  it('keeps the whole of a big file that is opened', async () => {
    const s = new DebuggerSession({ maxExchanges: 100 });
    s.setSpool(new SessionSpool(join(dir, 'spool2.jsonl'), redactor));
    s.load(Array.from({ length: 450 }, (_, i) => ex({ url: `http://api.test/o/${i}` })));
    expect(s.items).toHaveLength(100);
    expect((await s.everything()).length).toBe(450);
    s.setSpool(undefined);
    expect(existsSync(join(dir, 'spool2.jsonl'))).toBe(false);
  });

  it('without the mode the oldest are forgotten, as before', async () => {
    const s = new DebuggerSession({ maxExchanges: 100 });
    for (let i = 0; i < 350; i++) s.add(ex());
    expect(s.spilled).toBe(0);
    expect((await s.everything()).length).toBe(s.items.length);
  });

  it('the HAR of everything is a valid HAR', async () => {
    const spool = new SessionSpool(join(dir, 'spool3.jsonl'), redactor);
    const s = new DebuggerSession({ maxExchanges: 100 });
    s.setSpool(spool);
    for (let i = 0; i < 250; i++) s.add(ex());
    const har = exchangesToHar(await s.everything(), redactor);
    expect(har.log.entries).toHaveLength(250);
  });
});

describe('launch a program through the proxy (FG-14)', () => {
  const proxyUrl = 'http://127.0.0.1:8899';
  it('knows the runtimes by their file names', () => {
    expect(kindOf('C:\\Program Files\\Java\\bin\\java.exe')).toBe('java');
    expect(kindOf('/usr/bin/python3.12')).toBe('python');
    expect(kindOf('dotnet')).toBe('dotnet');
    expect(kindOf('MyApp.dll')).toBe('dotnet');
    expect(kindOf('msedge.exe')).toBe('chromium');
    expect(kindOf('npm.cmd')).toBe('node');
    expect(kindOf('mystery')).toBe('other');
  });

  it('sets the right switches for each runtime', () => {
    const java = planLaunch({ command: 'java', args: ['-jar', 'app.jar'], proxyUrl, caPath: '/tmp/root.pem' });
    expect(java.env.JAVA_TOOL_OPTIONS).toContain('-Dhttps.proxyHost=127.0.0.1');
    expect(java.env.JAVA_TOOL_OPTIONS).toContain('-Dhttps.proxyPort=8899');
    expect(java.args).toEqual(['-jar', 'app.jar']);
    expect(java.notes.join(' ')).toContain('keytool');
    expect(java.env.HTTPS_PROXY).toBe(proxyUrl);
    expect(java.env.SSL_CERT_FILE).toBe('/tmp/root.pem');

    const dotnet = planLaunch({ command: 'dotnet', args: ['run'], proxyUrl });
    expect(dotnet.env.DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER).toBe('1');
    expect(dotnet.notes.join(' ')).toContain('system proxy');

    const node = planLaunch({ command: 'node', args: ['app.js'], proxyUrl });
    expect(node.env.NODE_USE_ENV_PROXY).toBe('1');

    const curl = planLaunch({ command: 'curl', args: ['https://example.com'], proxyUrl, caPath: '/tmp/root.pem' });
    expect(curl.args).toEqual(['-x', proxyUrl, '--cacert', '/tmp/root.pem', 'https://example.com']);

    const chrome = planLaunch({ command: 'chrome', args: ['https://example.com'], proxyUrl, profileDir: join(dir, 'p') });
    expect(chrome.args).toEqual(expect.arrayContaining([`--proxy-server=${proxyUrl}`, '--disable-quic', `--user-data-dir=${join(dir, 'p')}`]));
    expect(chrome.args.at(-1)).toBe('https://example.com');

    const ff = planLaunch({ command: 'firefox', proxyUrl, profileDir: join(dir, 'ff') });
    expect(ff.args).toEqual(['-no-remote', '-profile', join(dir, 'ff')]);
    expect(Object.values(ff.files)[0]).toContain('network.http.http3.enable", false');

    const other = planLaunch({ command: 'myapp', proxyUrl });
    expect(other.kind).toBe('other');
    expect(other.env.HTTP_PROXY).toBe(proxyUrl);
  });

  it('refuses an empty program name', () => {
    expect(() => planLaunch({ command: '  ', proxyUrl })).toThrow(/Name the program/);
  });
});
