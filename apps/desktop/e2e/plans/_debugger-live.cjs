// Not part of the suite (the _ prefix; it changes the Windows system proxy for a moment and opens a browser window):
// the Debugger with real programs — curl through the proxy (HTTP, an HTTPS tunnel, HTTPS decrypted with the root
// certificate), the Windows system proxy set and restored (read from the registry), a browser and a terminal opened
// through the proxy (their processes found and closed). "main:" steps run outside the app, like another program would.
const { withExpect } = require('../lib.cjs');

const PROXY = 'http://127.0.0.1:8899';
const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(label)})`;
// run outside the app's event loop: the proxy serves from the main process, so a synchronous child would deadlock it
const run = (file, args) => `await new Promise((resolve) => require('child_process').execFile(${JSON.stringify(file)}, ${JSON.stringify(args)}, { encoding: 'utf8', timeout: 60000, windowsHide: true }, (err, stdout, stderr) => resolve(err && !stdout ? 'failed: ' + (stderr || err.message).trim() : String(stdout).trim())))`;
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script + '; exit 0']);
const curl = (args) => run('curl.exe', args);
const exchanges = `await window.aps.invoke('debug.exchanges', {})`;
const registry = ps(`$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; "enable=$([int]$p.ProxyEnable) server=$([string]$p.ProxyServer)"`);

const steps = [
  [
    'start-capturing',
    `(async () => {
      await __t.view('Debugger');
      const st0 = await window.aps.invoke('debug.status');
      if (!st0.running) { ${button('Start capturing')}?.click(); }
      const st = await __t.waitFor(async () => { const s = await window.aps.invoke('debug.status'); return s.running ? s : null; }, 10000);
      return 'running on port ' + st.port + ' decrypt=' + !!st.decrypt + ' systemProxy=' + !!st.systemProxy;
    })()`,
  ],
  ['curl-http-through-the-proxy', `main: return 'curl: ' + ${curl(['-s', '-x', PROXY, 'http://127.0.0.1:4010/health'])};`, false],
  [
    'curl-request-listed',
    `(async () => {
      await __t.sleep(800);
      const list = (${exchanges}).items ?? ${exchanges};
      const e = (Array.isArray(list) ? list : list.items).find((x) => /\\/health$/.test(x.url));
      return e ? 'listed: ' + e.method + ' ' + e.status + ' app=' + (e.application || e.app || '?') + ' kind=' + e.kind : 'NOT LISTED';
    })()`,
  ],
  ['curl-https-tunnel', `main: return 'https via tunnel: ' + ${curl(['-s', '-o', 'NUL', '-w', '%{http_code}', '-x', PROXY, 'https://example.com/'])};`, false],
  [
    'tunnel-listed',
    `(async () => {
      await __t.sleep(800);
      const list = (${exchanges}).items ?? ${exchanges};
      const e = (Array.isArray(list) ? list : list.items).find((x) => x.kind === 'tunnel' && /example\\.com/.test(x.url));
      return e ? 'tunnel listed: ' + e.url : 'NO TUNNEL';
    })()`,
  ],
  [
    'decrypt-https',
    `(async () => {
      const st = await window.aps.invoke('debug.decrypt', { on: true });
      return 'decrypt=' + !!st.decrypt;
    })()`,
  ],
  [
    'curl-https-decrypted',
    `main: const path = require('path'); const fs = require('fs');
      const pem = path.join(home, 'debugger', 'testpion-root.pem');
      if (!fs.existsSync(pem)) return 'NO ROOT CERT at ' + pem; // the root exists for programs that trust it; curl here accepts the certificate with -k
      return 'https decrypted: ' + (await new Promise((resolve) => require('child_process').execFile('curl.exe', ['-s', '-k', '-o', 'NUL', '-w', '%{http_code}', '-x', ${JSON.stringify(PROXY)}, 'https://example.com/'], { encoding: 'utf8', timeout: 60000, windowsHide: true }, (err, stdout, stderr) => resolve(err && !stdout ? 'failed: ' + (stderr || err.message).trim() : String(stdout).trim()))));`,
    false,
  ],
  [
    'decrypted-request-listed',
    `(async () => {
      await __t.sleep(800);
      const list = (${exchanges}).items ?? ${exchanges};
      const e = (Array.isArray(list) ? list : list.items).find((x) => x.kind === 'http' && /^https:\\/\\/example\\.com/.test(x.url));
      return e ? 'decrypted listed: ' + e.method + ' ' + e.url + ' ' + e.status : 'NO DECRYPTED REQUEST';
    })()`,
  ],
  ['registry-before', `main: return 'before: ' + ${registry};`, false],
  [
    'system-proxy-on',
    `(async () => {
      const st = await window.aps.invoke('debug.systemProxy', { on: true });
      return 'systemProxy=' + !!st.systemProxy;
    })()`,
  ],
  ['registry-with-proxy', `main: return 'with proxy: ' + ${registry};`, false],
  [
    'system-proxy-off',
    `(async () => {
      const st = await window.aps.invoke('debug.systemProxy', { on: false });
      return 'systemProxy=' + !!st.systemProxy;
    })()`,
  ],
  ['registry-restored', `main: return 'restored: ' + ${registry};`, false],
  [
    'open-a-browser',
    `(async () => {
      const opts = await window.aps.invoke('debug.captureOptions');
      const b = (opts.browsers ?? [])[0];
      if (!b) return 'NO BROWSER FOUND';
      const r = await window.aps.invoke('debug.openBrowser', { browser: b.name });
      await __t.sleep(7000);
      return 'opened: ' + r.browser;
    })()`,
  ],
  [
    'browser-runs-through-the-proxy',
    `main: return ${ps(`$ps = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*--proxy-server=${PROXY}*' }; $n = ($ps | Measure-Object).Count; $ps | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; "browser processes with the proxy: $n (closed)"`)};`,
    false,
  ],
  [
    'browser-traffic-listed',
    `(async () => {
      const list = (${exchanges}).items ?? ${exchanges};
      const all = Array.isArray(list) ? list : list.items;
      const apps = [...new Set(all.map((x) => x.application || x.app).filter(Boolean))];
      return 'exchanges: ' + all.length + ' | applications: ' + apps.join(', ');
    })()`,
  ],
  [
    'open-a-terminal',
    `(async () => {
      const r = await window.aps.invoke('debug.openTerminal');
      await __t.sleep(3000);
      return 'terminal: ' + r.terminal;
    })()`,
  ],
  [
    'terminal-has-the-proxy',
    `main: return ${ps(`$ps = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' -and $_.Name -ne 'TestPion.exe' -and $_.CommandLine -like '*TestPion HTTP Debugger: this shell sends through*' }; $n = ($ps | Measure-Object).Count; $ps | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; "terminal windows through the proxy: $n (closed)"`)};`,
    false,
  ],
  [
    'stop',
    `(async () => {
      ${button('Stop')}?.click();
      const st = await __t.waitFor(async () => { const s = await window.aps.invoke('debug.status'); return s.running ? null : s; }, 10000);
      return 'stopped; systemProxy=' + !!st.systemProxy;
    })()`,
  ],
  ['registry-after-stop', `main: return 'after stop: ' + ${registry};`, false],
];

module.exports = withExpect(steps, {
  'start-capturing': /^running on port 8899 decrypt=false systemProxy=false$/,
  'curl-http-through-the-proxy': /^curl: \{"status":"ok"/,
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
