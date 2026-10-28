import { execFileChecked } from '../net/process.js';
import { connect } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite, PRIVATE_FILE_MODE } from '../storage/fsutil.js';

/**
 * The system proxy, switched to the Debugger's address and back (planning/review-2026-10-27-robustness.md, the proxy that
 * outlives TestPion). The setting is the operating system's, so it survives the app: a crash, a kill or a power cut while
 * capturing would leave every program on the computer pointing at a port nobody listens on. Therefore:
 *
 *  - what the setting was is written to a private file BEFORE the setting is changed, and deleted only after it was put back;
 *  - at startup `repairSystemProxy` reads that file: when the live setting still points at the address TestPion set (and
 *    nothing answers there) the old setting is restored;
 *  - TestPion's own address is never taken for "what it was before" (a second switch, a restart after a crash).
 */

/** What the system proxy was before TestPion changed it, so it can be put back exactly. */
export interface SystemProxySnapshot {
  platform: NodeJS.Platform;
  /** Windows: the Internet Settings values. */
  win?: { enable: number; server: string; override: string };
  /** macOS: per network service, the web and secure web proxy lines of networksetup. */
  mac?: Array<{ service: string; web: string; secure: string }>;
  /** GNOME: the mode and the manual hosts. */
  gnome?: { mode: string; httpHost: string; httpPort: string; httpsHost: string; httpsPort: string };
  /** The stand-in used by tests (TESTPION_FAKE_SYSTEM_PROXY): the proxy URL, '' = none. */
  fake?: string;
}

type Run = (cmd: string, args: string[], timeout?: number) => Promise<string>;

const defaultRun: Run = (cmd, args, timeout = 8000) =>
  new Promise<string>((resolve, reject) => {
    execFileChecked(`program ${cmd}`, cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out))));
  });

let hooks: { run?: Run; platform?: NodeJS.Platform; listening?: (port: number) => Promise<boolean>; alive?: (pid: number) => boolean } = {}; // bounded: one object; only tests set it
/** For tests: a scripted `run`, a platform, and stand-ins for "does anything listen on this port" / "is this process alive". No argument restores. */
export function setSystemProxyTestHooks(h: typeof hooks = {}): void {
  hooks = h;
}
const run: Run = (cmd, args, timeout) => (hooks.run ?? defaultRun)(cmd, args, timeout);
const plat = () => hooks.platform ?? process.platform;

/** `<-loopback>`: localhost and 127.0.0.1 go through the proxy too (the default `<local>` skips them, so a local site would not show). */
export const WIN_PROXY_OVERRIDE = '<-loopback>';
const WIN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const ps = (script: string) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);

const hostPortOf = (proxyUrl: string) => {
  const u = new URL(proxyUrl);
  return { host: u.hostname, port: Number(u.port) || 80, hostPort: `${u.hostname}:${u.port || 80}` };
};

/** Tell WinINET the settings changed (browsers and .NET read the registry again); part of the same script as the change, so it is one program start. */
const WIN_REFRESH =
  `try { $sig = '[DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr h, int opt, IntPtr buf, int len);'; $w = Add-Type -MemberDefinition $sig -Name WinInet -Namespace TestPion -PassThru; [void]$w::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0); [void]$w::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) } catch { }`;

/* ------------------------------------------------------------------ reading */

/** The stand-in for the system proxy while TESTPION_FAKE_SYSTEM_PROXY is set; '' = none. Tests read it with `fakeSystemProxyValue`. */
let fakeSystemProxy = ''; // bounded: one string
export const fakeSystemProxyValue = () => fakeSystemProxy;
/** For tests: set the stand-in directly (what another program or a crash left behind). */
export const setFakeSystemProxyValue = (v: string) => {
  fakeSystemProxy = v;
};
const fakeOn = () => !!process.env.TESTPION_FAKE_SYSTEM_PROXY;

export async function readSystemProxy(): Promise<SystemProxySnapshot> {
  if (fakeOn()) return { platform: 'fake' as NodeJS.Platform, fake: fakeSystemProxy };
  const platform = plat();
  if (platform === 'win32') {
    const out = await ps(`$p = Get-ItemProperty -Path '${WIN_KEY}'; @{ enable = [int]$p.ProxyEnable; server = [string]$p.ProxyServer; override = [string]$p.ProxyOverride } | ConvertTo-Json -Compress`);
    const v = JSON.parse(out) as { enable: number; server: string; override: string };
    return { platform: 'win32', win: { enable: v.enable ?? 0, server: v.server ?? '', override: v.override ?? '' } };
  }
  if (platform === 'darwin') {
    const services = (await run('networksetup', ['-listallnetworkservices']))
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('*') && !/An asterisk/.test(s));
    const mac: NonNullable<SystemProxySnapshot['mac']> = [];
    for (const service of services)
      mac.push({ service, web: await run('networksetup', ['-getwebproxy', service]).catch(() => ''), secure: await run('networksetup', ['-getsecurewebproxy', service]).catch(() => '') });
    return { platform: 'darwin', mac };
  }
  const g = async (k: string) => (await run('gsettings', ['get', k.includes('.') ? k.split(' ')[0]! : 'org.gnome.system.proxy', k.split(' ')[1] ?? k]).catch(() => '')).trim().replace(/^'|'$/g, '');
  return {
    platform,
    gnome: {
      mode: await g('org.gnome.system.proxy mode'),
      httpHost: await g('org.gnome.system.proxy.http host'),
      httpPort: await g('org.gnome.system.proxy.http port'),
      httpsHost: await g('org.gnome.system.proxy.https host'),
      httpsPort: await g('org.gnome.system.proxy.https port'),
    },
  };
}

const macParse = (text: string) => ({
  on: /Enabled:\s*Yes/i.test(text),
  host: /Server:\s*(\S*)/.exec(text)?.[1] ?? '',
  port: /Port:\s*(\d+)/.exec(text)?.[1] ?? '0',
});

/** The `host:port` addresses a setting sends through (empty when the proxy is off). */
export function systemProxyTargets(s: SystemProxySnapshot): string[] {
  const out: string[] = [];
  if (s.fake !== undefined && (s.platform as string) === 'fake') {
    if (s.fake)
      try {
        out.push(hostPortOf(s.fake).hostPort);
      } catch {
        /* not a URL: nothing */
      }
  } else if (s.win) {
    if (s.win.enable)
      for (const part of s.win.server.split(';')) {
        const v = part
          .trim()
          .replace(/^[a-z]+=/i, '')
          .replace(/^[a-z]+:\/\//i, '');
        if (v) out.push(v.toLowerCase());
      }
  } else if (s.mac) {
    for (const m of s.mac)
      for (const t of [macParse(m.web), macParse(m.secure)]) if (t.on && t.host) out.push(`${t.host}:${t.port}`.toLowerCase());
  } else if (s.gnome && s.gnome.mode === 'manual') {
    if (s.gnome.httpHost) out.push(`${s.gnome.httpHost}:${s.gnome.httpPort}`.toLowerCase());
    if (s.gnome.httpsHost) out.push(`${s.gnome.httpsHost}:${s.gnome.httpsPort}`.toLowerCase());
  }
  return out;
}

const isLoopback = (hp: string) => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(hp.toLowerCase());
/** Does the setting send through any of these addresses? */
export const systemProxyPointsAt = (s: SystemProxySnapshot, addresses: string[]): boolean => {
  const mine = new Set(addresses.map((a) => a.toLowerCase()));
  return systemProxyTargets(s).some((t) => mine.has(t));
};

/** The setting with no proxy, in the shape of this one (what "before" means when the live setting is already ours). */
function noProxyLike(s: SystemProxySnapshot): SystemProxySnapshot {
  if (s.fake !== undefined && (s.platform as string) === 'fake') return { ...s, fake: '' };
  if (s.win) return { ...s, win: { enable: 0, server: '', override: s.win.override === WIN_PROXY_OVERRIDE ? '' : s.win.override } };
  if (s.mac) return { ...s, mac: s.mac.map((m) => ({ service: m.service, web: '', secure: '' })) };
  if (s.gnome) return { ...s, gnome: { mode: 'none', httpHost: '', httpPort: '0', httpsHost: '', httpsPort: '0' } };
  return s;
}

/* ------------------------------------------------------------------ changing */

/** Point the setting at `proxyUrl` (`before` names the services on macOS). Throws; the caller undoes what was set. */
async function applySystemProxy(proxyUrl: string, before: SystemProxySnapshot): Promise<void> {
  if (fakeOn()) {
    fakeSystemProxy = proxyUrl;
    return;
  }
  const { host, port, hostPort } = hostPortOf(proxyUrl);
  try {
    const platform = plat();
    if (platform === 'win32') {
      await ps(
        `Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyEnable -Value 1 -Type DWord; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyServer -Value '${hostPort}' -Type String; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyOverride -Value '${WIN_PROXY_OVERRIDE}' -Type String; ${WIN_REFRESH}`,
      );
    } else if (platform === 'darwin') {
      for (const s of before.mac ?? []) {
        await run('networksetup', ['-setwebproxy', s.service, host, String(port)]);
        await run('networksetup', ['-setsecurewebproxy', s.service, host, String(port)]);
      }
    } else {
      await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', host]);
      await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', String(port)]);
      await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', host]);
      await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', String(port)]);
      await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', "'manual'"]);
    }
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not set the system proxy: ${(e as Error).message}`, {
      suggestions: ['Set it by hand in the OS network settings: HTTP and HTTPS proxy ' + hostPort + '.', 'Or start a browser or a terminal from here instead; they need no system change.'],
    });
  }
}

/** Put the system proxy back as it was. */
export async function restoreSystemProxy(s: SystemProxySnapshot): Promise<void> {
  if ((s.platform as string) === 'fake') {
    fakeSystemProxy = s.fake ?? '';
    return;
  }
  if (s.win) {
    await ps(
      `Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyEnable -Value ${s.win.enable ? 1 : 0} -Type DWord; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyServer -Value '${s.win.server.replace(/'/g, "''")}' -Type String; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyOverride -Value '${s.win.override.replace(/'/g, "''")}' -Type String; ${WIN_REFRESH}`,
    );
  } else if (s.mac) {
    // every service is tried; the first failure is reported after the others were put back
    let failure: Error | undefined;
    for (const m of s.mac) {
      const w = macParse(m.web);
      const sec = macParse(m.secure);
      try {
        if (w.on && w.host) await run('networksetup', ['-setwebproxy', m.service, w.host, w.port]);
        else await run('networksetup', ['-setwebproxystate', m.service, 'off']);
        if (sec.on && sec.host) await run('networksetup', ['-setsecurewebproxy', m.service, sec.host, sec.port]);
        else await run('networksetup', ['-setsecurewebproxystate', m.service, 'off']);
      } catch (e) {
        failure ??= e as Error;
      }
    }
    if (failure) throw failure;
  } else if (s.gnome) {
    await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', s.gnome.httpHost]);
    await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', s.gnome.httpPort || '0']);
    await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', s.gnome.httpsHost]);
    await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', s.gnome.httpsPort || '0']);
    await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', `'${s.gnome.mode || 'none'}'`]);
  }
}

/* ------------------------------------------------------------------ the record on disk */

/** What is kept on disk while the setting is ours: the setting as it was, the address set, who set it and when. */
export interface SystemProxyRecord {
  v: 1;
  before: SystemProxySnapshot;
  /** The `host:port` TestPion pointed the system proxy at. */
  ours: string;
  pid: number;
  at: string;
}

const RECORD_FILE = 'system-proxy.json';
export const systemProxyRecordPath = (dir: string) => join(dir, RECORD_FILE);

/** The record in `dir`, or undefined when there is none or it cannot be read (a damaged file counts as none). */
export function readSystemProxyRecord(dir: string): SystemProxyRecord | undefined {
  try {
    const f = systemProxyRecordPath(dir);
    if (!existsSync(f)) return undefined;
    const r = JSON.parse(readFileSync(f, 'utf8')) as Partial<SystemProxyRecord>;
    if (r?.v !== 1 || typeof r.ours !== 'string' || !r.before || typeof r.before !== 'object') return undefined;
    return r as SystemProxyRecord;
  } catch {
    return undefined;
  }
}

const writeRecord = (dir: string, r: SystemProxyRecord) => atomicWrite(systemProxyRecordPath(dir), JSON.stringify(r), { mode: PRIVATE_FILE_MODE });
const dropRecord = (dir: string) => rmSync(systemProxyRecordPath(dir), { force: true });

/**
 * Point the system proxy at `proxyUrl` and return the setting to put back. The setting is written to `dir` first. With
 * `keep` (the proxy moved to another port) the same "before" is kept and only the address is changed.
 */
export async function engageSystemProxy(dir: string, proxyUrl: string, keep?: SystemProxySnapshot): Promise<SystemProxySnapshot> {
  const ours = hostPortOf(proxyUrl).hostPort;
  let before = keep;
  if (!before) {
    const live = await readSystemProxy();
    const rec = readSystemProxyRecord(dir);
    const recAddresses = rec ? [rec.ours] : [];
    // the live setting is already ours (a crash left it, or a second switch): what it was before is in the record, else it was none
    if (systemProxyPointsAt(live, [ours, ...recAddresses])) before = rec?.before ?? noProxyLike(live);
    else before = live;
  }
  writeRecord(dir, { v: 1, before, ours, pid: process.pid, at: new Date().toISOString() });
  try {
    await applySystemProxy(proxyUrl, before);
  } catch (e) {
    // part of it may be set (macOS: some services; GNOME: some keys): undo, and keep the record until the undo worked
    try {
      await restoreSystemProxy(before);
      dropRecord(dir);
    } catch {
      /* the record stays: the next start repairs it */
    }
    throw e;
  }
  return before;
}

/** Put the system proxy back and delete the record; when putting it back fails the record stays (the next start tries again) and the error is thrown. */
export async function disengageSystemProxy(dir: string, before: SystemProxySnapshot): Promise<void> {
  await restoreSystemProxy(before);
  dropRecord(dir);
}

const listeningDefault = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => (s.destroy(), resolve(v));
    s.setTimeout(500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
const aliveDefault = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * At startup: a record on disk means TestPion changed the setting and did not put it back. When the live setting still
 * points at the address it set and nothing answers there (or the process that set it is gone), the old setting is
 * restored. `restored`: put back; `cleared`: the setting had been changed since (nothing to restore), the record is gone;
 * `skipped`: another running TestPion owns it; `none`: no record.
 */
export async function repairSystemProxy(dir: string): Promise<'none' | 'restored' | 'cleared' | 'skipped'> {
  const rec = readSystemProxyRecord(dir);
  if (!rec) {
    if (existsSync(systemProxyRecordPath(dir))) dropRecord(dir); // unreadable: nothing to restore from
    return 'none';
  }
  const live = await readSystemProxy();
  if (!systemProxyPointsAt(live, [rec.ours])) {
    dropRecord(dir);
    return 'cleared';
  }
  const port = Number(rec.ours.slice(rec.ours.lastIndexOf(':') + 1));
  // a TestPion that is running and listening there is using it: leave it alone
  if (isLoopback(rec.ours) && (hooks.alive ?? aliveDefault)(rec.pid) && (await (hooks.listening ?? listeningDefault)(port))) return 'skipped';
  await disengageSystemProxy(dir, rec.before);
  return 'restored';
}
