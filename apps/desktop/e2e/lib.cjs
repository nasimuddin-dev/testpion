/**
 * Helpers for e2e plans (files in e2e/plans). A plan is an array of steps [name, code, shot?, expect?, options?];
 * `withExpect` adds the expectations by step name, and `prepare` / `env` / `settings` (merged into the app's settings,
 * e.g. the AI assistant's provider) / `allowErrors` (steps whose console errors are expected, e.g. a step that throws on purpose).
 */
function withExpect(steps, expect = {}, extra = {}) {
  const names = new Set(steps.map((s) => s[0]));
  for (const k of Object.keys(expect)) if (!names.has(k)) throw new Error(`expectation for unknown step "${k}"`);
  const out = steps.map(([name, code, shot = true]) => [name, code, shot, expect[name], { allowErrors: (extra.allowErrors ?? []).includes(name) }]);
  if (extra.prepare) out.prepare = extra.prepare;
  if (extra.env) out.env = extra.env;
  if (extra.settings) out.settings = extra.settings;
  return out;
}

/** All numbers in a result such as "per keystroke ms: 29,44,49": each must be under `max`. */
const allUnder = (label, max) => (r) => {
  const m = new RegExp(`${label}[^\\d]*([\\d,]+)`).exec(r);
  if (!m) return `no "${label}" in the result`;
  const bad = m[1]
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => n >= max);
  return bad.length ? `${label} ${bad.join(', ')} ≥ ${max}` : true;
};

/* ------------------------------------------------------------------ code the page runs (renderer steps) */

/**
 * Prepended to a renderer step by `step()`: the visible elements of a selector, a visible button or tab by its text,
 * a short one-line rendering of a text, and a paint (two frames).
 */
const DOM = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label && b.getAttribute('role') !== 'tab');
  const tab = (name) => vis('main [role=tab]').find((t) => t.textContent.trim().startsWith(name));
  const short = (s, n = 300) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const ms = (t0) => Math.round(performance.now() - t0);
`;
/** A renderer step: `body` runs in the page with the DOM helpers in scope. */
const step = (name, body, shot) => [name, `(async () => { ${DOM} ${body} })()`, shot];

/** The Debugger's captured exchanges, oldest first (the list call answers an array). */
const EXCHANGES = `await window.aps.invoke('debug.exchanges', {})`;
/** Waits until the Debugger is running (`true`) or stopped (`false`) and returns its status. */
const waitRunning = (running, timeoutMs = 10000) => `await __t.waitFor(async () => { const s = await window.aps.invoke('debug.status'); return !!s.running === ${running} ? s : null; }, ${timeoutMs})`;

/* ------------------------------------------------------------------ code outside the page ("main:" steps) */

/**
 * A command run outside the app's event loop, as another program would (the Debugger's proxy serves from the main
 * process: a synchronous child would deadlock it); its stdout, or "failed: …".
 */
const run = (file, args) =>
  `await new Promise((resolve) => require('child_process').execFile(${JSON.stringify(file)}, ${JSON.stringify(args)}, { encoding: 'utf8', timeout: 60000, windowsHide: true }, (err, stdout, stderr) => resolve(err && !stdout ? 'failed: ' + (stderr || err.message).trim() : String(stdout).trim())))`;
const curl = (args) => run('curl.exe', args);
const powershell = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script + '; exit 0']);
/** Processes whose command line matches (never this PowerShell itself), counted and stopped: windows a step opened. */
const closeByCommandLine = (like, label, excludeNames = []) =>
  powershell(
    `$ps = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' ${excludeNames.map((n) => `-and $_.Name -ne '${n}'`).join(' ')} -and $_.CommandLine -like '${like}' }; $n = ($ps | Measure-Object).Count; $ps | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; "${label}: $n (closed)"`,
  );
/** The app's main process memory, after a garbage collection when asked (what is retained, not what awaits the collector). */
const mainMemory = (label, gc = false) =>
  `main: ${gc ? "const v8 = require('v8'); v8.setFlagsFromString('--expose_gc'); require('vm').runInNewContext('gc')(); require('vm').runInNewContext('gc')(); " : ''}const m = process.memoryUsage(); return '${label}: rss MB ' + Math.round(m.rss / 1048576) + ' | heap MB ' + Math.round(m.heapUsed / 1048576);`;

module.exports = { withExpect, allUnder, DOM, step, EXCHANGES, waitRunning, run, curl, powershell, closeByCommandLine, mainMemory };
