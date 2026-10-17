// Soak: the same realistic cycle (tabs, sends, every view, runs, the Debugger, dialogs, a large response, the AI surfaces
// with the offline demo model) N times; after
// each cycle both processes are garbage-collected and their memory, handles, listeners, timers, DOM size and the time of
// a fixed probe are appended to metrics.jsonl, so a leak or a slowdown shows as a trend. Not part of the suite (`_`).
//
//   SOAK_CYCLES=25 SOAK_OUT=<dir> node apps/desktop/e2e/run-e2e.mjs --only _soak --timeout 4000
//
// SOAK_SNAP_AT=5 (0 = none): heap snapshots of the page and the main process after that cycle and after the last one.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
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
  // deleted and brought back with the undo message every cycle
  items.push({ kind: 'http', id: 'soak-undo', name: 'soak-undo', request: { method: 'GET', url: `${DEMO}/health?undo=1`, headers: [] } });
  // a saved Debugger session, opened in a tab of its own every cycle
  mkdirSync(join(ws, 'debugger'), { recursive: true });
  const entry = (i) => ({
    startedDateTime: new Date(Date.parse('2026-10-01T10:00:00Z') + i * 1000).toISOString(),
    time: 10,
    request: { method: 'GET', url: 'http://saved.test/soak/' + i, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
    response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 2, mimeType: 'application/json', text: '{}' }, redirectURL: '', headersSize: -1, bodySize: 2 },
    cache: {},
    timings: { send: 1, wait: 8, receive: 1 },
  });
  writeFileSync(join(ws, 'debugger', 'soak-session.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'soak', version: '1' }, entries: Array.from({ length: 20 }, (_, i) => entry(i)) } }));
  writeFileSync(join(ws, 'collections', 'soak.json'), JSON.stringify({ schemaVersion: '1.0', id: 'soak', name: 'Soak collection', items }, null, 2));
  // the offline demo model's answers for the AI cycle: a flow plan naming two soak requests, checks for /health
  const pp = join(ws, 'providers.json');
  const pc = JSON.parse(readFileSync(pp, 'utf8'));
  const rules = pc.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  const plan = {
    name: 'Soak flow from AI',
    summary: 'Health, then the patients list.',
    assumptions: [],
    steps: [
      { id: 'health', request: REQS[0], assertions: [{ type: 'status', expected: 200 }] },
      { id: 'patients', request: REQS[2], dependsOn: ['health'], assertions: [{ type: 'status', expected: 200 }] },
    ],
  };
  const checks = { checks: [{ type: 'status', expected: 200 }, { type: 'exists', path: '$.status' }] };
  rules.value = JSON.stringify([{ match: '"source"', response: JSON.stringify(plan) }, { match: '127.0.0.1:4010/health', response: JSON.stringify(checks) }, ...JSON.parse(rules.value)]);
  writeFileSync(pp, JSON.stringify(pc, null, 2));
  const tests = REQS.slice(0, 5).map(
    (name, i) => `  - id: soak-t${i}\n    name: soak test ${i}\n    method: GET\n    url: "${DEMO}/health?t=${i}"\n    assertions:\n      - { type: status, expected: 200 }\n`,
  );
  writeFileSync(join(ws, 'tests', 'soak.yaml'), `defaults:\n  type: http\ntests:\n${tests.join('')}`);
  // a two-step flow for the flow designer and the Scale stage's per-row grid (Run with data…)
  writeFileSync(
    join(ws, 'tests', 'soak-flow.yaml'),
    [
      'name: Soak flow',
      'tests:',
      `  - { id: health, name: Health, url: "${DEMO}/health", assertions: [{ type: status, expected: 200 }] }`,
      `  - { id: status, name: Status, url: "${DEMO}/status?code={{code}}", dependsOn: [health], assertions: [{ type: status, expected: 200 }] }`,
      '',
    ].join('\n'),
  );
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
  // opened for good, as a person opening several requests does (a single click only previews, WF-19)
  const openReq = async (name) => { const r = soakRow(name); if (!r) return false; r.click(); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return !!(await __t.waitFor(() => vis('main input[aria-label="Request URL"]').find((i) => i.offsetParent), 4000)); };
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
  r('soak-data', `const d = await window.aps.invoke('col.uploadDataFile', { name: 'soak-rows.csv', text: 'code\\n200\\n404\\n200\\n' }); return 'data: ' + (d?.path ?? d?.name ?? JSON.stringify(d).slice(0, 80));`),
  // a second workspace (a new one shows Get started with the guided tour), made through the backend; the window stays in the examples
  r(
    'soak-tour-workspace',
    `const here = await window.aps.invoke('ws.current');
     await window.aps.invoke('ws.create', { name: 'Soak tour' });
     await window.aps.invoke('ws.open', { ref: here.path });
     window.__soakHome = here.name;
     return 'workspaces: ' + (await window.aps.invoke('ws.list')).map((w) => w.name).join(', ') + ' | back in: ' + (await window.aps.invoke('ws.current')).name;`,
  ),
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
    // the bottom panel's Terminal (two shells, a command, both killed), the Problems tab, Quick Open, the right panel
    // (Info, then the assistant in it): each opened and closed again
    r(
      `${p}-panels`,
      `const t0 = performance.now(); await __t.view('Collections');
       const termTabs = () => [...document.querySelectorAll('[data-terminal-tab]')];
       const termText = () => (document.querySelector('[data-terminal-box] .xterm-rows')?.innerText ?? '').replace(/\\u00a0/g, ' ');
       const sessions = () => window.aps.invoke('terminal.list', {});
       const footer = (k) => document.querySelector('footer [data-status="' + k + '"]');
       let term = 'no shell';
       if (footer('terminal')) {
         footer('terminal').click();
         await __t.waitFor(() => document.querySelector('[data-terminal-box] .xterm') && termTabs().length >= 1, 15000);
         document.querySelector('[data-terminal-strip] button[aria-label="New terminal"]')?.click();
         await __t.waitFor(() => termTabs().length === 2, 15000);
         const id = termTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.terminalTab;
         await __t.waitFor(() => /\\S/.test(termText()), 20000);
         if (id) await window.aps.invoke('terminal.write', { id, data: 'echo soak-${c}\\r' });
         const echoed = !!(await __t.waitFor(() => /^soak-${c}\\s*$/m.test(termText()), 15000));
         for (let i = 0; i < 4 && termTabs().length; i++) { document.querySelector('[data-terminal-strip] button[aria-label="Kill terminal"]')?.click(); await __t.sleep(400); }
         await __t.waitFor(async () => (await sessions()).length === 0, 5000);
         if (document.querySelector('[data-bottom-panel="terminal"]')) footer('terminal')?.click();
         term = 'echoed ' + echoed + ' sessions left ' + (await sessions()).length;
       }
       footer('problems')?.click();
       const prob = !!(await __t.waitFor(() => document.querySelector('[data-bottom-panel="problems"]'), 3000));
       footer('problems')?.click(); await __t.sleep(200);
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
       const qi = await __t.waitFor(() => document.querySelector('[role=dialog] input'), 3000);
       if (qi) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(qi, 'soak-req'); qi.dispatchEvent(new Event('input', { bubbles: true })); }
       const hits = await __t.waitFor(() => document.querySelectorAll('[role=dialog] [role=option]').length, 4000);
       await __t.esc();
       await ensureSoak(); await openReq('${REQS[3]}');
       const host = await __t.waitFor(() => document.querySelector('[data-pinnable-panel="right"]'), 3000);
       host?.querySelector('button[aria-expanded]')?.click();
       const info = !!(await __t.waitFor(() => host?.querySelector('[data-context-info]'), 5000));
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
       const asst = !!(await __t.waitFor(() => host?.querySelector('aside[aria-label="AI assistant"]'), 4000));
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })); await __t.sleep(300);
       await __t.esc(); await closeAll();
       return 'terminal ' + term + ' | problems ' + prob + ' | quick open hits ' + (hits || 0) + ' | info ' + info + ' | assistant ' + asst + ' | bottom open ' + !!document.querySelector('[data-bottom-panel]') + ' | ms ' + ms(t0);`,
    ),
    // the flow designer (Flow tab, a step's inspector) and the Scale stage's per-row grid (Run with data, 3 rows)
    r(
      `${p}-flow`,
      `const t0 = performance.now();
       await __t.view('Tests'); await __t.sleep(500);
       const row = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('soak-flow.yaml')), 5000);
       if (!row) return 'NO ROW soak-flow.yaml';
       row.click(); await __t.sleep(800);
       await __t.tab('Flow');
       const nodes = () => vis('[data-flow-designer] [data-flow-node]');
       const drawn = await __t.waitFor(() => nodes().length === 2, 6000);
       let inspector = false;
       if (drawn) { nodes()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); inspector = !!(await __t.waitFor(() => document.querySelector('[data-step-inspector]'), 3000)); }
       await __t.tab('Editor'); await __t.sleep(300);
       const open = await __t.waitFor(() => vis('[data-run-with-data-open]')[0], 4000);
       let grid = 'no button';
       if (open) {
         open.click();
         const dlg = await __t.waitFor(() => document.querySelector('[data-run-with-data]'), 3000);
         const d = (await window.aps.invoke('datasets.list')).find((x) => x.name.endsWith('soak-rows.csv'));
         const sel = dlg?.querySelector('select[aria-label="Data source"]');
         if (sel && d) { await __t.waitFor(() => [...sel.options].some((o) => o.value === d.path), 3000); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, d.path); sel.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(200); }
         document.querySelector('[data-scale-start]')?.click();
         const g = await __t.waitFor(() => vis('[data-flow-data-grid]')[0], 6000);
         const done = g && (await __t.waitFor(() => g.dataset.running === 'false' && vis('[data-data-row]').length === 3, 30000));
         grid = 'rows ' + vis('[data-data-row]').map((x) => x.dataset.status).join(',') + ' done ' + !!done;
       }
       await __t.esc();
       let closed = 0; for (let i = 0; i < 10; i++) { const x = document.querySelector('[role=tablist][aria-label="Open test files"] button[aria-label^="Close "]'); if (!x) break; x.click(); closed++; await __t.sleep(200); await discard(); }
       await __t.view('Home');
       return 'nodes ' + nodes().length + ' drawn ' + !!drawn + ' | inspector ' + inspector + ' | grid ' + grid + ' | closed ' + closed + ' | ms ' + ms(t0);`,
    ),
    // v0.47's surfaces: the rail's More…, Settings ▸ Keyboard, the density switched there and back, a delete undone from
    // its message, a saved Debugger session in its tab, saved AI prompts in tabs, the guided tour in a second workspace
    r(
      `${p}-surfaces`,
      `const t0 = performance.now(); const out = [];
       const press = (b) => b?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
       const closeTabs = async (strip) => { let n = 0; for (let i = 0; i < 10; i++) { const x = document.querySelector('[role=tablist][aria-label="' + strip + '"] button[aria-label^="Close "]'); if (!x) break; x.click(); n++; await __t.sleep(200); await discard(); } return n; };
       // the rail's More… menu, opened and closed
       await __t.view('Home');
       press(document.querySelector('nav [aria-label="More views"]'));
       const more = await __t.waitFor(() => document.querySelectorAll('[role=menu] [role=menuitem]').length, 2000);
       await __t.esc(); await __t.waitFor(() => !document.querySelector('[role=menu]'), 1500);
       out.push('more ' + (more || 0));
       // Settings ▸ Keyboard with a search
       await __t.view('Settings'); await __t.tab('Keyboard');
       const kb = await __t.waitFor(() => vis('[data-keyboard-settings]')[0], 3000);
       const search = vis('input[aria-label="Search shortcuts"]')[0];
       if (search) { setVal(search, 'palette'); await __t.sleep(200); out.push('keyboard rows ' + vis('[data-shortcut-row]').length); setVal(search, ''); await __t.sleep(200); } else out.push('keyboard ' + !!kb);
       // the density: compact, then comfortable again (Settings ▸ Appearance, saved)
       const density = [];
       for (const d of ['Compact', 'Comfortable']) {
         await __t.tab('Appearance');
         vis('main button').find((b) => b.textContent.trim() === d)?.click(); await __t.sleep(150);
         vis('main button').find((b) => b.textContent.trim() === 'Save settings')?.click();
         await __t.waitFor(() => document.documentElement.dataset.density === d.toLowerCase(), 3000); await painted();
         density.push(document.documentElement.dataset.density);
       }
       out.push('density ' + density.join('>'));
       // a request deleted (no question), brought back with Undo in its message
       await ensureSoak();
       const ur = soakRow('soak-undo');
       let undo = 'no row';
       if (ur) {
         ur.focus(); await __t.real.key('Delete');
         const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].find((t) => /Deleted the request "soak-undo"/.test(t.textContent)), 3000);
         const b = toast && (toast.querySelector('button[data-button]:not([data-cancel])') ?? [...toast.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Undo'));
         b?.click();
         const back = await __t.waitFor(() => soakRow('soak-undo'), 5000);
         undo = 'toast ' + !!toast + ' restored ' + !!back;
       }
       out.push('undo ' + undo);
       // a saved Debugger session in a tab of its own, then closed
       await __t.view('Debugger');
       const sb = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && /^Session/.test(b.textContent.trim())), 3000);
       let session = 'no menu';
       if (sb) {
         press(sb); sb.click();
         const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Open soak-session/.test(m.textContent.trim())), 3000);
         if (it) {
           it.click();
           const rows = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].filter((r) => /saved\\.test/.test(r.textContent)).length >= 10, 5000);
           const closed = await closeTabs('Open sessions');
           session = 'rows ' + !!rows + ' closed ' + closed;
         } else { await __t.esc(); session = 'no item'; }
       }
       out.push('session ' + session);
       // two saved prompts in the AI Lab: one kept, one a preview; then both closed
       await __t.view('AI Lab'); await __t.tab('Playground');
       const prompt = (n) => [...document.querySelectorAll('[data-tree-row]')].find((x) => x.getAttribute('aria-label') === n);
       const pa = await __t.waitFor(() => prompt('Classify intent (JSON)'), 4000);
       let prompts = 'no prompt';
       if (pa) {
         pa.click(); await __t.sleep(300); pa.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(300);
         prompt('Summarise a text')?.click(); await __t.sleep(500); await painted();
         const n = document.querySelectorAll('[role=tablist][aria-label="Open prompts"] [role=tab]').length;
         prompts = 'tabs ' + n + ' closed ' + (await closeTabs('Open prompts'));
       }
       out.push('prompts ' + prompts);
       // the guided tour in the second workspace (switched to and back with the workspace menu)
       const switchTo = async (name) => {
         const wb = document.querySelector('button[title^="Switch workspace"]'); if (!wb) return false;
         wb.click(); const f = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Workspaces"] input'), 3000); if (!f) return false;
         setVal(f, name); await __t.sleep(150);
         f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         return !!(await __t.waitFor(() => wb.textContent.trim() === name, 8000));
       };
       let tour = 'no switch';
       if (await switchTo('Soak tour')) {
         await __t.view('Home');
         const card = () => document.querySelector('[role=dialog][data-coachmark]');
         if (!card()) (await __t.waitFor(() => document.querySelector('[data-take-tour]'), 5000))?.click();
         const opened = !!(await __t.waitFor(card, 5000));
         [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Skip tour')?.click();
         const shut = !!(await __t.waitFor(() => !card(), 3000));
         tour = 'opened ' + opened + ' closed ' + shut + ' | back ' + (await switchTo(window.__soakHome));
       }
       out.push('tour ' + tour);
       await __t.view('Home');
       return out.join(' | ') + ' | ms ' + ms(t0);`,
    ),
    // the AI surfaces with the offline demo model: Generate integration flow (dialog, estimate, "What will be sent…",
    // generate, review, discard), a proposal review (Suggest assertions on a response) opened and closed, Settings ▸ AI
    // assistant, and the assistant answering a suggested question
    r(
      `${p}-ai`,
      `const t0 = performance.now(); const out = [];
       const panel = () => document.querySelector('aside[aria-label="AI assistant"]');
       const closePanel = async () => { panel()?.querySelector('[aria-label="Close assistant"]')?.click(); await __t.waitFor(() => !panel(), 2000); };
       const dialogButton = (root, label) => [...(root?.closest('[role=dialog]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === label);
       // 1. a flow from the soak collection: generated, reviewed, discarded
       await ensureSoak();
       const col = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.textContent.trim().startsWith('Soak collection'));
       let flow = 'no row';
       if (col) {
         await __t.real.rightClick(col);
         const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Generate integration flow with AI…'), 3000);
         if (item) {
           await __t.real.click(item);
           const dlg = await __t.waitFor(() => document.querySelector('[data-flow-generate-dialog]'), 4000);
           const est = await __t.waitFor(() => /tokens in/.test(dlg?.querySelector('[data-flow-estimate]')?.textContent ?? ''), 10000);
           // "What will be sent…" of the dialog, opened and cancelled
           let preview = 'no button';
           const eye = await __t.waitFor(() => { const b = dlg?.closest('[role=dialog]')?.querySelector('[data-ai-preview-open]'); return b && !b.disabled && b; }, 5000);
           if (eye) {
             eye.click();
             const pd = await __t.waitFor(() => document.querySelector('[data-ai-preview] [data-ai-estimate]') && document.querySelector('[data-ai-preview]'), 10000);
             dialogButton(pd, 'Cancel')?.click();
             preview = 'estimate ' + !!pd + ' closed ' + !!(await __t.waitFor(() => !document.querySelector('[data-ai-preview]'), 3000));
           }
           out.push('preview ' + preview);
           dlg?.closest('[role=dialog]')?.querySelector('[data-flow-generate]')?.click();
           const rev = await __t.waitFor(() => document.querySelector('[data-flow-proposal] [data-flow-node]') && document.querySelector('[data-flow-proposal]'), 20000);
           const nodes = rev ? rev.querySelectorAll('[data-flow-node]').length : 0;
           rev?.closest('[role=dialog]')?.querySelector('[data-proposal-discard]')?.click();
           const gone = await __t.waitFor(() => !document.querySelector('[data-flow-proposal]') && !document.querySelector('[data-flow-generate-dialog]'), 5000);
           flow = 'estimate ' + !!est + ' nodes ' + nodes + ' discarded ' + !!gone;
         } else { await __t.esc(); flow = 'no menu item'; }
       }
       out.push('flow ' + flow);
       // 2. a proposal review: Suggest assertions on a response, opened and closed
       let review = 'no tab';
       if (await openReq('${REQS[0]}')) {
         button('Send')?.click();
         await __t.waitFor(() => button('Send') && !button('Send').disabled && vis('main button[aria-label="Response actions"]')[0], 8000);
         if (await __t.responseAction('Suggest assertions')) {
           const m = await __t.waitFor(() => document.querySelector('[data-proposal]'), 12000);
           const items = m ? m.querySelectorAll('[data-proposal-item]').length : 0;
           dialogButton(m, 'Close')?.click();
           const shut = await __t.waitFor(() => !document.querySelector('[data-proposal]'), 3000);
           await closePanel();
           review = 'items ' + items + ' closed ' + !!shut;
         } else review = 'no action';
       }
       out.push('review ' + review);
       await closeAll();
       // 4. Settings ▸ AI assistant
       await __t.view('Settings'); await __t.tab('AI assistant');
       out.push('settings ' + !!(await __t.waitFor(() => vis('[data-ai-settings]')[0], 3000)));
       // 5. the assistant answers a suggested question
       await __t.view('Collections');
       window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
       const chip = await __t.waitFor(() => panel()?.querySelector('[data-suggestion]'), 4000);
       let answer = 'no chip';
       if (chip) { chip.click(); answer = 'answered ' + !!(await __t.waitFor(() => panel()?.querySelector('[data-turn=assistant] [data-answer-model]'), 15000)); }
       await closePanel();
       out.push('assistant ' + answer);
       await __t.view('Home');
       return out.join(' | ') + ' | ms ' + ms(t0);`,
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
// the AI surfaces use the examples' offline demo model (no network, no key)
steps.settings = { assistantProvider: 'demo', assistantModel: 'demo' };
steps.prepare = (ws, out) => {
  prepare(ws);
  if (process.env.SOAK_OUT) mkdirSync(process.env.SOAK_OUT, { recursive: true });
};
module.exports = steps;
