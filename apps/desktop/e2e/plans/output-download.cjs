// The down arrow on every output (planning/output-export.md, release A): real clicks on the shared control of a
// dozen representative surfaces — the REST body (pretty, raw, table CSV), headers, cookies, the timeline as HAR, gRPC
// response / metadata / trailers, a WebSocket log as CSV (formula injection guarded), run results (HTML, ZIP), the
// console (redacted by default, then "Include secrets…" with its confirm) — and the bytes the Save-as dialog (answered
// by E2E_STUB_SAVE) received. Also: Ctrl+Shift+S, a cancelled dialog, every control the same size / icon / place, and
// the JSON tree toolbar never scrolled sideways (the clipped "Expand all").
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

const DEMO = 'http://127.0.0.1:4010';
const TEST_FILE = 'e2e-output.yaml';
const TEST_TEXT = `tests:\n  - { id: health, name: Health, url: "${DEMO}/health", assertions: [{ type: status, expected: 200 }] }\n  - { id: echo, name: Echo, url: "${DEMO}/echo?n=1", assertions: [{ type: status, expected: 200 }] }\n`;

// a JWT in the response (the echo's query): the JWT tab's download masks it, "Include secrets…" keeps it
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'e2e-patient', name: 'Rex' })}.ZTJlMHNpZ25hdHVyZTB2YWx1ZQ`;

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim());
  const dl = (id) => vis('[data-output-download="' + id + '"]')[0];
  // the "… saved to …" toasts, as elements: a new save is a toast element that was not there before (sonner shows a few
  // at a time and drops the oldest, so counting them misses a new one)
  const savedToasts = () => [...document.querySelectorAll('[data-sonner-toast]')].filter((t) => / saved to /.test(t.textContent));
  const newSaved = async (seen, ms) => { const t = await __t.waitFor(() => savedToasts().find((x) => !seen.has(x)) ?? null, ms); return t ? t.textContent.trim() : null; };
  const clearToasts = async () => {
    const open = [...document.querySelectorAll('[data-sonner-toast] [aria-label="Close toast"]')];
    open.forEach((c) => c.click());
    if (open.length) await __t.waitFor(() => (document.querySelector('[data-sonner-toast]') ? null : true), 3000);
  };
  /** ▾ ▸ Include secrets… ▸ <label>, confirmed: the toast of the save, or what went wrong. */
  const saveWithSecrets = async (id, label) => {
    await clearToasts();
    const seen = new Set(savedToasts());
    await __t.real.click(vis('[data-output-formats="' + id + '"]')[0]);
    const inc = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith('Include secrets')), 3000); if (!inc) return 'NO INCLUDE SECRETS';
    await __t.real.click(inc);
    // the submenu's item (the last one: the format list above has the same labels)
    const sub = await __t.waitFor(() => (vis('[role=menu]').length > 1 ? vis('[role=menuitem]').filter((m) => m.textContent.trim().startsWith(label)).pop() : null), 3000); if (!sub) return 'NO SUBMENU';
    // the pointer travels from "Include secrets…" into its submenu, as a hand does: jumped there in one move, it is
    // outside Radix's pointer grace area (the submenu opens to the left at the window's edge) and the submenu closes
    const from = inc.getBoundingClientRect(); const to = sub.getBoundingClientRect();
    const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 }; const b = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
    for (let i = 1; i <= 8; i++) await __t.real.move({ x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 });
    await __t.real.click(sub);
    const dialog = await __t.waitFor(() => vis('[role=dialog], [role=alertdialog]').find((d) => /Include secrets in the file/.test(d.textContent)), 3000); if (!dialog) return 'NO CONFIRM';
    const ok = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save with secrets'); await __t.real.click(ok);
    const t = await newSaved(seen, 10000);
    return 'confirmed: ' + !!ok + ' | saved: ' + !!t + (t && t.includes('secrets masked') ? ' (but said masked)' : '');
  };
  // a tab of the response pane (the request pane has Body, Headers and Cookies tabs too, and comes first)
  const rtab = async (name) => {
    const strip = vis('main [role=tablist]').find((l) => l.parentElement.querySelector('[data-output-actions]'));
    const t = strip && [...strip.querySelectorAll('[role=tab]')].find((x) => x.textContent.trim().startsWith(name));
    t?.click(); await __t.sleep(600); return !!t;
  };
  /** Click the down arrow (or a format from its ▾ menu) with the real mouse; the toast that says where it went. */
  const save = async (id, label) => {
    // the toasts of earlier saves sit over the bottom panel's bar (the console's control): closed first, as a person would
    await clearToasts();
    const seen = new Set(savedToasts());
    if (label) {
      const menu = vis('[data-output-formats="' + id + '"]')[0]; if (!menu) return 'NO MENU BUTTON ' + id;
      await __t.real.click(menu);
      const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith(label)), 3000);
      if (!item) return 'NO FORMAT ' + label + ': ' + vis('[role=menuitem]').map((m) => m.textContent.trim()).join(' | ');
      await __t.real.click(item);
    } else {
      const b = await __t.waitFor(() => (dl(id) && !dl(id).disabled ? dl(id) : null), 15000); if (!b) return 'NO DOWNLOAD ' + id;
      await __t.real.click(b);
    }
    const t = await newSaved(seen, 20000);
    return t ? 'saved: ' + t.replace(/ to .*[\\\\/]/, ' to …/').slice(0, 120) : 'NO TOAST ' + toasts().slice(-2).join(' / ');
  };
  const send = async (url) => {
    const u = vis('main input[aria-label="Request URL"]')[0]; if (!u) return 'NO INPUT url';
    setVal(u, url); await __t.sleep(300);
    const old = vis('main [data-output-actions]')[0];
    vis('main button').find((b) => b.textContent.trim() === 'Send')?.click();
    // the response pane is replaced while the request is sent: wait for the new one, not the old one still on screen
    return (await __t.waitFor(() => { const b = dl('response.body'); return b && !b.disabled && b.closest('[data-output-actions]') !== old ? true : null; }, 15000)) ? 'ok' : 'NO RESPONSE';
  };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];
/** A step in the main process: the file the stubbed Save-as dialog got. */
const file = (name, check) => [
  name,
  `main:const fs = require('node:fs'); const p = process.env.E2E_STUB_SAVE; if (!fs.existsSync(p)) return 'NO FILE'; if (fs.existsSync(p + '.part')) return 'PART LEFT'; const buf = fs.readFileSync(p); const text = buf.toString('utf8'); ${check}`,
  false,
];

const steps = [
  step(
    'rest-body-pretty-json',
    `await __t.newTab('HTTP request');
     const r = await send('${DEMO}/echo?patient=rex&n=1'); if (r !== 'ok') return r;
     const b = dl('response.body');
     return 'aria: ' + b.getAttribute('aria-label') + ' | ' + (await save('response.body'));`,
  ),
  file(
    'rest-body-pretty-json-file',
    `const v = JSON.parse(text); return 'query: ' + JSON.stringify(v.query) + ' | pretty: ' + text.startsWith('{\\n  "') + ' | ends with newline: ' + text.endsWith('\\n');`,
  ),
  step('rest-body-raw', `return await save('response.body', 'Raw body');`),
  file('rest-body-raw-file', `const v = JSON.parse(text); return 'path: ' + v.path + ' | as received (one line): ' + !text.includes('\\n  ');`),
  step(
    'rest-body-table-csv',
    `const r = await send('${DEMO}/large?mb=0.02'); if (r !== 'ok') return r;
     return await save('response.body', 'Table as CSV');`,
  ),
  file('rest-body-table-csv-file', `const lines = text.split('\\r\\n'); return 'header: ' + lines[0] + ' | rows: ' + (lines.length > 20) + ' | crlf: ' + text.includes('\\r\\n');`),
  step(
    'rest-headers-csv',
    `const r = await send('${DEMO}/echo?n=2'); if (r !== 'ok') return r;
     if (!(await rtab('Headers'))) return 'NO TAB';
     return await save('response.headers', 'CSV');`,
  ),
  file('rest-headers-csv-file', `return 'header: ' + text.split('\\r\\n')[0] + ' | content-type: ' + /\\r\\ncontent-type,application\\/json/i.test(text);`),
  step('rest-cookies-txt', `if (!(await rtab('Cookies'))) return 'NO TAB'; return await save('response.cookies', 'cookies.txt');`),
  file('rest-cookies-txt-file', `const l = text.split('\\n'); return l[0] + ' | session: ' + l.some((x) => x.split('\\t')[5] === 'session' && x.split('\\t')[6] === 'abc123');`),
  step('rest-timeline-har', `if (!(await rtab('Timeline'))) return 'NO TAB'; return await save('response.timeline', 'HAR');`),
  file(
    'rest-timeline-har-file',
    `const h = JSON.parse(text); const e = h.log.entries[0]; return 'version: ' + h.log.version + ' | status: ' + e.response.status + ' | timings: ' + (typeof e.timings.wait === 'number');`,
  ),
  step(
    'rest-jwt-redacted',
    `const r = await send('${DEMO}/echo?id_token=${JWT}'); if (r !== 'ok') return r;
     if (!(await rtab('JWT'))) return 'NO TAB';
     const badge = !!vis('[data-output-control="response.jwt"] [data-output-redacted]')[0];
     return 'badge: ' + badge + ' | ' + (await save('response.jwt'));`,
  ),
  file('rest-jwt-redacted-file', `const v = JSON.parse(text); return 'decoded: ' + (JSON.stringify(v).includes('e2e-patient')) + ' | token in file: ' + text.includes('${JWT}');`),
  step('rest-jwt-include-secrets', `return await saveWithSecrets('response.jwt', 'JSON');`),
  file('rest-jwt-with-secrets-file', `return 'token in file: ' + text.includes('${JWT}');`),
  // the JSON tree's toolbar (the owner's screenshot): nothing scrolls the pane sideways, the filter keeps its room
  step(
    'json-toolbar-not-clipped',
    `await rtab('Body'); await __t.sleep(300);
     const f = vis('main input[aria-label="Filter with JSONPath"]')[0]; if (!f) return 'NO FILTER';
     await __t.real.click(f); await __t.real.type('$.query[not valid'); await __t.sleep(600);
     await __t.real.key('ArrowDown'); await __t.real.key('ArrowDown'); await __t.sleep(200);
     const bar = f.closest('[data-output-toolbar]');
     const scrolled = [...document.querySelectorAll('main *')].filter((e) => e.scrollLeft > 0 && getComputedStyle(e).overflowX !== 'auto' && getComputedStyle(e).overflowX !== 'scroll').length;
     const first = bar.querySelector('button'); const left = first.getBoundingClientRect().left >= bar.getBoundingClientRect().left;
     const wide = Math.round(f.getBoundingClientRect().width);
     await __t.real.key('Escape'); setVal(f, ''); await __t.sleep(300);
     return 'scrolled sideways: ' + scrolled + ' | first button inside: ' + left + ' | toolbar fits: ' + (bar.scrollWidth <= bar.clientWidth + 1) + ' | filter >= 160px: ' + (wide >= 160);`,
  ),
  step(
    'shortcut-saves-the-focused-output',
    `const seen = new Set(savedToasts());
     await __t.real.click(vis('main [data-output="response.body"]')[0]);
     await __t.real.key('S', { ctrl: true, shift: true });
     const t = await newSaved(seen, 10000);
     return t ? 'saved by the shortcut: ' + /^Response body saved/.test(t) : 'NO TOAST';`,
  ),
  ['cancel-dialog-arm', `main:process.env.E2E_STUB_SAVE_KEEP = process.env.E2E_STUB_SAVE; process.env.E2E_STUB_SAVE = 'CANCEL'; return 'armed';`, false],
  step(
    'cancelled-dialog-writes-nothing',
    `const seen = new Set(savedToasts());
     await __t.real.click(dl('response.body')); await __t.sleep(1500);
     return 'new saved toasts: ' + savedToasts().filter((t) => !seen.has(t)).length;`,
  ),
  ['cancel-dialog-disarm', `main:process.env.E2E_STUB_SAVE = process.env.E2E_STUB_SAVE_KEEP; return 'restored';`, false],
  step(
    'grpc-response-metadata-trailers',
    `await __t.newTab('gRPC');
     const target = vis('main input[aria-label="gRPC server"]')[0]; if (!target) return 'NO TARGET';
     setVal(target, '127.0.0.1:4014'); await __t.sleep(300);
     let reflect = vis('main button').find((b) => b.textContent.trim() === 'Use server reflection');
     if (!reflect) { const t = vis('main [role=tab]').find((x) => /proto|definition|service/i.test(x.textContent)); t?.click(); await __t.sleep(400); reflect = vis('main button').find((b) => b.textContent.trim() === 'Use server reflection'); }
     if (!reflect) return 'NO REFLECTION BUTTON';
     reflect.click();
     const sel = await __t.waitFor(() => { const s = vis('main select[aria-label="Method"]')[0]; return s && [...s.options].some((o) => /GetPet$/.test(o.value)) ? s : null; }, 10000); if (!sel) return 'NO METHODS';
     setSelect(sel, [...sel.options].find((o) => /GetPet$/.test(o.value)).value); await __t.sleep(400);
     const ed = window.__monaco?.editor.getEditors().find((e) => e.getDomNode()?.offsetParent && e.getDomNode().closest('main')); ed?.setValue('{ "id": "1" }'); await __t.sleep(300);
     vis('main button').find((b) => b.textContent.trim() === 'Invoke')?.click();
     const ok = await __t.waitFor(() => (dl('grpc.response') && !dl('grpc.response').disabled ? true : null), 15000); if (!ok) return 'NO RESPONSE';
     const menu = vis('[data-output-formats="grpc.response"]')[0]; await __t.real.click(menu);
     const items = await __t.waitFor(() => { const m = vis('[role=menuitem]').map((x) => x.textContent.trim()); return m.length ? m : null; }, 3000);
     await __t.real.key('Escape'); await __t.sleep(200);
     return 'formats: ' + (items ?? []).filter((l) => /^(Response|Metadata|Trailers|Everything)/.test(l)).map((l) => l.replace(/\\.\\w+$/, '')).join(', ') + ' | ' + (await save('grpc.response'));`,
  ),
  file('grpc-response-file', `const v = JSON.parse(text); return 'pet: ' + (v.name ?? v[0]?.name);`),
  step('grpc-metadata-csv', `return await save('grpc.response', 'Metadata (CSV)');`),
  file('grpc-metadata-csv-file', `return 'header: ' + text.split('\\r\\n')[0];`),
  step('grpc-everything', `return await save('grpc.response', 'Everything');`),
  file('grpc-everything-file', `const v = JSON.parse(text); return 'keys: ' + ['response', 'metadata', 'trailers'].filter((k) => k in v).join(',');`),
  step(
    'websocket-log-csv',
    `await __t.newTab('WebSocket');
     const url = vis('main input').find((i) => /url|ws:|wss:/i.test((i.getAttribute('aria-label') ?? '') + i.placeholder)); if (!url) return 'NO URL';
     setVal(url, 'ws://127.0.0.1:4013'); await __t.sleep(300);
     vis('main button').find((b) => b.textContent.trim() === 'Connect')?.click();
     if (!(await __t.waitFor(() => vis('main button').some((b) => b.textContent.trim() === 'Disconnect'), 8000))) return 'NOT CONNECTED';
     const ed = window.__monaco?.editor.getEditors().find((e) => e.getDomNode()?.offsetParent && e.getDomNode().closest('main')); if (!ed) return 'NO EDITOR';
     ed.setValue('=1+2'); await __t.sleep(200);
     vis('main button').find((b) => b.textContent.trim() === 'Send')?.click();
     await __t.waitFor(() => (dl('ws.log') && !dl('ws.log').disabled ? true : null), 5000); await __t.sleep(800);
     return await save('ws.log', 'CSV');`,
  ),
  file('websocket-log-csv-file', `return 'guarded: ' + text.includes("'=1+2") + ' | raw formula: ' + /(^|,)=1\\+2/m.test(text) + ' | echo: ' + text.includes('echo');`),
  step(
    'run-results-html-and-zip',
    `await window.aps.invoke('tests.write', { path: '${TEST_FILE}', content: ${JSON.stringify(TEST_TEXT)} });
     await __t.view('Tests'); await __t.sleep(800);
     const row = await __t.waitFor(() => vis('[data-tree-row]').find((b) => b.textContent.trim().endsWith('${TEST_FILE}')), 5000); if (!row) return 'NO ROW';
     row.click(); await __t.sleep(1000);
     if (!(await __t.button('Run'))) return 'NO RUN BUTTON';
     const ok = await __t.waitFor(() => (dl('run.results') && !dl('run.results').disabled ? true : null), 30000); if (!ok) return 'NO RESULTS';
     return await save('run.results');`,
  ),
  file('run-results-html-file', `return 'html: ' + /^<!doctype html>/i.test(text.trimStart()) + ' | names the tests: ' + (text.includes('Health') && text.includes('Echo'));`),
  step('run-results-zip', `return await save('run.results', 'All reports');`),
  file(
    'run-results-zip-file',
    `const t = buf.toString('latin1'); return 'zip: ' + (buf.readUInt32LE(0) === 0x04034b50) + ' | entries: ' + ['report.html', 'report.json', 'junit.xml', 'results.csv'].filter((n) => t.includes(n)).join(',');`,
  ),
  step(
    'console-redacted-by-default',
    `await window.aps.invoke('http.send', { name: 'e2e secret', request: { method: 'GET', url: '${DEMO}/echo?n=3', headers: [{ key: 'Authorization', value: 'Bearer e2e0secret0token0123', enabled: true }] } });
     return 'sent';`,
  ),
  step(
    'console-save',
    `const open = vis('[data-output-download="console"]')[0];
     // Ctrl+Alt+C shows the console
     if (!open) { await __t.real.key('C', { ctrl: true, alt: true }); await __t.sleep(800); }
     if (!(await __t.waitFor(() => dl('console'), 4000))) return 'NO CONSOLE CONTROL';
     const badge = !!vis('[data-output-control="console"] [data-output-redacted]')[0];
     return 'badge: ' + badge + ' | ' + (await save('console'));`,
  ),
  file('console-redacted-file', `return 'request listed: ' + text.includes('/echo?n=3') + ' | token in file: ' + text.includes('e2e0secret0token0123');`),
  // the console keeps only masked values (redacted as captured): its ▾ has no "Include secrets…" that could not keep its word
  step(
    'console-no-include-secrets',
    `await clearToasts();
     await __t.real.click(vis('[data-output-formats="console"]')[0]);
     const items = await __t.waitFor(() => { const m = vis('[role=menuitem]').map((x) => x.textContent.trim()); return m.length ? m : null; }, 3000); if (!items) return 'NO MENU';
     await __t.real.key('Escape'); await __t.sleep(200);
     return 'include secrets offered: ' + items.some((l) => l.startsWith('Include secrets')) + ' | formats: ' + items.filter((l) => /^(Text|JSON Lines)\./.test(l)).length;`,
  ),
  // one control, one look: the same buttons, size and icon in every bar
  step(
    'every-control-looks-the-same',
    `const all = [...document.querySelectorAll('[data-output-download]')];
     const shapes = new Set(all.map((b) => b.className + '|' + (b.querySelector('svg')?.getAttribute('class') ?? '')));
     const sizes = new Set(vis('[data-output-download]').map((b) => Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)));
     const last = all.every((b) => { const bar = b.closest('[data-output-actions]'); return !!bar && bar.lastElementChild?.contains(b); });
     const labels = all.every((b) => /^Download /.test(b.getAttribute('aria-label') ?? '') || /^Saving /.test(b.getAttribute('aria-label') ?? ''));
     return 'controls: ' + (all.length >= 2) + ' | one look: ' + (shapes.size === 1) + ' | one size: ' + (sizes.size <= 1) + ' | last in its bar: ' + last + ' | labelled: ' + labels;`,
  ),
  // the smallest window (960 × 700), comfortable and compact, with the right side panel pinned too: on every surface the
  // down arrow, ▾ and Copy are whole, inside the window, not clipped by their bar or a container, and nothing covers them
  // (the point under each one's centre is that button). A container query once clipped the control only after a real run.
  ['small-window', `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(960, 700); await new Promise((r) => setTimeout(r, 1500)); return 'size ' + w.getContentSize().join('x');`, false],
  step(
    'controls-fit-at-960',
    `const check = (b, mode, where) => {
       const id = b.getAttribute('data-output-download'); const box = b.closest('[data-output-control]');
       const bad = [];
       for (const el of [b, box?.querySelector('[data-output-formats]'), box?.querySelector('[data-output-copy]')]) {
         if (!el) { bad.push('part missing'); continue; }
         const r = el.getBoundingClientRect();
         if (r.width < 12 || r.height < 12) bad.push('tiny ' + Math.round(r.width) + 'x' + Math.round(r.height));
         if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) bad.push('outside the window');
         for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
           const cs = getComputedStyle(a);
           if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
           const ar = a.getBoundingClientRect();
           if (r.left < ar.left - 0.5 || r.right > ar.right + 0.5 || r.top < ar.top - 0.5 || r.bottom > ar.bottom + 0.5) { bad.push('clipped by ' + a.tagName.toLowerCase() + '.' + String(a.className).split(' ').slice(0, 3).join('.')); break; }
         }
         const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
         if (!hit || !el.contains(hit)) bad.push('covered by ' + (hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).split(' ').slice(0, 2).join('.') : 'nothing'));
       }
       return { mode, id, where, bad: [...new Set(bad)] };
     };
     const shown = () => vis('[data-output-download]');
     const all = [];
     const pass = async (mode) => {
       await clearToasts(); await __t.real.move({ x: innerWidth / 2, y: 4 });
       await __t.view('Tests'); await __t.sleep(600);
       for (const b of shown()) all.push(check(b, mode, 'Tests'));
       await __t.requests(); await __t.sleep(400);
       for (const t of vis('[role=tablist][aria-label="Open requests"] [role=tab]')) {
         t.click(); await __t.sleep(700);
         const label = t.textContent.trim().slice(0, 16);
         const strip = vis('main [role=tablist]').find((l) => l.parentElement.querySelector('[data-output-actions]'));
         const tabs = strip ? [...strip.querySelectorAll('[role=tab]')].filter((x) => /^(Body|Headers|Response|Metadata|Trailers)/.test(x.textContent.trim())) : [];
         if (!tabs.length) for (const b of shown()) all.push(check(b, mode, label));
         for (const rt of tabs) { rt.click(); await __t.sleep(500); for (const b of shown()) all.push(check(b, mode, label + ' ▸ ' + rt.textContent.trim().replace(/\\d+$/, ''))); }
       }
     };
     const panel = () => vis('[data-pinnable-panel="right"]')[0];
     await pass('comfortable');
     document.documentElement.dataset.density = 'compact'; await __t.sleep(500);
     await pass('compact');
     document.documentElement.dataset.density = 'comfortable'; await __t.sleep(300);
     // pin the right side panel (Info / Assistant): the content gets 400 px narrower
     if (panel()?.getAttribute('data-pinned') !== 'true') { panel()?.querySelector('button[aria-expanded]')?.click(); await __t.sleep(500); panel()?.querySelector('[data-pin-toggle]')?.click(); await __t.sleep(800); }
     const pinned = panel()?.getAttribute('data-pinned') === 'true';
     await pass('pinned');
     if (pinned) { panel()?.querySelector('[data-pin-toggle]')?.click(); await __t.sleep(500); }
     const problems = all.filter((x) => x.bad.length).map((x) => x.mode + ' ' + x.where + ' ' + x.id + ': ' + x.bad.join(', '));
     const surfaces = new Set(all.map((x) => x.id + '@' + x.where.replace(/ ▸ (Body|Headers)$/, ' ▸ $1')));
     return 'checked: ' + all.length + ' | surfaces: ' + new Set(all.map((x) => x.id)).size + ' | places: ' + surfaces.size + ' | problems: ' + (problems.length ? [...new Set(problems)].slice(0, 12).join(' ; ') : 'none') + ' | pinned: ' + pinned + ' || ' + [...surfaces].join(', ');`,
  ),
  ['window-back', `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); await new Promise((r) => setTimeout(r, 1200)); return 'size ' + w.getContentSize().join('x');`, false],
  ['clean-up', `(async () => { await window.aps.invoke('tests.delete', { path: '${TEST_FILE}' }).catch(() => undefined); return 'done'; })()`, false],
];

module.exports = withExpect(
  steps,
  {
    'rest-body-pretty-json': /^aria: Download response body \(JSON \(pretty\)\) \| saved: Response body saved to …\/output\.out/,
    'rest-body-pretty-json-file': /^query: \{"patient":"rex","n":"1"\} \| pretty: true \| ends with newline: true$/,
    'rest-body-raw': /^saved: Response body saved/,
    'rest-body-raw-file': /^path: \/echo \| as received \(one line\): true$/,
    'rest-body-table-csv': /^saved: Response body saved/,
    'rest-body-table-csv-file': /^header: id,name,tags \| rows: true \| crlf: true$/,
    'rest-headers-csv': /^saved: Response headers saved/,
    'rest-headers-csv-file': /^header: name,value \| content-type: true$/,
    'rest-cookies-txt': /^saved: Response cookies saved/,
    'rest-cookies-txt-file': /^# Netscape HTTP Cookie File \| session: true$/,
    'rest-timeline-har': /^saved: Response timeline saved/,
    'rest-timeline-har-file': /^version: 1\.2 \| status: 200 \| timings: true$/,
    'rest-jwt-redacted': /^badge: true \| saved: Decoded JWTs saved to …\/output\.out \(secrets masked\)/,
    'rest-jwt-redacted-file': /^decoded: true \| token in file: false$/,
    'rest-jwt-include-secrets': /^confirmed: true \| saved: true$/,
    'rest-jwt-with-secrets-file': /^token in file: true$/,
    'json-toolbar-not-clipped': /^scrolled sideways: 0 \| first button inside: true \| toolbar fits: true \| filter >= 160px: true$/,
    'shortcut-saves-the-focused-output': /^saved by the shortcut: true$/,
    'cancelled-dialog-writes-nothing': /^new saved toasts: 0$/,
    'grpc-response-metadata-trailers': /^formats: Response \(JSON\).*Metadata \(JSON\), Metadata \(CSV\), Trailers \(JSON\), Trailers \(CSV\), Everything \(JSON\) \| saved: gRPC/,
    'grpc-response-file': /^pet: Byron$/,
    'grpc-metadata-csv': /saved/,
    'grpc-metadata-csv-file': /^header: name,value$/,
    'grpc-everything': /saved/,
    'grpc-everything-file': /^keys: response,metadata,trailers$/,
    'websocket-log-csv': /saved/,
    'websocket-log-csv-file': /^guarded: true \| raw formula: false \| echo: true$/,
    'run-results-html-and-zip': /^saved: Run results saved/,
    'run-results-html-file': /^html: true \| names the tests: true$/,
    'run-results-zip': /saved/,
    'run-results-zip-file': /^zip: true \| entries: report\.html,report\.json,junit\.xml,results\.csv$/,
    'console-save': /^badge: true \| saved: Console saved/,
    'console-redacted-file': /^request listed: true \| token in file: false$/,
    'console-no-include-secrets': /^include secrets offered: false \| formats: 2$/,
    'every-control-looks-the-same': /^controls: true \| one look: true \| one size: true \| last in its bar: true \| labelled: true$/,
    // the content size comes back rounded to the display's scale (961 at 125 %)
    'small-window': /^size 9(59|60|61)x(699|700|701)$/,
    'controls-fit-at-960': (r) => {
      const m = /^checked: (\d+) \| surfaces: (\d+) \| places: (\d+) \| problems: none \| pinned: true \|\|/.exec(r);
      if (!m) return 'a control is clipped, covered or outside the window (or the panel did not pin)';
      // 8 places (REST body + headers, gRPC response / metadata / trailers, the WebSocket log, run results, the console) × 3 passes
      return Number(m[3]) >= 8 && Number(m[1]) >= 24 ? true : `too few controls checked (${m[1]} in ${m[3]} places)`;
    },
    'window-back': /^size 14(39|40|41)x(899|900|901)$/,
  },
  { env: (out) => ({ E2E_STUB_SAVE: join(out, 'output.out') }) },
);
