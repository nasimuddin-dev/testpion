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

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim());
  const dl = (id) => vis('[data-output-download="' + id + '"]')[0];
  /** Click the down arrow (or a format from its ▾ menu) with the real mouse; the toast that says where it went. */
  const save = async (id, label) => {
    const before = toasts().filter((t) => / saved to /.test(t)).length;
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
    const t = await __t.waitFor(() => { const s = toasts().filter((x) => / saved to /.test(x)); return s.length > before ? s[s.length - 1] : null; }, 20000);
    return t ? 'saved: ' + t.replace(/ to .*[\\\\/]/, ' to …/').slice(0, 120) : 'NO TOAST ' + toasts().slice(-2).join(' / ');
  };
  const send = async (url) => {
    const u = vis('main input[aria-label="Request URL"]')[0]; if (!u) return 'NO INPUT url';
    setVal(u, url); await __t.sleep(300);
    vis('main button').find((b) => b.textContent.trim() === 'Send')?.click();
    return (await __t.waitFor(() => (dl('response.body') && !dl('response.body').disabled ? true : null), 15000)) ? 'ok' : 'NO RESPONSE';
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
     if (!(await __t.tab('Headers'))) return 'NO TAB';
     return await save('response.headers', 'CSV');`,
  ),
  file('rest-headers-csv-file', `return 'header: ' + text.split('\\r\\n')[0] + ' | content-type: ' + /\\r\\ncontent-type,application\\/json/i.test(text);`),
  step('rest-cookies-txt', `if (!(await __t.tab('Cookies'))) return 'NO TAB'; return await save('response.cookies', 'cookies.txt');`),
  file('rest-cookies-txt-file', `const l = text.split('\\n'); return l[0] + ' | session: ' + l.some((x) => x.split('\\t')[5] === 'session' && x.split('\\t')[6] === 'abc123');`),
  step('rest-timeline-har', `if (!(await __t.tab('Timeline'))) return 'NO TAB'; return await save('response.timeline', 'HAR');`),
  file(
    'rest-timeline-har-file',
    `const h = JSON.parse(text); const e = h.log.entries[0]; return 'version: ' + h.log.version + ' | status: ' + e.response.status + ' | timings: ' + (typeof e.timings.wait === 'number');`,
  ),
  // the JSON tree's toolbar (the owner's screenshot): nothing scrolls the pane sideways, the filter keeps its room
  step(
    'json-toolbar-not-clipped',
    `await __t.tab('Body'); await __t.sleep(300);
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
    `const before = toasts().filter((t) => / saved to /.test(t)).length;
     await __t.real.click(vis('main [data-output="response.body"]')[0]);
     await __t.real.key('S', { ctrl: true, shift: true });
     const t = await __t.waitFor(() => { const s = toasts().filter((x) => / saved to /.test(x)); return s.length > before ? s[s.length - 1] : null; }, 10000);
     return t ? 'saved by the shortcut: ' + /^Response body saved/.test(t) : 'NO TOAST';`,
  ),
  ['cancel-dialog-arm', `main:process.env.E2E_STUB_SAVE_KEEP = process.env.E2E_STUB_SAVE; process.env.E2E_STUB_SAVE = 'CANCEL'; return 'armed';`, false],
  step(
    'cancelled-dialog-writes-nothing',
    `const before = toasts().length;
     await __t.real.click(dl('response.body')); await __t.sleep(1500);
     return 'new saved toasts: ' + toasts().slice(before).filter((t) => / saved to /.test(t)).length;`,
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
  step(
    'console-include-secrets',
    `const before = toasts().filter((t) => / saved to /.test(t)).length;
     await __t.real.click(vis('[data-output-formats="console"]')[0]);
     const inc = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith('Include secrets')), 3000); if (!inc) return 'NO INCLUDE SECRETS';
     await __t.real.click(inc);
     // the submenu's "Text" (the last one: the format list above has a "Text" too)
     const sub = await __t.waitFor(() => vis('[role=menu]').length > 1 ? vis('[role=menuitem]').filter((m) => m.textContent.trim().startsWith('Text')).pop() : null, 3000); if (!sub) return 'NO SUBMENU';
     await __t.real.click(sub);
     const dialog = await __t.waitFor(() => vis('[role=dialog], [role=alertdialog]').find((d) => /Include secrets in the file/.test(d.textContent)), 3000); if (!dialog) return 'NO CONFIRM';
     const ok = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save with secrets'); await __t.real.click(ok);
     const t = await __t.waitFor(() => { const s = toasts().filter((x) => / saved to /.test(x)); return s.length > before ? s[s.length - 1] : null; }, 10000);
     return 'confirmed: ' + !!ok + ' | saved: ' + !!t;`,
  ),
  file('console-with-secrets-file', `return 'token in file: ' + text.includes('e2e0secret0token0123');`),
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
    'json-toolbar-not-clipped': /^scrolled sideways: 0 \| first button inside: true \| toolbar fits: true \| filter >= 160px: true$/,
    'shortcut-saves-the-focused-output': /^saved by the shortcut: true$/,
    'cancelled-dialog-writes-nothing': /^new saved toasts: 0$/,
    'grpc-response-metadata-trailers': /^formats: Response \(JSON\).*Metadata \(JSON\), Metadata \(CSV\), Trailers \(JSON\), Trailers \(CSV\), Everything \(JSON\) \| saved: gRPC/,
    'grpc-response-file': /^pet: Rex$/,
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
    'console-include-secrets': /^confirmed: true \| saved: true$/,
    'console-with-secrets-file': /^token in file: true$/,
    'every-control-looks-the-same': /^controls: true \| one look: true \| one size: true \| last in its bar: true \| labelled: true$/,
  },
  { env: (out) => ({ E2E_STUB_SAVE: join(out, 'output.out') }) },
);
