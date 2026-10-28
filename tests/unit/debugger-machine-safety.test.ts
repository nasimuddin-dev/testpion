import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import type { DebuggerExchange } from '../../packages/core/src/index.js';
import { fakeSystemProxyValue, setFakeSystemProxyValue, setSystemProxyTestHooks, systemProxyRecordPath } from '../../packages/core/src/debugger/system-proxy.js';
import { setCertificateTestHooks } from '../../packages/core/src/debugger/certificate.js';
import { tempDir } from '../helpers.js';

// The Debugger's backend: the system proxy is repaired at start and put back first at quit, the AutoSave is private (the app's data
// folder, tokens masked), Stop / Save / quit write without blocking, and the capture calls refuse what is not a web address.
const tmp = tempDir('tp-dbg-safety-');
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const bes: Backend[] = [];
let n = 0;
const make = (appDir = join(tmp.dir, `app${++n}`), extra: object = {}) => {
  const be = new Backend({ appDir, emit: () => undefined, noMonitors: true, ...extra });
  bes.push(be);
  return be;
};
const state = (be: Backend) => be.debugger!;

const exchange = (i: number, over: Partial<DebuggerExchange> = {}): DebuggerExchange =>
  ({
    id: `dbg-${i}`,
    startedAt: new Date(Date.UTC(2026, 9, 1, 10, 0, i)).toISOString(),
    kind: 'http',
    method: 'POST',
    url: `https://api.test/login?access_token=abcdef${i}`,
    host: 'api.test',
    clientPort: 4000 + i,
    requestHeaders: { authorization: `Bearer ${JWT}`, cookie: 'sid=top-secret-cookie', 'content-type': 'application/json' },
    requestBody: JSON.stringify({ password: 'hunter2hunter2', token: 'plain-token-value' }),
    requestBodyBytes: 10,
    status: 200,
    statusText: 'OK',
    responseHeaders: { 'set-cookie': 'sid=top-secret-cookie; HttpOnly', 'content-type': 'application/json' },
    responseBody: JSON.stringify({ id_token: JWT, ok: true }),
    responseBodyBytes: 20,
    contentType: 'application/json',
    durationMs: 3,
    ...over,
  }) as DebuggerExchange;

beforeEach(() => {
  process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
  setFakeSystemProxyValue('');
});
afterEach(() => {
  delete process.env.TESTPION_FAKE_SYSTEM_PROXY;
  setSystemProxyTestHooks();
  setCertificateTestHooks();
});
afterAll(async () => {
  for (const be of bes) await be.dispose();
  tmp.cleanup();
});

describe('the AutoSave is private', () => {
  it('lives in the app data folder, not the workspace, with tokens masked by shape; Session > Open lists it from there', async () => {
    const be = make();
    await be.invoke('debug.status', {});
    state(be).capture!(exchange(1));
    await be.invoke('debug.start', { port: 0 });
    await be.invoke('debug.stop', {}); // Stop writes it (in the background, waited for a moment)
    const file = join(be.host.appDir, 'debugger', 'autosave.har');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(be.ws.path('debugger'), 'autosave.har'))).toBe(false);
    const text = readFileSync(file, 'utf8');
    for (const secret of [JWT, 'top-secret-cookie', 'hunter2hunter2', 'plain-token-value', 'abcdef1']) expect(text, secret).not.toContain(secret);
    expect(JSON.parse(text).log.entries).toHaveLength(1);
    const list = (await be.invoke('debug.sessions', {})) as Array<{ name: string; path: string; autosave: boolean }>;
    expect(list.filter((s) => s.autosave)).toEqual([expect.objectContaining({ name: 'autosave', path: file })]);
    // opening it by its name reads the new place
    const opened = (await be.invoke('debug.openSession', { name: 'autosave' })) as { loaded: number };
    expect(opened.loaded).toBe(1);
    // a saved session of the user's own is not the AutoSave's name, and keeps the user's masking (the field list), not the stricter one
    await expect(be.invoke('debug.saveSession', { name: 'autosave' })).rejects.toThrow(/AutoSave/);
  });

  it('an AutoSave an earlier version left in the workspace moves to the app data folder', async () => {
    const be = make();
    await be.invoke('debug.status', {});
    const old = join(be.ws.path('debugger'), 'autosave.har');
    mkdirSync(be.ws.path('debugger'), { recursive: true });
    writeFileSync(old, JSON.stringify({ log: { version: '1.2', creator: { name: 't', version: '1' }, entries: [] } }));
    writeFileSync(`${old}.tmp`, 'half');
    const list = (await be.invoke('debug.sessions', {})) as Array<{ name: string; autosave: boolean }>;
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}.tmp`)).toBe(false); // the temporary file a crash left
    expect(existsSync(join(be.host.appDir, 'debugger', 'autosave.har'))).toBe(true);
    expect(list.filter((s) => s.autosave)).toHaveLength(1);
  });

  it('quitting writes what changed since, and waits for a write in flight', async () => {
    const be = make();
    await be.invoke('debug.status', {});
    state(be).capture!(exchange(1));
    state(be).capture!(exchange(2, { host: 'second.test', url: 'https://second.test/' }));
    await state(be).release!();
    const file = join(be.host.appDir, 'debugger', 'autosave.har');
    expect(JSON.parse(readFileSync(file, 'utf8')).log.entries).toHaveLength(2);
    expect(state(be).dirty).toBe(false);
    // nothing left behind
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('the system proxy does not outlive TestPion', () => {
  it('start of the app puts it back when a crashed run left it pointing at us', async () => {
    const appDir = join(tmp.dir, 'crash');
    const first = make(appDir);
    setFakeSystemProxyValue('http://corp.example:3128');
    await first.invoke('debug.start', { port: 0 });
    await first.invoke('debug.systemProxy', { on: true });
    const record = systemProxyRecordPath(join(appDir, 'debugger'));
    expect(existsSync(record)).toBe(true);
    expect(fakeSystemProxyValue()).toBe(state(first).proxy!.url);
    // the process dies: the proxy is gone, the setting stays (nothing of release / stop runs)
    await state(first).proxy!.close();
    setSystemProxyTestHooks({ alive: () => false, listening: async () => false });
    make(appDir); // the next start
    for (let i = 0; i < 50 && fakeSystemProxyValue() !== 'http://corp.example:3128'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fakeSystemProxyValue()).toBe('http://corp.example:3128');
    expect(existsSync(record)).toBe(false);
  });

  it('restarting on another port moves the system proxy with it, and quitting puts the first setting back', async () => {
    const be = make();
    setFakeSystemProxyValue('http://corp.example:3128');
    await be.invoke('debug.start', { port: 0 });
    await be.invoke('debug.systemProxy', { on: true });
    const first = state(be).proxy!.url;
    await be.invoke('debug.start', { port: 0 });
    const second = state(be).proxy!.url;
    expect(second).not.toBe(first);
    expect(fakeSystemProxyValue()).toBe(second);
    await state(be).release!();
    expect(fakeSystemProxyValue()).toBe('http://corp.example:3128');
    expect(existsSync(systemProxyRecordPath(join(be.host.appDir, 'debugger')))).toBe(false);
  });
});

describe('the capture calls', () => {
  it('refuse a start page that is a browser switch or not a web address, before anything is changed', async () => {
    const be = make();
    await be.invoke('debug.start', { port: 0 });
    for (const url of ['--renderer-cmd-prefix=calc', 'file:///C:/Windows/win.ini', 'javascript:alert(1)']) await expect(be.invoke('debug.openBrowser', { url }), url).rejects.toThrow(/http:\/\/ or https:\/\//);
    expect(fakeSystemProxyValue()).toBe('');
    await be.invoke('debug.stop', {});
  });

  it('check their parameters', async () => {
    const be = make();
    await expect(be.invoke('debug.systemProxy', {})).rejects.toThrow(/on/);
    await expect(be.invoke('debug.selfTest', {})).rejects.toThrow(/url/);
    await expect(be.invoke('debug.start', { port: 'eight' })).rejects.toThrow(/port/);
    await expect(be.invoke('debug.certificate', { action: 5 })).rejects.toThrow(/action/);
  });

  it('open a session no bigger than the host accepts', async () => {
    const be = make(undefined, { importBytes: 1000 });
    await expect(be.invoke('debug.openSession', { text: 'x'.repeat(1001) })).rejects.toThrow(/larger than/);
    await expect(be.invoke('debug.openSession', { base64: Buffer.alloc(2000).toString('base64') })).rejects.toThrow(/larger than/);
  });

  it('say when the trust of the root certificate is not known (a failing tool is not "no")', async () => {
    const be = make();
    setCertificateTestHooks({ platform: 'win32', run: async () => Promise.reject(new Error('certutil: busy')) });
    const info = (await be.invoke('debug.certificate', {})) as { trusted?: boolean; known: boolean };
    expect(info.known).toBe(false);
    expect(info.trusted).toBeUndefined();
  });
});
