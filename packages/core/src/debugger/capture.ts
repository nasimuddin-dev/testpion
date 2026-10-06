import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApsError } from '../errors.js';

/**
 * Capture helpers of the HTTP Debugger (planning/http-debugger.md, DBG-2): the ways a program ends up sending through
 * the proxy without the user editing settings by hand: a browser started with the proxy and a throw-away profile, a
 * terminal with HTTP_PROXY set, the lines to paste in an existing shell, and the system proxy switched to ours and back.
 * Everything here is best effort per platform; a failure is an ApsError with what to do by hand.
 */

const run = (cmd: string, args: string[], timeout = 8000) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out))));
  });

const hostPort = (proxyUrl: string) => {
  const u = new URL(proxyUrl);
  return { host: u.hostname, port: Number(u.port) || 80, hostPort: `${u.hostname}:${u.port || 80}` };
};

/* ------------------------------------------------------------------ shell lines */

/** The lines that make a shell send through the proxy; one set per shell, for copying. */
export function proxyShellLines(proxyUrl: string): Array<{ shell: string; lines: string }> {
  return [
    { shell: 'bash / zsh', lines: `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NO_PROXY=` },
    { shell: 'PowerShell', lines: `$env:HTTP_PROXY = '${proxyUrl}'; $env:HTTPS_PROXY = '${proxyUrl}'; $env:NO_PROXY = ''` },
    { shell: 'cmd', lines: `set HTTP_PROXY=${proxyUrl} && set HTTPS_PROXY=${proxyUrl} && set NO_PROXY=` },
    { shell: 'curl', lines: `curl -x ${proxyUrl} https://example.com/` },
    { shell: 'Chrome / Edge', lines: `--proxy-server=${proxyUrl}` },
  ];
}

/* ------------------------------------------------------------------ a browser with the proxy */

export type BrowserName = 'chrome' | 'edge' | 'chromium' | 'firefox' | 'brave';

/** The browsers installed on this computer that can start with a proxy of their own, best effort. */
export function installedBrowsers(): Array<{ name: BrowserName; label: string; path: string }> {
  const candidates: Array<{ name: BrowserName; label: string; paths: string[] }> =
    process.platform === 'win32'
      ? [
          {
            name: 'chrome',
            label: 'Google Chrome',
            paths: [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
              join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
            ],
          },
          { name: 'edge', label: 'Microsoft Edge', paths: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'] },
          {
            name: 'brave',
            label: 'Brave',
            paths: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
          },
          { name: 'firefox', label: 'Firefox', paths: ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'] },
        ]
      : process.platform === 'darwin'
        ? [
            { name: 'chrome', label: 'Google Chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
            { name: 'edge', label: 'Microsoft Edge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
            { name: 'brave', label: 'Brave', paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] },
            { name: 'chromium', label: 'Chromium', paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
            { name: 'firefox', label: 'Firefox', paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
          ]
        : [
            { name: 'chrome', label: 'Google Chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'] },
            { name: 'chromium', label: 'Chromium', paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
            { name: 'edge', label: 'Microsoft Edge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
            { name: 'brave', label: 'Brave', paths: ['/usr/bin/brave-browser'] },
            { name: 'firefox', label: 'Firefox', paths: ['/usr/bin/firefox', '/snap/bin/firefox'] },
          ];
  return candidates.flatMap((c) => {
    const path = c.paths.find((p) => p && existsSync(p));
    return path ? [{ name: c.name, label: c.label, path }] : [];
  });
}

/**
 * Start a browser that sends through the proxy, with a profile of its own (your real profile, cookies and extensions
 * stay out of it). Chromium browsers take `--proxy-server`; Firefox takes a profile folder with the proxy in user.js.
 */
export function openBrowserWithProxy(proxyUrl: string, browser?: BrowserName, startUrl = 'http://neverssl.com/'): { browser: string; profileDir: string } {
  const all = installedBrowsers();
  const b = browser ? all.find((x) => x.name === browser) : all[0];
  if (!b)
    throw new ApsError('ConfigurationError', browser ? `${browser} is not installed where TestPion looks for it` : 'No browser found', {
      suggestions: ['Start your browser by hand with --proxy-server=' + proxyUrl + ' (Chromium browsers) or set the proxy in its settings.'],
    });
  const profileDir = join(tmpdir(), 'testpion-debugger', b.name);
  mkdirSync(profileDir, { recursive: true });
  let args: string[];
  if (b.name === 'firefox') {
    const { host, port } = hostPort(proxyUrl);
    writeFileSync(
      join(profileDir, 'user.js'),
      [
        'user_pref("network.proxy.type", 1);',
        `user_pref("network.proxy.http", "${host}");`,
        `user_pref("network.proxy.http_port", ${port});`,
        `user_pref("network.proxy.ssl", "${host}");`,
        `user_pref("network.proxy.ssl_port", ${port});`,
        'user_pref("network.proxy.no_proxies_on", "");',
        'user_pref("network.proxy.allow_hijacking_localhost", true);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
      ].join('\n'),
    );
    args = ['-profile', profileDir, '-no-remote', startUrl];
  } else {
    args = [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', startUrl];
  }
  const child = spawn(b.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
  return { browser: b.label, profileDir };
}

/* ------------------------------------------------------------------ a terminal with the proxy */

/** Open a terminal window whose shell sends through the proxy (HTTP_PROXY / HTTPS_PROXY set). */
export function openTerminalWithProxy(proxyUrl: string): { terminal: string } {
  const env = { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' };
  const detach = (cmd: string, args: string[], label: string) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.on('error', () => undefined);
    child.unref();
    return { terminal: label };
  };
  if (process.platform === 'win32') {
    const banner = `echo TestPion HTTP Debugger: this shell sends through ${proxyUrl}`;
    if (process.env.WT_SESSION || existsSync(join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\WindowsApps\\wt.exe')))
      return detach(
        'cmd.exe',
        ['/c', 'start', '', 'wt.exe', 'powershell.exe', '-NoExit', '-Command', `Write-Host 'TestPion HTTP Debugger: this shell sends through ${proxyUrl}'`],
        'Windows Terminal (PowerShell)',
      );
    return detach('cmd.exe', ['/c', 'start', 'TestPion HTTP Debugger', 'cmd.exe', '/k', banner], 'Command Prompt');
  }
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NO_PROXY=; echo 'TestPion HTTP Debugger: this shell sends through ${proxyUrl}'"`;
    return detach('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], 'Terminal');
  }
  const bash = `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NO_PROXY=; echo 'TestPion HTTP Debugger: this shell sends through ${proxyUrl}'; exec ${process.env.SHELL || 'bash'}`;
  for (const [cmd, args] of [
    ['x-terminal-emulator', ['-e', 'bash', '-c', bash]],
    ['gnome-terminal', ['--', 'bash', '-c', bash]],
    ['konsole', ['-e', 'bash', '-c', bash]],
    ['xterm', ['-e', 'bash', '-c', bash]],
  ] as Array<[string, string[]]>) {
    try {
      return detach(cmd, args, cmd);
    } catch {
      /* the next one */
    }
  }
  throw new ApsError('ConfigurationError', 'No terminal emulator found', { suggestions: [`In a shell: export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl}`] });
}

/* ------------------------------------------------------------------ the system proxy */

/** What the system proxy was before TestPion changed it, so it can be put back exactly. */
export interface SystemProxySnapshot {
  platform: NodeJS.Platform;
  /** Windows: the Internet Settings values. */
  win?: { enable: number; server: string; override: string };
  /** macOS: per network service, the web and secure web proxy lines of networksetup. */
  mac?: Array<{ service: string; web: string; secure: string }>;
  /** GNOME: the mode and the manual hosts. */
  gnome?: { mode: string; httpHost: string; httpPort: string; httpsHost: string; httpsPort: string };
}

const WIN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const ps = (script: string) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);

export async function readSystemProxy(): Promise<SystemProxySnapshot> {
  if (process.platform === 'win32') {
    const out = await ps(
      `$p = Get-ItemProperty -Path '${WIN_KEY}'; @{ enable = [int]$p.ProxyEnable; server = [string]$p.ProxyServer; override = [string]$p.ProxyOverride } | ConvertTo-Json -Compress`,
    );
    const v = JSON.parse(out) as { enable: number; server: string; override: string };
    return { platform: 'win32', win: { enable: v.enable ?? 0, server: v.server ?? '', override: v.override ?? '' } };
  }
  if (process.platform === 'darwin') {
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
    platform: process.platform,
    gnome: {
      mode: await g('org.gnome.system.proxy mode'),
      httpHost: await g('org.gnome.system.proxy.http host'),
      httpPort: await g('org.gnome.system.proxy.http port'),
      httpsHost: await g('org.gnome.system.proxy.https host'),
      httpsPort: await g('org.gnome.system.proxy.https port'),
    },
  };
}

/** Point the system proxy at ours (every program that honours it sends through TestPion); returns what to restore. */
export async function setSystemProxy(proxyUrl: string): Promise<SystemProxySnapshot> {
  const before = await readSystemProxy();
  const { host, port, hostPort: hp } = hostPort(proxyUrl);
  try {
    if (process.platform === 'win32') {
      await ps(
        `Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyEnable -Value 1 -Type DWord; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyServer -Value '${hp}' -Type String; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyOverride -Value '<local>' -Type String`,
      );
      await refreshWinInet();
    } else if (process.platform === 'darwin') {
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
      suggestions: ['Set it by hand in the OS network settings: HTTP and HTTPS proxy ' + hp + '.', 'Or start a browser or a terminal from here instead; they need no system change.'],
    });
  }
  return before;
}

/** Put the system proxy back as it was. */
export async function restoreSystemProxy(s: SystemProxySnapshot): Promise<void> {
  if (s.platform === 'win32' && s.win) {
    await ps(
      `Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyEnable -Value ${s.win.enable ? 1 : 0} -Type DWord; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyServer -Value '${s.win.server.replace(/'/g, "''")}' -Type String; Set-ItemProperty -Path '${WIN_KEY}' -Name ProxyOverride -Value '${s.win.override.replace(/'/g, "''")}' -Type String`,
    );
    await refreshWinInet();
  } else if (s.platform === 'darwin' && s.mac) {
    for (const m of s.mac) {
      const parse = (text: string) => {
        const on = /Enabled:\s*Yes/i.test(text);
        const host = /Server:\s*(\S*)/.exec(text)?.[1] ?? '';
        const port = /Port:\s*(\d+)/.exec(text)?.[1] ?? '0';
        return { on, host, port };
      };
      const w = parse(m.web);
      const sec = parse(m.secure);
      if (w.on && w.host) await run('networksetup', ['-setwebproxy', m.service, w.host, w.port]);
      else await run('networksetup', ['-setwebproxystate', m.service, 'off']);
      if (sec.on && sec.host) await run('networksetup', ['-setsecurewebproxy', m.service, sec.host, sec.port]);
      else await run('networksetup', ['-setsecurewebproxystate', m.service, 'off']);
    }
  } else if (s.gnome) {
    await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', s.gnome.httpHost]);
    await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', s.gnome.httpPort || '0']);
    await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', s.gnome.httpsHost]);
    await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', s.gnome.httpsPort || '0']);
    await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', `'${s.gnome.mode || 'none'}'`]);
  }
}

/** Tell WinINET the settings changed (browsers and .NET read the registry again). */
async function refreshWinInet(): Promise<void> {
  await ps(
    `$sig = '[DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr h, int opt, IntPtr buf, int len);'; $w = Add-Type -MemberDefinition $sig -Name WinInet -Namespace TestPion -PassThru; [void]$w::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0); [void]$w::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)`,
  ).catch(() => undefined);
}
