import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  disengageSystemProxy,
  engageSystemProxy,
  fakeSystemProxyValue,
  readSystemProxyRecord,
  repairSystemProxy,
  setFakeSystemProxyValue,
  setSystemProxyTestHooks,
  systemProxyRecordPath,
  systemProxyTargets,
} from '../../packages/core/src/debugger/system-proxy.js';

// The system proxy must not outlive TestPion: what it was is written to disk BEFORE the setting changes, a start of the app puts
// it back when it still points at us, our own address is never taken for "what it was", and a part-way macOS change is undone.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-sysproxy-'));
});
afterEach(() => {
  setSystemProxyTestHooks();
  delete process.env.TESTPION_FAKE_SYSTEM_PROXY;
  setFakeSystemProxyValue('');
  rmSync(dir, { recursive: true, force: true });
});

/** A macOS with two network services, as networksetup shows them; `fail` makes one command fail. */
function fakeMac(fail?: (args: string[]) => boolean) {
  const svc: Record<string, { web: string; secure: string }> = { 'Wi-Fi': { web: '', secure: '' }, Ethernet: { web: '', secure: '' } };
  const log: string[] = [];
  const show = (v: string) => (v ? `Enabled: Yes\nServer: ${v.split(':')[0]}\nPort: ${v.split(':')[1]}\n` : 'Enabled: No\nServer: \nPort: 0\n');
  const run = async (cmd: string, args: string[]) => {
    log.push(`${cmd} ${args.join(' ')}`);
    if (fail?.(args)) throw new Error('networksetup failed');
    const [verb, name, host, port] = args;
    if (verb === '-listallnetworkservices') return `An asterisk (*) denotes that a network service is disabled.\n${Object.keys(svc).join('\n')}\n`;
    if (verb === '-getwebproxy') return show(svc[name!]!.web);
    if (verb === '-getsecurewebproxy') return show(svc[name!]!.secure);
    if (verb === '-setwebproxy') svc[name!]!.web = `${host}:${port}`;
    if (verb === '-setsecurewebproxy') svc[name!]!.secure = `${host}:${port}`;
    if (verb === '-setwebproxystate') svc[name!]!.web = '';
    if (verb === '-setsecurewebproxystate') svc[name!]!.secure = '';
    return '';
  };
  return { svc, log, run };
}

describe('system proxy: the setting is kept on disk before it changes', () => {
  it('writes the record (private, with the old setting) before the first service is changed', async () => {
    const mac = fakeMac();
    mac.svc['Wi-Fi']!.web = 'corp.example:3128';
    let seenBeforeSet: unknown;
    setSystemProxyTestHooks({
      platform: 'darwin',
      run: async (cmd, args) => {
        if (args[0] === '-setwebproxy' && !seenBeforeSet) seenBeforeSet = readSystemProxyRecord(dir);
        return mac.run(cmd, args);
      },
    });
    const before = await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    expect(seenBeforeSet).toMatchObject({ v: 1, ours: '127.0.0.1:8123', pid: process.pid });
    expect((seenBeforeSet as { before: { mac: Array<{ service: string; web: string }> } }).before.mac[0]).toMatchObject({ service: 'Wi-Fi' });
    expect(systemProxyTargets({ platform: 'darwin', mac: before.mac })).toEqual(['corp.example:3128']);
    expect(mac.svc['Wi-Fi']!.web).toBe('127.0.0.1:8123');
    await disengageSystemProxy(dir, before);
    expect(mac.svc['Wi-Fi']!.web).toBe('corp.example:3128');
    expect(mac.svc.Ethernet!.web).toBe('');
    expect(existsSync(systemProxyRecordPath(dir))).toBe(false); // deleted only after it was put back
  });

  it('keeps the record when putting the setting back fails, and the next start retries', async () => {
    process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
    setFakeSystemProxyValue('http://corp.example:3128');
    const before = await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    expect(fakeSystemProxyValue()).toBe('http://127.0.0.1:8123');
    // a restore that fails: the platform tools are broken
    delete process.env.TESTPION_FAKE_SYSTEM_PROXY;
    setSystemProxyTestHooks({
      platform: 'darwin',
      run: async () => {
        throw new Error('no networksetup');
      },
    });
    await expect(disengageSystemProxy(dir, { platform: 'darwin', mac: [{ service: 'Wi-Fi', web: '', secure: '' }] })).rejects.toThrow();
    expect(existsSync(systemProxyRecordPath(dir))).toBe(true);
    expect(before.fake).toBe('http://corp.example:3128');
  });
});

describe('system proxy: repair at startup', () => {
  beforeEach(() => {
    process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
  });

  it('a crash left the setting pointing at us: the next start puts the old one back and deletes the record', async () => {
    setFakeSystemProxyValue('http://corp.example:3128');
    await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    // (the process died here: no disengage)
    setSystemProxyTestHooks({ alive: () => false, listening: async () => false });
    expect(await repairSystemProxy(dir)).toBe('restored');
    expect(fakeSystemProxyValue()).toBe('http://corp.example:3128');
    expect(existsSync(systemProxyRecordPath(dir))).toBe(false);
    expect(await repairSystemProxy(dir)).toBe('none');
  });

  it('a no-proxy computer goes back to no proxy', async () => {
    await engageSystemProxy(dir, 'http://127.0.0.1:8899');
    setSystemProxyTestHooks({ alive: () => false, listening: async () => false });
    expect(await repairSystemProxy(dir)).toBe('restored');
    expect(fakeSystemProxyValue()).toBe('');
  });

  it('the setting was changed since (the user, another program): it is left alone and the record goes', async () => {
    await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    setFakeSystemProxyValue('http://other.example:8080');
    setSystemProxyTestHooks({ alive: () => false, listening: async () => false });
    expect(await repairSystemProxy(dir)).toBe('cleared');
    expect(fakeSystemProxyValue()).toBe('http://other.example:8080');
    expect(existsSync(systemProxyRecordPath(dir))).toBe(false);
  });

  it('another TestPion that is running and listening there keeps its setting', async () => {
    await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    setSystemProxyTestHooks({ alive: () => true, listening: async (port) => port === 8123 });
    expect(await repairSystemProxy(dir)).toBe('skipped');
    expect(fakeSystemProxyValue()).toBe('http://127.0.0.1:8123');
    expect(existsSync(systemProxyRecordPath(dir))).toBe(true);
  });

  it('a record that cannot be read is dropped, not trusted', async () => {
    writeFileSync(systemProxyRecordPath(dir), '{ not json');
    expect(await repairSystemProxy(dir)).toBe('none');
    expect(existsSync(systemProxyRecordPath(dir))).toBe(false);
  });
});

describe('system proxy: our own address is never "what it was"', () => {
  it('switching twice (or after a crash) keeps the first setting as the one to restore', async () => {
    process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
    setFakeSystemProxyValue('http://corp.example:3128');
    await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    // a restart after a crash on another port: the live setting is ours
    const again = await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    expect(again.fake).toBe('http://corp.example:3128');
    expect(readSystemProxyRecord(dir)!.before.fake).toBe('http://corp.example:3128');
    await disengageSystemProxy(dir, again);
    expect(fakeSystemProxyValue()).toBe('http://corp.example:3128');
  });

  it('with no record and the live setting already ours, it was none', async () => {
    process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
    setFakeSystemProxyValue('http://127.0.0.1:8123');
    const before = await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    expect(before.fake).toBe('');
  });

  it('the proxy moved to another port: the same "before" is kept and the system follows', async () => {
    process.env.TESTPION_FAKE_SYSTEM_PROXY = '1';
    setFakeSystemProxyValue('http://corp.example:3128');
    const before = await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    const kept = await engageSystemProxy(dir, 'http://127.0.0.1:9001', before);
    expect(fakeSystemProxyValue()).toBe('http://127.0.0.1:9001');
    expect(kept.fake).toBe('http://corp.example:3128');
    expect(readSystemProxyRecord(dir)).toMatchObject({ ours: '127.0.0.1:9001' });
    // and a repair after a crash now looks for the new port
    setSystemProxyTestHooks({ alive: () => false, listening: async () => false });
    expect(await repairSystemProxy(dir)).toBe('restored');
    expect(fakeSystemProxyValue()).toBe('http://corp.example:3128');
  });
});

describe('system proxy: a part-way macOS change is undone', () => {
  it('the second service fails: the first is put back and the record goes', async () => {
    const mac = fakeMac((args) => args[0] === '-setwebproxy' && args[1] === 'Ethernet');
    setSystemProxyTestHooks({ platform: 'darwin', run: mac.run });
    await expect(engageSystemProxy(dir, 'http://127.0.0.1:8123')).rejects.toThrow(/Could not set the system proxy/);
    expect(mac.svc['Wi-Fi']).toEqual({ web: '', secure: '' });
    expect(existsSync(systemProxyRecordPath(dir))).toBe(false);
  });

  it('the undo fails too: the record stays so the next start repairs it', async () => {
    let broken = false;
    const mac = fakeMac((args) => broken && /state|^-set/.test(args[0]!));
    setSystemProxyTestHooks({
      platform: 'darwin',
      run: async (cmd, args) => {
        if (args[0] === '-setwebproxy' && args[1] === 'Ethernet') broken = true; // from here every change fails
        return mac.run(cmd, args);
      },
    });
    await expect(engageSystemProxy(dir, 'http://127.0.0.1:8123')).rejects.toThrow();
    expect(existsSync(systemProxyRecordPath(dir))).toBe(true);
    expect(mac.svc['Wi-Fi']!.web).toBe('127.0.0.1:8123');
    // the next start (tools working again) puts it back
    broken = false;
    setSystemProxyTestHooks({ platform: 'darwin', run: mac.run, alive: () => false, listening: async () => false });
    expect(await repairSystemProxy(dir)).toBe('restored');
    expect(mac.svc['Wi-Fi']!.web).toBe('');
  });
});

describe('system proxy: Windows', () => {
  it('reads and changes the Internet Settings in one program start each (the change tells WinINET in the same script)', async () => {
    const calls: string[] = [];
    let server = '';
    let enable = 0;
    setSystemProxyTestHooks({
      platform: 'win32',
      run: async (_cmd, args) => {
        const script = args[args.length - 1]!;
        calls.push(script);
        if (script.startsWith('$p = Get-ItemProperty')) return JSON.stringify({ enable, server, override: '' });
        enable = /ProxyEnable -Value (\d)/.exec(script)![1] === '1' ? 1 : 0;
        server = /ProxyServer -Value '([^']*)'/.exec(script)![1]!;
        return '';
      },
    });
    const before = await engageSystemProxy(dir, 'http://127.0.0.1:8123');
    expect(before.win).toEqual({ enable: 0, server: '', override: '' });
    expect(server).toBe('127.0.0.1:8123');
    expect(calls.filter((c) => /InternetSetOption/.test(c))).toHaveLength(1);
    expect(calls).toHaveLength(2); // one read, one change
    // the live setting in a per-protocol form still counts as ours
    expect(systemProxyTargets({ platform: 'win32', win: { enable: 1, server: 'http=127.0.0.1:8123;https=127.0.0.1:8123', override: '' } })).toEqual(['127.0.0.1:8123', '127.0.0.1:8123']);
    await disengageSystemProxy(dir, before);
    expect(enable).toBe(0);
  });
});
