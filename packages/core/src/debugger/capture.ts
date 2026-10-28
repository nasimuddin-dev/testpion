import { spawnChecked } from '../net/process.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApsError } from '../errors.js';

/**
 * Capture helpers of the HTTP Debugger (planning/http-debugger.md, DBG-2): the ways a program ends up sending through
 * the proxy without the user editing settings by hand: a browser started with the proxy and a throw-away profile, a
 * terminal with HTTP_PROXY set and the lines to paste in an existing shell (the system proxy is in system-proxy.ts).
 * Everything here is best effort per platform; a failure is an ApsError with what to do by hand.
 */

const hostPort = (proxyUrl: string) => {
  const u = new URL(proxyUrl);
  return { host: u.hostname, port: Number(u.port) || 80, hostPort: `${u.hostname}:${u.port || 80}` };
};

/* ------------------------------------------------------------------ shell lines */

/** The variables programs read to trust one more root certificate (the Debugger's, when it decrypts HTTPS). */
export const CA_VARIABLES = ['NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE'] as const;

const sh = (v: string) => `'${v.split("'").join("'\\''")}'`;
/** Text inside an AppleScript string literal. */
const asScript = (v: string) => v.split('\\').join('\\\\').split('"').join('\\"');
const psq = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** The environment of a shell that sends through the proxy, and trusts the root certificate at `caPath` when given. */
export function proxyEnvironment(proxyUrl: string, caPath?: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    ...(caPath ? Object.fromEntries(CA_VARIABLES.map((k) => [k, caPath])) : {}),
  };
}

/**
 * The lines that make a shell send through the proxy; one set per shell, for copying. With `caPath` (HTTPS is decrypted)
 * they also point the usual CA variables at the root certificate, and curl gets `--cacert`.
 */
export function proxyShellLines(proxyUrl: string, caPath?: string): Array<{ shell: string; lines: string }> {
  return [
    { shell: 'bash / zsh', lines: `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NO_PROXY=${caPath ? ` ${CA_VARIABLES.map((k) => `${k}=${sh(caPath)}`).join(' ')}` : ''}` },
    {
      shell: 'PowerShell',
      lines: `$env:HTTP_PROXY = '${proxyUrl}'; $env:HTTPS_PROXY = '${proxyUrl}'; $env:NO_PROXY = ''${caPath ? `; ${CA_VARIABLES.map((k) => `$env:${k} = ${psq(caPath)}`).join('; ')}` : ''}`,
    },
    {
      shell: 'cmd',
      lines: `set HTTP_PROXY=${proxyUrl} && set HTTPS_PROXY=${proxyUrl} && set NO_PROXY=${caPath ? ` && ${CA_VARIABLES.map((k) => `set "${k}=${caPath}"`).join(' && ')}` : ''}`,
    },
    { shell: 'curl', lines: `curl -x ${proxyUrl}${caPath ? ` --cacert ${sh(caPath)}` : ''} https://example.com/` },
    { shell: 'Chrome / Edge', lines: `--proxy-server=${proxyUrl}` },
  ];
}

/* ------------------------------------------------------------------ a browser with the proxy */

export type BrowserName = 'chrome' | 'edge' | 'chromium' | 'firefox' | 'brave' | 'safari';

/**
 * A browser found on this computer. `systemProxy`: it has no proxy of its own (Safari always follows the macOS system
 * proxy), so opening it through TestPion means pointing the system proxy here first, and every program that honours
 * the system proxy is captured with it until capturing stops.
 */
interface InstalledBrowser {
  name: BrowserName;
  label: string;
  path: string;
  systemProxy?: boolean;
}

/**
 * The page a browser opens with: http or https only. A value that starts with `-` would be read by the browser as one of
 * its own switches (--gpu-launcher=…, --renderer-cmd-prefix=…), a file: or javascript: address opens something that is not capture.
 */
export function checkStartUrl(url: string): string {
  const u = String(url ?? '').trim();
  let ok = false;
  try {
    ok = !u.startsWith('-') && /^https?:$/.test(new URL(u).protocol);
  } catch {
    /* not an address */
  }
  if (!ok) throw new ApsError('ValidationError', 'The start page must be an http:// or https:// address', { suggestions: ['For example https://example.com/'] });
  return u;
}

/** The browsers installed on this computer that can be opened through the proxy, best effort. */
export function installedBrowsers(): InstalledBrowser[] {
  const candidates: Array<{ name: BrowserName; label: string; paths: string[]; systemProxy?: boolean }> =
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
            { name: 'safari', label: 'Safari', paths: ['/Applications/Safari.app', '/System/Applications/Safari.app'], systemProxy: true },
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
    return path ? [{ name: c.name, label: c.label, path, ...(c.systemProxy ? { systemProxy: true } : {}) }] : [];
  });
}

/**
 * What a browser is started with to send through the proxy: its switches, and for Firefox the preferences of its profile.
 * HTTP/3 (QUIC) goes over UDP and bypasses an HTTP proxy, so it is turned off (FG-27): the traffic then falls back to HTTP/2 or 1.1 and shows up.
 */
export function browserLaunch(name: BrowserName, proxyUrl: string, profileDir: string, startUrl: string): { args: string[]; userJs?: string } {
  if (name === 'firefox') {
    const { host, port } = hostPort(proxyUrl);
    const userJs = [
      'user_pref("network.proxy.type", 1);',
      `user_pref("network.proxy.http", "${host}");`,
      `user_pref("network.proxy.http_port", ${port});`,
      `user_pref("network.proxy.ssl", "${host}");`,
      `user_pref("network.proxy.ssl_port", ${port});`,
      'user_pref("network.proxy.no_proxies_on", "");',
      'user_pref("network.proxy.allow_hijacking_localhost", true);',
      'user_pref("network.http.http3.enable", false);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
    ].join('\n');
    return { args: ['-profile', profileDir, '-no-remote', startUrl], userJs };
  }
  return { args: [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', startUrl] };
}

/**
 * Start a browser that sends through the proxy, with a profile of its own (your real profile, cookies and extensions
 * stay out of it). Chromium browsers take `--proxy-server` (and `--disable-quic`); Firefox takes a profile folder with the proxy in user.js (and HTTP/3 off).
 * Safari has neither: it is opened as it is, and it sends through TestPion only while the system proxy points here
 * (the caller sets it first; `systemProxy` in the answer says so).
 */
export function openBrowserWithProxy(proxyUrl: string, browser?: BrowserName, startUrl = 'http://neverssl.com/'): { browser: string; profileDir: string; systemProxy?: boolean } {
  startUrl = checkStartUrl(startUrl);
  const all = installedBrowsers();
  const b = browser ? all.find((x) => x.name === browser) : all[0];
  if (!b)
    throw new ApsError('ConfigurationError', browser ? `${browser} is not installed where TestPion looks for it` : 'No browser found', {
      suggestions: ['Start your browser by hand with --proxy-server=' + proxyUrl + ' (Chromium browsers) or set the proxy in its settings.'],
    });
  if (b.systemProxy) {
    const child = spawnChecked('browser launch', 'open', ['-a', b.path, startUrl], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return { browser: b.label, profileDir: '', systemProxy: true };
  }
  const profileDir = join(tmpdir(), 'testpion-debugger', b.name);
  mkdirSync(profileDir, { recursive: true });
  const launch = browserLaunch(b.name, proxyUrl, profileDir, startUrl);
  if (launch.userJs) writeFileSync(join(profileDir, 'user.js'), launch.userJs);
  const args = launch.args;
  const child = spawnChecked('browser launch', b.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
  return { browser: b.label, profileDir };
}

/* ------------------------------------------------------------------ a terminal with the proxy */

/** Open a terminal window whose shell sends through the proxy (HTTP_PROXY / HTTPS_PROXY set); with `caPath` it also trusts the root certificate there (NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, SSL_CERT_FILE, CURL_CA_BUNDLE). */
export function openTerminalWithProxy(proxyUrl: string, caPath?: string): { terminal: string } {
  const env = { ...process.env, ...proxyEnvironment(proxyUrl, caPath) };
  const exportCa = caPath ? ` ${CA_VARIABLES.map((k) => `${k}=${sh(caPath)}`).join(' ')}` : '';
  const detach = (cmd: string, args: string[], label: string) => {
    const child = spawnChecked('terminal launch', cmd, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
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
    const script = `tell application "Terminal" to do script "export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NO_PROXY=${asScript(exportCa)}; echo 'TestPion HTTP Debugger: this shell sends through ${proxyUrl}'"`;
    return detach('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], 'Terminal');
  }
  const bash = `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NO_PROXY=${exportCa}; echo 'TestPion HTTP Debugger: this shell sends through ${proxyUrl}'; exec ${process.env.SHELL || 'bash'}`;
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
  throw new ApsError('ConfigurationError', 'No terminal emulator found', { suggestions: [`In a shell: export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl}${exportCa}`] });
}

