import { basename, extname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ApsError } from '../errors.js';
import { spawnChecked } from '../net/process.js';
import { proxyEnvironment } from './capture.js';

/**
 * Launch a program through the proxy (FG-14): the way to capture a program that does not follow the system proxy. It starts the
 * program with the switches and variables its runtime reads (HTTP_PROXY and the CA variables for most, JAVA_TOOL_OPTIONS for the
 * JVM, --proxy-server and no HTTP/3 for a Chromium browser, a throw-away profile for Firefox, DOTNET_* for .NET), and says what it
 * could not do (the Windows certificate store, the Java trust store). No driver and no administrator rights are needed; a program
 * that talks past every proxy setting is still not captured.
 */
export type LaunchKind = 'node' | 'python' | 'java' | 'dotnet' | 'curl' | 'chromium' | 'firefox' | 'other';
export const LAUNCH_KINDS: readonly LaunchKind[] = ['node', 'python', 'java', 'dotnet', 'curl', 'chromium', 'firefox', 'other'];

export interface LaunchPlan {
  kind: LaunchKind;
  command: string;
  args: string[];
  /** The variables added to this program's environment (the rest is inherited). */
  env: Record<string, string>;
  /** Files to write before the start (a Firefox profile's user.js), by path. */
  files: Record<string, string>;
  /** What this plan could not do, and what to do about it. */
  notes: string[];
}

/** Which runtime a command is, by its file name. */
export function kindOf(command: string): LaunchKind {
  const name = basename(command).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (/^(node|nodejs|npm|npx|pnpm|yarn|bun|deno|tsx|electron)$/.test(name)) return 'node';
  if (/^(python[\d.]*|py|pip[\d.]*|pipx|poetry|uv)$/.test(name)) return 'python';
  if (/^(java|javaw|mvn|mvnw|gradle|gradlew|kotlin|sbt)$/.test(name)) return 'java';
  if (/^(dotnet)$/.test(name) || extname(command).toLowerCase() === '.dll') return 'dotnet';
  if (/^(curl|wget|http|https|httpie)$/.test(name)) return 'curl';
  if (/^(chrome|google-chrome[\w-]*|chromium[\w-]*|msedge|microsoft-edge[\w-]*|brave[\w-]*|vivaldi|opera|chrome-headless-shell)$/.test(name)) return 'chromium';
  if (/^firefox[\w-]*$/.test(name)) return 'firefox';
  return 'other';
}

const hostPort = (proxyUrl: string) => {
  const u = new URL(proxyUrl);
  return { host: u.hostname, port: u.port || '80' };
};

export function planLaunch(o: { command: string; args?: string[]; proxyUrl: string; caPath?: string; kind?: LaunchKind; profileDir?: string }): LaunchPlan {
  const command = String(o.command ?? '').trim();
  if (!command) throw new ApsError('ValidationError', 'Name the program to start');
  if (/[\r\n\0]/.test(command)) throw new ApsError('ValidationError', 'The program name has a line break in it');
  const kind = o.kind ?? kindOf(command);
  const { host, port } = hostPort(o.proxyUrl);
  const env: Record<string, string> = { ...proxyEnvironment(o.proxyUrl, o.caPath) };
  const args = [...(o.args ?? [])];
  const files: Record<string, string> = {};
  const notes: string[] = [];
  const profile = o.profileDir ?? join(tmpdir(), 'testpion-launch', kind);
  switch (kind) {
    case 'node':
      env.NODE_USE_ENV_PROXY = '1'; // Node 24 (and 22.21+) read HTTP_PROXY only with this
      notes.push('Node follows HTTP_PROXY with NODE_USE_ENV_PROXY=1 (Node 22.21 or newer, or a library that reads HTTP_PROXY itself).');
      break;
    case 'python':
      notes.push('requests and httpx follow HTTP_PROXY and REQUESTS_CA_BUNDLE; a library that sets its own session may not.');
      break;
    case 'java': {
      const opts = ['http', 'https'].flatMap((p) => [`-D${p}.proxyHost=${host}`, `-D${p}.proxyPort=${port}`]).concat('-Dhttp.nonProxyHosts=');
      env.JAVA_TOOL_OPTIONS = [process.env.JAVA_TOOL_OPTIONS, ...opts].filter(Boolean).join(' ');
      if (o.caPath) notes.push(`Java trusts its own store: keytool -importcert -alias testpion -file "${o.caPath}" -keystore <cacerts of the JRE> -storepass changeit -noprompt`);
      break;
    }
    case 'dotnet':
      env.DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER = '1';
      notes.push('.NET on Windows follows the system proxy, not HTTP_PROXY: use "Capture everything on this computer" for HttpClient.DefaultProxy, or set the proxy in the program.');
      if (o.caPath) notes.push('.NET on Windows trusts the Windows certificate store: install the TestPion root there (HTTPS menu ▸ Install the certificate).');
      break;
    case 'curl':
      args.unshift('-x', o.proxyUrl, ...(o.caPath ? ['--cacert', o.caPath] : []));
      break;
    case 'chromium':
      mkdirSync(profile, { recursive: true });
      args.unshift(`--proxy-server=${o.proxyUrl}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check');
      notes.push('HTTP/3 (QUIC) is switched off for this browser, since it would bypass the proxy.');
      if (o.caPath) notes.push('A Chromium browser trusts the operating system store: install the TestPion root there to read HTTPS.');
      break;
    case 'firefox': {
      files[join(profile, 'user.js')] = [
        'user_pref("network.proxy.type", 1);',
        `user_pref("network.proxy.http", ${JSON.stringify(host)});`,
        `user_pref("network.proxy.http_port", ${Number(port)});`,
        `user_pref("network.proxy.ssl", ${JSON.stringify(host)});`,
        `user_pref("network.proxy.ssl_port", ${Number(port)});`,
        'user_pref("network.proxy.allow_hijacking_localhost", true);',
        'user_pref("network.proxy.no_proxies_on", "");',
        'user_pref("network.http.http3.enable", false);',
        'user_pref("security.enterprise_roots.enabled", true);',
        '',
      ].join('\n');
      args.unshift('-no-remote', '-profile', profile);
      notes.push('HTTP/3 is switched off in this profile. Firefox reads the operating system store when the TestPion root is installed there.');
      break;
    }
    default:
      notes.push('The program gets HTTP_PROXY, HTTPS_PROXY and the CA variables; one that ignores them is not captured.');
  }
  return { kind, command, args, env, files, notes };
}

/** Start the plan's program, detached. Resolves with its process id once it started; a program that cannot start rejects with what to check. */
export function startLaunch(plan: LaunchPlan, o: { cwd?: string } = {}): Promise<{ pid: number }> {
  for (const [path, text] of Object.entries(plan.files)) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return new Promise((resolve, reject) => {
    const child = spawnChecked('program launch', plan.command, plan.args, { detached: true, stdio: 'ignore', env: { ...process.env, ...plan.env }, cwd: o.cwd, windowsHide: false });
    child.once('error', (e: NodeJS.ErrnoException) =>
      reject(new ApsError('ConfigurationError', e.code === 'ENOENT' ? `"${plan.command}" was not found` : `Could not start "${plan.command}": ${e.message}`, { suggestions: ['Give the full path of the program, or one that is on the PATH.'] })),
    );
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid ?? 0 });
    });
  });
}
