// Soak: the same realistic cycle (tabs, sends, every view, runs, the Debugger, dialogs, a large response) N times; after
// each cycle both processes are garbage-collected and their memory, handles, listeners, timers, DOM size and the time of
// a fixed probe are appended to metrics.jsonl, so a leak or a slowdown shows as a trend. Not part of the suite (`_`).
//
//   SOAK_CYCLES=25 SOAK_OUT=<dir> node apps/desktop/e2e/run-e2e.mjs --only _soak --timeout 4000
//
// SOAK_SNAP_AT=5 (0 = none): heap snapshots of the page and the main process after that cycle and after the last one.
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { DOM } = require('../lib.cjs');

const CYCLES = Math.max(1, Number(process.env.SOAK_CYCLES) || 25);
const SNAP_AT = Number(process.env.SOAK_SNAP_AT ?? 5);
const DEMO = 'http://127.0.0.1:4010';
const REQS = Array.from({ length: 10 }, (_, i) => `soak-req-${String(i + 1).padStart(2, '0')}`);

/** A collection on the local demo server and a test file, written before the app starts. */
function prepare(ws) {
  const paths = ['/health', '/echo?x=1', '/patients', '/health?b=2', '/echo?y=2', '/patients/1', '/health?c=3', '/status?code=404', '/echo?z=3', '/health?d=4'];
  const items = REQS.map((name, i) => ({
    kind: 'http',
    id: name,
    name,
    request: { method: 'GET', url: `${DEMO}${paths[i]}`, headers: [{ key: 'Accept', value: 'application/json', enabled: true }] },
  }));
  items.push({ kind: 'http', id: 'soak-large', name: 'soak-large', request: { method: 'GET', url: `${DEMO}/large?mb=2`, headers: [] } });
  writeFileSync(join(ws, 'collections', 'soak.json'), JSON.stringify({ schemaVersion: '1.0', id: 'soak', name: 'Soak collection', items }, null, 2));
  const tests = REQS.slice(0, 5).map(
    (name, i) => `  - id: soak-t${i}\n    name: soak test ${i}\n    method: GET\n    url: "${DEMO}/health?t=${i}"\n    assertions:\n      - { type: status, expected: 200 }\n`,
  );
  writeFileSync(join(ws, 'tests', 'soak.yaml'), `defaults:\n  type: http\ntests:\n${tests.join('')}`);
}

/** Helpers every renderer step has: tabs of the request strip, closing them (discarding edits), rows of the explorer. */
const H = `${DOM}
  const strip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
  const discard = async () => { const b = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((x) => /^(Discard changes|Discard|Don.t save|Close without saving)$/.test(x.textContent.trim())), 600); if (b) { b.click(); await __t.sleep(200); } };
  const closeAll = async () => { for (let i = 0; i < 40; i++) { const b = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] button[aria-label^="Close "]')][0]; if (!b) break; b.click(); await __t.sleep(120); await discard(); } return strip().length; };
  const soakRow = (name) => [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes(name) && b.getAttribute('aria-expanded') === null);
  const ensureSoak = async () => {
    await __t.requests();
    if (soakRow('${REQS[0]}')) return true;
    const c = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.textContent.trim().startsWith('Soak collection')), 4000);
    if (!c) return false;
    if (c.getAttribute('aria-expanded') === 'false') c.click();
    return !!(await __t.waitFor(() => soakRow('${REQS[0]}'), 3000));
  };
  const openReq = async (name) => { const r = soakRow(name); if (!r) return false; r.click(); return !!(await __t.waitFor(() => vis('main input[aria-label="Request URL"]').find((i) => i.offsetParent), 4000)); };
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const r = (name, body) => [name, `(async () => { ${H} ${body} })()`, false];

/* --------------------------------------------------------------- once, before the first cycle */

// counters the page keeps from here on: listeners on window/document by type, live intervals and timeouts, and observers
// (created minus collected); CDP's JSEventListeners is the authoritative listener count, these say which kind grows
const INSTALL = `
  if (window.__soak) return 'already';
  const S = (window.__soak = { win: {}, doc: {}, other: 0, intervals: new Set(), timeouts: new Set(), observers: {}, created: {} });
  const reg = new WeakMap();
  const bucket = (t) => (t === window ? S.win : t === document ? S.doc : null);
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn) { let m = reg.get(this); if (!m) reg.set(this, (m = new Map())); const k = type + '|' + !!(typeof opts === 'object' ? opts?.capture : opts); let s = m.get(k); if (!s) m.set(k, (s = new Set())); if (!s.has(fn)) { s.add(fn); const b = bucket(this); if (b) b[type] = (b[type] ?? 0) + 1; else S.other++; } }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const s = reg.get(this)?.get(type + '|' + !!(typeof opts === 'object' ? opts?.capture : opts));
    if (s?.delete(fn)) { const b = bucket(this); if (b) b[type]--; else S.other--; }
    return rem.call(this, type, fn, opts);
  };
  const si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, ct = window.clearTimeout;
  window.setInterval = function (...a) { const id = si.apply(this, a); S.intervals.add(id); return id; };
  window.clearInterval = function (id) { S.intervals.delete(id); return ci.call(this, id); };
  window.setTimeout = function (fn, ...rest) { let id; const wrapped = typeof fn === 'function' ? function (...x) { S.timeouts.delete(id); return fn.apply(this, x); } : fn; id = st.call(this, wrapped, ...rest); S.timeouts.add(id); return id; };
  window.clearTimeout = function (id) { S.timeouts.delete(id); return ct.call(this, id); };
  const fr = new FinalizationRegistry((k) => S.observers[k]--);
  for (const k of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver']) {
    const C = window[k];
    window[k] = class extends C { constructor(...a) { super(...a); S.observers[k] = (S.observers[k] ?? 0) + 1; S.created[k] = (S.created[k] ?? 0) + 1; fr.register(this, k); } };
  }
  return 'installed';
`;

const setup = [
  ['soak-install', `(async () => { ${INSTALL} })()`, false],
  r(
    'soak-monitor',
    `const m = await window.aps.invoke('monitor.save', { monitor: { name: 'Soak monitor', collectionId: 'soak', selection: ['${REQS[0]}', '${REQS[1]}'], everyMinutes: 1, enabled: true } });
     return 'monitor: ' + (m?.id ?? JSON.stringify(m).slice(0, 120));`,
  ),
  r('soak-expand', `return 'soak rows: ' + (await ensureSoak());`),
];

/* --------------------------------------------------------------- the cycle */

const VIEWS = ['Home', 'Collections', 'Debugger', 'Tests', 'Monitors', 'Load', 'AI Lab', 'Evaluations', 'Environments', 'History', 'Traces', 'Git'];

const cycle = (c) => {
  const p = `c${String(c).padStart(2, '0')}`;
  return [
    // ten request tabs from the explorer, then each closed with its ✕
    r(
      `${p}-tabs`,
      `if (!(await ensureSoak())) return 'NO ROW soak';
       const t0 = performance.now(); let opened = 0;
       let scripts = 0;
       for (const n of ${JSON.stringify(REQS)}) { if (await openReq(n)) opened++; const s = vis('main [role=tab]').find((x) => x.textContent.trim().startsWith('Scripts')); if (s) { s.click(); scripts++; await __t.sleep(300); } await __t.sleep(150); }
       const most = strip().length; await painted(); const models = window.__monaco?.editor.getModels().length ?? -1;
       const left = await closeAll();
       return 'opened ' + opened + ' | scripts ' + scripts + ' | strip ' + most + ' | models open ' + models + ' | left ' + left + ' | ms ' + ms(t0);`,
    ),
    // ten sends with the Send button (one tab), ten through the RPC
    r(
      `${p}-send`,
      `await ensureSoak(); if (!(await openReq('${REQS[0]}'))) return 'NO TAB';
       const t0 = performance.now(); let ui = 0;
       for (let i = 0; i < 10; i++) { const b = await __t.waitFor(() => button('Send') && !button('Send').disabled && button('Send'), 8000); if (!b) break; b.click(); await __t.sleep(250); await __t.waitFor(() => button('Send') && !button('Send').disabled, 8000); ui++; }
       let rpc = 0;
       for (let i = 0; i < 10; i++) { try { await window.aps.invoke('http.send', { name: 'soak rpc ' + i, request: { method: 'GET', url: '${DEMO}/echo?rpc=' + i + '&c=${c}', headers: [] } }); rpc++; } catch {} }
       await closeAll();
       return 'ui ' + ui + ' | rpc ' + rpc + ' | ms ' + ms(t0);`,
    ),
    // a 2 MB JSON response: Pretty (tree), Table, Raw, Pretty again
    r(
      `${p}-large`,
      `await ensureSoak(); if (!(await openReq('soak-large'))) return 'NO TAB';
       const t0 = performance.now();
       button('Send')?.click();
       const mode = (m) => vis('main button').find((b) => b.textContent.trim().toLowerCase() === m);
       const ok = await __t.waitFor(() => mode('raw'), 20000);
       const seen = [];
       for (const m of ['pretty', 'table', 'raw', 'pretty']) { const b = mode(m); if (b) { b.click(); seen.push(m); await __t.sleep(400); await painted(); } }
       await closeAll();
       return 'modes ' + seen.join(',') + ' | response ' + !!ok + ' | ms ' + ms(t0);`,
    ),
    // every rail view once
    r(
      `${p}-views`,
      `const t0 = performance.now(); const bad = []; for (const v of ${JSON.stringify(VIEWS)}) if (!(await __t.view(v))) bad.push(v); return 'views ok' + (bad.length ? ' missing ' + bad.join(',') : '') + ' | ms ' + ms(t0);`,
    ),
    // a test file run and a collection run, each to its end
    r(
      `${p}-runs`,
      `const t0 = performance.now();
       const done = new Set(); const off = window.aps.on('run.finished', (e) => done.add(e?.runId));
       const a = await window.aps.invoke('tests.run', { paths: ['soak.yaml'], name: 'Soak tests ${c}' });
       const b = await window.aps.invoke('col.run', { collectionId: 'soak', keepVariableValues: false });
       const fin = await __t.waitFor(() => done.has(a?.runId) && done.has(b?.runId), 60000);
       off?.();
       await __t.view('Tests'); await __t.sleep(500);
       const f = [...document.querySelectorAll('main *')].find((x) => x.children.length === 0 && x.textContent.trim() === 'soak.yaml' && !x.closest('[role=tablist]'));
       (f?.closest('button') ?? f)?.click(); await __t.sleep(1500); await painted();
       const models = window.__monaco?.editor.getModels().length ?? -1;
       let closed = 0; for (let i = 0; i < 10; i++) { const x = document.querySelector('[role=tablist][aria-label="Open test files"] button[aria-label^="Close "]'); if (!x) break; x.click(); closed++; await __t.sleep(200); await discard(); }
       return 'runs finished ' + !!fin + ' | test file ' + !!f + ' | models open ' + models + ' | closed ' + closed + ' | ms ' + ms(t0);`,
    ),
    // the Debugger: capture, 50 requests through it while its view is on screen, stop, clear
    r(
      `${p}-debugger`,
      `const t0 = performance.now();
       await __t.view('Debugger');
       await window.aps.invoke('debug.start', { port: 18990 });
       let n = 0; for (let i = 0; i < 50; i++) { try { await window.aps.invoke('debug.selfTest', { url: '${DEMO}/health?dbg=' + i + '&c=${c}' }); n++; } catch {} }
       await __t.sleep(800); await painted();
       const rows = (await window.aps.invoke('debug.exchanges', { limit: 0 }))?.length;
       await window.aps.invoke('debug.stop');
       await window.aps.invoke('debug.clear');
       return 'through proxy ' + n + ' | exchanges ' + rows + ' | ms ' + ms(t0);`,
    ),
    // dialogs: the command palette, Settings, keyboard shortcuts
    r(
      `${p}-dialogs`,
      `const t0 = performance.now(); await __t.view('Home');
       const pal = await __t.key('k', { ctrlKey: true }); await __t.esc();
       window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); await __t.sleep(900);
       const settings = !!document.querySelector('nav [aria-label="Settings"][aria-current="page"]');
       const keys = await __t.key('?'); await __t.esc();
       await __t.view('Home');
       return 'palette ' + (pal !== 'NONE') + ' | settings ' + settings + ' | shortcuts ' + (keys !== 'NONE') + ' | ms ' + ms(t0);`,
    ),
    // the probe: the same three timed actions every cycle
    r(
      `${p}-probe`,
      `await ensureSoak(); await painted();
       let t = performance.now(); await openReq('${REQS[2]}'); await painted(); const open = ms(t);
       const url = vis('main input[aria-label="Request URL"]')[0];
       t = performance.now(); if (url) for (const ch of 'abcdefghijklmnopqrst') { setVal(url, url.value + ch); await painted(); } const type = ms(t);
       await closeAll();
       const h = document.querySelector('nav [aria-label="History"]');
       t = performance.now(); h?.click(); await __t.waitFor(() => document.querySelector('nav [aria-label="History"][aria-current="page"]'), 3000); await painted(); const hist = ms(t);
       const hm = document.querySelector('nav [aria-label="Home"]'); t = performance.now(); hm?.click(); await painted(); const home = ms(t);
       window.__soakProbe = { open, type, hist, home };
       return 'probe open ' + open + ' | type20 ' + type + ' | history ' + hist + ' | home ' + home;`,
    ),
    [`${p}-measure`, `main: ${MEASURE(c)}`, false],
    ...(c === SNAP_AT || c === CYCLES ? [[`${p}-snapshot`, `main: ${SNAPSHOT(c)}`, false]] : []),
  ];
};

/* --------------------------------------------------------------- main-process steps */

const OUT = `(process.env.SOAK_OUT || process.env.E2E_OUT)`;
const WIN = `const { BrowserWindow } = require('electron'); const win = BrowserWindow.getAllWindows().find((w) => w.webContents.debugger.isAttached()) ?? BrowserWindow.getAllWindows()[0]; const dbg = win.webContents.debugger;`;

/** Collect garbage in both processes, then measure; one JSON line per cycle in metrics.jsonl. */
function MEASURE(c) {
  return `${WIN}
    const fs = require('fs'), path = require('path'), v8 = require('v8'), vm = require('vm');
    const out = ${OUT}; fs.mkdirSync(out, { recursive: true });
    v8.setFlagsFromString('--expose_gc'); const gc = vm.runInNewContext('gc'); gc(); gc();
    await dbg.sendCommand('HeapProfiler.collectGarbage'); await dbg.sendCommand('HeapProfiler.collectGarbage');
    await new Promise((r) => setTimeout(r, 300));
    await dbg.sendCommand('Performance.enable').catch(() => {});
    const pm = Object.fromEntries((await dbg.sendCommand('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const hu = await dbg.sendCommand('Runtime.getHeapUsage');
    const page = await win.webContents.executeJavaScript(\`(() => { const S = window.__soak ?? {}; const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
      return { dom: document.getElementsByTagName('*').length, models: window.__monaco?.editor.getModels().length ?? -1, editors: window.__monaco?.editor.getEditors?.().length ?? -1,
        winListeners: sum(S.win), docListeners: sum(S.doc), otherListeners: S.other, winByType: S.win, docByType: S.doc, intervals: S.intervals?.size, timeouts: S.timeouts?.size, observers: S.observers, observersCreated: S.created,
        tabs: document.querySelectorAll('[role=tab]').length, dialogs: document.querySelectorAll('[role=dialog]').length, iframes: document.querySelectorAll('iframe').length,
        perfMem: performance.memory ? performance.memory.usedJSHeapSize : -1, lsBytes: (() => { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + (localStorage.getItem(k) ?? '').length; } return n; })(),
        probe: window.__soakProbe }; })()\`);
    const m = process.memoryUsage();
    const res = {}; for (const t of process.getActiveResourcesInfo?.() ?? []) res[t] = (res[t] ?? 0) + 1;
    const hist = await win.webContents.executeJavaScript("window.aps.invoke('history.list', { limit: 100000 }).then((h) => (Array.isArray(h) ? h.length : h?.total ?? (h?.items ?? h?.rows ?? []).length)).catch(() => -1)");
    const row = { cycle: ${c}, t: Date.now(),
      main: { heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers, handles: process._getActiveHandles().length, requests: process._getActiveRequests().length, resources: res },
      renderer: { jsHeapUsed: hu.usedSize, jsHeapTotal: hu.totalSize, cdp: { Nodes: pm.Nodes, JSEventListeners: pm.JSEventListeners, Documents: pm.Documents, Frames: pm.Frames, LayoutObjects: pm.LayoutObjects, JSHeapUsedSize: pm.JSHeapUsedSize }, ...page },
      history: hist };
    fs.appendFileSync(path.join(out, 'metrics.jsonl'), JSON.stringify(row) + '\\n');
    return 'cycle ${c}: main heap MB ' + (m.heapUsed / 1048576).toFixed(1) + ' | rss MB ' + (m.rss / 1048576).toFixed(0) + ' | handles ' + row.main.handles + ' | page heap MB ' + (hu.usedSize / 1048576).toFixed(1) + ' | nodes ' + pm.Nodes + ' | listeners ' + pm.JSEventListeners + ' | dom ' + page.dom + ' | models ' + page.models + ' | probe ' + JSON.stringify(page.probe);`;
}

/** Heap snapshots of the page (through the DevTools protocol) and of the main process. */
function SNAPSHOT(c) {
  return `${WIN}
    const fs = require('fs'), path = require('path'), v8 = require('v8');
    const out = ${OUT}; fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, 'renderer-c${c}.heapsnapshot');
    const ws = fs.createWriteStream(file);
    const on = (_e, method, params) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') ws.write(params.chunk); };
    dbg.on('message', on);
    await dbg.sendCommand('HeapProfiler.enable');
    await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    dbg.removeListener('message', on);
    await dbg.sendCommand('HeapProfiler.disable');
    await new Promise((r) => ws.end(r));
    const mainFile = v8.writeHeapSnapshot(path.join(out, 'main-c${c}.heapsnapshot'));
    return 'snapshots: ' + file + ' (' + Math.round(fs.statSync(file).size / 1048576) + ' MB), ' + mainFile + ' (' + Math.round(fs.statSync(mainFile).size / 1048576) + ' MB)';`;
}

const steps = [...setup];
for (let c = 1; c <= CYCLES; c++) steps.push(...cycle(c));
steps.prepare = (ws, out) => {
  prepare(ws);
  if (process.env.SOAK_OUT) mkdirSync(process.env.SOAK_OUT, { recursive: true });
};
module.exports = steps;
