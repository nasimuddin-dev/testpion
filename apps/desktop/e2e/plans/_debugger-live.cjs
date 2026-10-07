// Not part of the suite (the _ prefix; it changes the Windows system proxy for a moment and opens a browser window):
// the Debugger with real programs — curl through the proxy (HTTP, an HTTPS tunnel, HTTPS decrypted with the root
// certificate), the Windows system proxy set and restored (read from the registry), a browser and a terminal opened
// through the proxy (their processes found and closed). "main:" steps run outside the app, like another program would.
const { withExpect, step, EXCHANGES, waitRunning, curl, powershell, closeByCommandLine } = require('../lib.cjs');

const PROXY = 'http://127.0.0.1:8899';
const registry = powershell(`$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; "enable=$([int]$p.ProxyEnable) server=$([string]$p.ProxyServer)"`);
const head = (args) => curl(['-s', '-o', 'NUL', '-w', '%{http_code}', '-x', PROXY, ...args]);
/** A Debugger switch (`debug.decrypt`, `debug.systemProxy`) turned on or off, with the status field it sets. */
const toggle = (name, channel, key, on) => step(name, `const st = await window.aps.invoke('${channel}', { on: ${on} }); return '${key}=' + !!st.${key};`);
/** The first captured exchange matching, described. */
const listed = (name, pred, describe) => step(name, `await __t.sleep(800); const e = (${EXCHANGES}).find((x) => ${pred}); return e ? ${describe} : 'NOT LISTED';`);

const steps = [
  step(
    'start-capturing',
    `await __t.view('Debugger');
     if (!(await window.aps.invoke('debug.status')).running) button('Start capturing')?.click();
     const st = ${waitRunning(true)};
     return 'running on port ' + st.port + ' decrypt=' + !!st.decrypt + ' systemProxy=' + !!st.systemProxy;`,
  ),
  ['curl-http-through-the-proxy', `main: return 'curl: ' + ${curl(['-s', '-x', PROXY, 'http://127.0.0.1:4010/health'])};`, false],
  listed('curl-request-listed', `/\\/health$/.test(x.url)`, `'listed: ' + e.method + ' ' + e.status + ' app=' + (e.application ?? '?') + ' kind=' + e.kind`),
  ['curl-https-tunnel', `main: return 'https via tunnel: ' + ${head(['https://example.com/'])};`, false],
  listed('tunnel-listed', `x.kind === 'tunnel' && /example\\.com/.test(x.url)`, `'tunnel listed: ' + e.url`),
  toggle('decrypt-https', 'debug.decrypt', 'decrypt', true),
  // Windows' curl is Schannel and ignores --cacert: -k accepts the proxy's certificate; decryption is what is tested
  ['curl-https-decrypted', `main: return 'https decrypted: ' + ${head(['-k', 'https://example.com/'])};`, false],
  listed('decrypted-request-listed', `x.kind === 'http' && /^https:\\/\\/example\\.com/.test(x.url)`, `'decrypted listed: ' + e.method + ' ' + e.url + ' ' + e.status`),
  ['registry-before', `main: return 'before: ' + ${registry};`, false],
  toggle('system-proxy-on', 'debug.systemProxy', 'systemProxy', true),
  ['registry-with-proxy', `main: return 'with proxy: ' + ${registry};`, false],
  toggle('system-proxy-off', 'debug.systemProxy', 'systemProxy', false),
  ['registry-restored', `main: return 'restored: ' + ${registry};`, false],
  step(
    'open-a-browser',
    `const b = ((await window.aps.invoke('debug.captureOptions')).browsers ?? [])[0];
     if (!b) return 'NO BROWSER FOUND';
     const r = await window.aps.invoke('debug.openBrowser', { browser: b.name });
     await __t.sleep(7000);
     return 'opened: ' + r.browser;`,
  ),
  ['browser-runs-through-the-proxy', `main: return ${closeByCommandLine(`*--proxy-server=${PROXY}*`, 'browser processes with the proxy')};`, false],
  step('browser-traffic-listed', `const all = ${EXCHANGES}; return 'exchanges: ' + all.length + ' | applications: ' + [...new Set(all.map((x) => x.application).filter(Boolean))].join(', ');`),
  step('open-a-terminal', `const r = await window.aps.invoke('debug.openTerminal'); await __t.sleep(3000); return 'terminal: ' + r.terminal;`),
  // the terminal carries HTTP_PROXY in its environment, not on its command line: the banner identifies it
  ['terminal-has-the-proxy', `main: return ${closeByCommandLine('*TestPion HTTP Debugger: this shell sends through*', 'terminal windows through the proxy', ['TestPion.exe'])};`, false],
  step('stop', `button('Stop')?.click(); const st = ${waitRunning(false)}; return 'stopped; systemProxy=' + !!st.systemProxy;`),
  ['registry-after-stop', `main: return 'after stop: ' + ${registry};`, false],
];

module.exports = withExpect(steps, {
  'start-capturing': /^running on port 8899 decrypt=false systemProxy=false$/,
  'curl-http-through-the-proxy': /^curl: \{"status":"ok"/,
  // a program that exits within milliseconds (curl) may be gone before the owner lookup answers
  'curl-request-listed': /^listed: GET 200 app=(curl|\?) kind=http$/,
  'curl-https-tunnel': /^https via tunnel: 200$/,
  'tunnel-listed': /^tunnel listed: /,
  'decrypt-https': /^decrypt=true$/,
  'curl-https-decrypted': /^https decrypted: 200$/,
  'decrypted-request-listed': /^decrypted listed: GET https:\/\/example\.com\/ 200$/,
  'system-proxy-on': /^systemProxy=true$/,
  'registry-with-proxy': /^with proxy: enable=1 server=127\.0\.0\.1:8899$/,
  'system-proxy-off': /^systemProxy=false$/,
  'registry-restored': /^restored: enable=0/,
  'open-a-browser': /^opened: /,
  'browser-runs-through-the-proxy': /^browser processes with the proxy: [1-9]\d* \(closed\)$/,
  'browser-traffic-listed': /applications: .*(chrome|msedge|firefox|brave)/i,
  'open-a-terminal': /^terminal: /,
  'terminal-has-the-proxy': /^terminal windows through the proxy: [1-9]\d* \(closed\)$/,
  stop: /^stopped; systemProxy=false$/,
  'registry-after-stop': /^after stop: enable=0/,
});
