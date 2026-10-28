/** The Debugger for agents: capture options (system proxy, decrypt), the certificate, hosts kept encrypted, tunnels and the inspector data. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debuggerTools } from '../../packages/core/src/mcp-server/tools/debugger-tools';
import { CONFIRM_TOOLS } from '../../packages/core/src/mcp-server/tool-contract';
import { fakeSystemProxyValue } from '../../packages/core/src/debugger/system-proxy';
import { Redactor } from '../../packages/core/src/util/redact';
import type { DebuggerExchange } from '../../packages/core/src/debugger/proxy';

const certDir = mkdtempSync(join(tmpdir(), 'tp-agent-cert-'));
const before = { fake: process.env.TESTPION_FAKE_SYSTEM_PROXY, certs: process.env.TESTPION_DEBUGGER_CERTS };
beforeAll(() => {
  // never the real OS proxy or the user's certificate folder
  process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
  process.env.TESTPION_DEBUGGER_CERTS = certDir;
});
afterAll(() => {
  if (before.fake === undefined) delete process.env.TESTPION_FAKE_SYSTEM_PROXY;
  else process.env.TESTPION_FAKE_SYSTEM_PROXY = before.fake;
  if (before.certs === undefined) delete process.env.TESTPION_DEBUGGER_CERTS;
  else process.env.TESTPION_DEBUGGER_CERTS = before.certs;
  rmSync(certDir, { recursive: true, force: true, maxRetries: 3 });
});

const ex = (o: Partial<DebuggerExchange>): DebuggerExchange =>
  ({ id: 'e1', kind: 'http', method: 'GET', url: 'https://api.test/items?q=a%20b&page=2', host: 'api.test', requestHeaders: {}, requestBodyBytes: 0, responseBodyBytes: 0, startedAt: '', clientPort: 1, ...o }) as DebuggerExchange;

const tool = (session: DebuggerExchange[]) => {
  const tools = debuggerTools({ redactor: new Redactor(), session });
  const by = (name: string) => tools.find((t) => t.name === name)!;
  return { by, run: (name: string, args: Record<string, unknown>) => Promise.resolve(by(name).run(args)) as Promise<Record<string, unknown>> };
};

describe('debugger_capture with the system proxy', () => {
  it('points the proxy setting at the capture and puts it back on stop', async () => {
    const { run } = tool([]);
    const started = await run('debugger_capture', { action: 'start', system_proxy: true });
    expect(started.systemProxy).toBe(true);
    expect(fakeSystemProxyValue()).toBe(started.url);
    const stopped = await run('debugger_capture', { action: 'stop' });
    expect(stopped.systemProxy).toBe(false);
    expect(fakeSystemProxyValue()).toBe('');
  });

  it('a start without system_proxy leaves the setting alone', async () => {
    const { run } = tool([]);
    await run('debugger_capture', { action: 'start' });
    expect(fakeSystemProxyValue()).toBe('');
    await run('debugger_capture', { action: 'stop' });
  });

  it('asks the user before it touches the computer, and only then', () => {
    const c = CONFIRM_TOOLS.debugger_capture!;
    expect(c.when!({ action: 'start', system_proxy: true })).toBe(true);
    expect(c.when!({ action: 'start' })).toBe(false);
    expect(c.when!({ action: 'stop' })).toBe(false);
    expect(c.describe({})).toMatch(/proxy setting/);
  });
});

describe('debugger_certificate and debugger_no_decrypt', () => {
  it('install and remove ask the user, info does not', () => {
    const c = CONFIRM_TOOLS.debugger_certificate!;
    expect(c.when!({ action: 'info' })).toBe(false);
    expect(c.when!({ action: 'install' })).toBe(true);
    expect(c.when!({ action: 'remove' })).toBe(true);
    expect(c.describe({ action: 'install' })).toMatch(/trust store/);
  });

  it('info names the file and the fingerprint, and says whether the trust is known', async () => {
    const info = await tool([]).run('debugger_certificate', { action: 'info' });
    expect(String(info.path)).toContain(certDir);
    expect(String(info.fingerprint)).toMatch(/[0-9A-F]{2}/i);
    expect(typeof info.known).toBe('boolean');
    expect(info.known).toBe(info.trusted !== undefined);
    // an unknown or false trust comes with the steps
    if (info.trusted !== true) expect(Array.isArray(info.instructions)).toBe(true);
  }, 60_000);

  it('lists and sets the hosts kept encrypted', async () => {
    const { run } = tool([]);
    expect((await run('debugger_no_decrypt', { action: 'list' })).hosts).toEqual([]);
    expect((await run('debugger_no_decrypt', { action: 'set', hosts: [' *.bank.example ', '', 'login.example.com'] })).hosts).toEqual(['*.bank.example', 'login.example.com']);
    expect((await run('debugger_no_decrypt', { action: 'list' })).hosts).toEqual(['*.bank.example', 'login.example.com']);
  });
});

describe('debugger_exchanges: tunnels and the inspector data', () => {
  const session = [
    ex({ id: 'a', requestHeaders: { Cookie: 'sid=abc; theme=dark' }, responseHeaders: { 'set-cookie': 'sid=new; Path=/; HttpOnly' }, status: 404, statusText: 'Not Found' }),
    ex({ id: 't', kind: 'tunnel', method: 'CONNECT', url: 'https://secure.test:443', host: 'secure.test:443' }),
    ex({ id: 'f', method: 'POST', url: 'https://api.test/login', requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'user=ann&mode=a%26b', status: 200, application: 'curl', tls: true }),
  ];

  it('hide_tunnels leaves the CONNECT rows out', async () => {
    const { run } = tool(session);
    expect(((await run('debugger_exchanges', {})).exchanges as Array<{ id: string }>).map((e) => e.id)).toEqual(['a', 't', 'f']);
    expect(((await run('debugger_exchanges', { hide_tunnels: true })).exchanges as Array<{ id: string }>).map((e) => e.id)).toEqual(['a', 'f']);
  });

  it('include adds params, cookies, a summary and the advice for a failure', async () => {
    const { run } = tool(session);
    const r = (await run('debugger_exchanges', { hide_tunnels: true, include: ['params', 'cookies', 'summary'] })).exchanges as Array<Record<string, any>>;
    expect(r[0]!.params.query).toEqual({ q: 'a b', page: '2' });
    expect(r[0]!.cookies.request).toEqual(['sid', 'theme']);
    expect(r[0]!.cookies.response[0].name).toBe('sid');
    expect(r[0]!.advice[0]).toMatch(/path was not found/);
    expect(r[1]!.params.form).toEqual({ user: 'ann', mode: 'a&b' });
    expect(r[1]!.summary).toMatchObject({ protocol: 'HTTP/1.1', tls: 'decrypted', program: 'curl' });
    expect(r[1]!.advice).toBeUndefined();
    // without include there is nothing extra
    const plain = (await run('debugger_exchanges', {})).exchanges as Array<Record<string, unknown>>;
    expect(plain[0]!.params).toBeUndefined();
  });
});
