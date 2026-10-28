import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tp-sysproxy-'));

// the PowerShell the system proxy is switched with, seen through the one function every program start goes through
const calls: Array<{ file: string; args: string[] }> = [];
vi.mock('../../packages/core/src/net/process.js', async (orig) => ({
  ...(await orig<typeof import('../../packages/core/src/net/process.js')>()),
  execFileChecked: (_what: string, file: string, args: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
    calls.push({ file, args });
    const script = args[args.length - 1] ?? '';
    // reading the setting answers what it was before; every other script succeeds
    cb(null, /Get-ItemProperty/.test(script) ? JSON.stringify({ enable: 1, server: 'corp-proxy:3128', override: '<local>;*.corp' }) : '', '');
    return {} as never;
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const fake = process.env.TESTPION_FAKE_SYSTEM_PROXY;
beforeEach(() => {
  calls.length = 0;
  delete process.env.TESTPION_FAKE_SYSTEM_PROXY;
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => {
  rmSync(join(dir, 'system-proxy.json'), { force: true });
  Object.defineProperty(process, 'platform', platform);
  if (fake !== undefined) process.env.TESTPION_FAKE_SYSTEM_PROXY = fake;
});

const scripts = () => calls.filter((c) => c.file === 'powershell').map((c) => c.args[c.args.length - 1]!);

describe('system proxy capture on Windows', () => {
  it('points the proxy at the capture and sends localhost through it too (<-loopback>)', async () => {
    const { engageSystemProxy, WIN_PROXY_OVERRIDE } = await import('../../packages/core/src/debugger/system-proxy.js');
    expect(WIN_PROXY_OVERRIDE).toBe('<-loopback>');
    await engageSystemProxy(dir, 'http://127.0.0.1:8899');
    const set = scripts().find((s) => /Set-ItemProperty/.test(s))!;
    expect(set).toContain("-Name ProxyEnable -Value 1");
    expect(set).toContain("-Name ProxyServer -Value '127.0.0.1:8899'");
    expect(set).toContain("-Name ProxyOverride -Value '<-loopback>'");
    // the browsers are told the setting changed
    expect(scripts().some((s) => /InternetSetOption/.test(s))).toBe(true);
  });

  it('puts back exactly what was there: the corporate proxy and its bypass list', async () => {
    const { engageSystemProxy, restoreSystemProxy } = await import('../../packages/core/src/debugger/system-proxy.js');
    const snapshot = await engageSystemProxy(dir, 'http://127.0.0.1:8899');
    expect(snapshot.win).toEqual({ enable: 1, server: 'corp-proxy:3128', override: '<local>;*.corp' });
    calls.length = 0;
    await restoreSystemProxy(snapshot);
    const set = scripts().find((s) => /Set-ItemProperty/.test(s))!;
    expect(set).toContain("-Name ProxyEnable -Value 1");
    expect(set).toContain("-Name ProxyServer -Value 'corp-proxy:3128'");
    expect(set).toContain("-Name ProxyOverride -Value '<local>;*.corp'");
  });
});
