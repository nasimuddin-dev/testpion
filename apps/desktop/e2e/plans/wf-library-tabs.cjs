// WF-19 One tab model: saved load tests open as tabs like every editor — a click in the list opens a preview tab (in
// italics) that the next click replaces, a double-click keeps it, each tab keeps its own edits, and Evaluations has
// the same strip. The same for HTTP requests (a click in the explorer previews), saved AI prompts (the Model
// comparison keeps a draft of its own), environments (each tab its own unsaved edits) and Debugger sessions (a saved
// session opens in a tab beside the live capture).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  mkdirSync(join(ws, 'library'), { recursive: true });
  const item = (id, name, url) => ({ id, name, data: { kind: 'http', method: 'GET', url, headers: [], vus: 2, duration: 5 } });
  writeFileSync(
    join(ws, 'library', 'load-tests.json'),
    JSON.stringify({ folders: [], items: [item('lt-a', 'E2E load A', 'http://127.0.0.1:4010/health?a'), item('lt-b', 'E2E load B', 'http://127.0.0.1:4010/health?b')] }, null, 2),
  );
  // a second environment, and a saved Debugger session
  writeFileSync(join(ws, 'environments', 'e2e-staging.json'), JSON.stringify({ id: 'e2e-staging', name: 'E2E staging', variables: [{ key: 'baseUrl', value: 'http://127.0.0.1:4010', enabled: true }] }, null, 2));
  mkdirSync(join(ws, 'debugger'), { recursive: true });
  const entry = (i) => ({
    startedDateTime: new Date(Date.parse('2026-10-01T10:00:00Z') + i * 1000).toISOString(),
    time: 10,
    request: { method: 'GET', url: 'http://saved.test/item/' + i, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
    response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 2, mimeType: 'application/json', text: '{}' }, redirectURL: '', headersSize: -1, bodySize: 2 },
    cache: {},
    timings: { send: 1, wait: 8, receive: 1 },
  });
  writeFileSync(join(ws, 'debugger', 'e2e-session.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: [entry(1), entry(2), entry(3)] } }));
}

const H = `
  const strip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open load tests"] [role=tab]')];
  const names = () => strip().map((t) => t.textContent.trim() + (t.hasAttribute('data-preview') ? '(preview)' : '')).join(', ');
  const item = (n) => [...document.querySelectorAll('[data-tree-row]')].find((r) => r.getAttribute('data-row-name') === n);
  const url = () => [...document.querySelectorAll('main input')].find((i) => /4010\\/health/.test(i.value))?.value;
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;

const steps = [
  step(
    'preview-replaced',
    `${H}
     await __t.view('Load'); await __t.sleep(800);
     const a = await __t.waitFor(() => item('E2E load A'), 4000); if (!a) return 'NO ITEM';
     a.click(); await __t.sleep(600);
     const first = names();
     item('E2E load B').click(); await __t.sleep(600);
     return first + ' → ' + names();`,
  ),
  step(
    'double-click-keeps',
    `${H}
     const t = strip().find((x) => /E2E load B/.test(x.textContent)); if (!t) return 'NO TAB';
     t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(400);
     item('E2E load A').click(); await __t.sleep(600);
     return names();`,
  ),
  step(
    'each-tab-its-own-edits',
    `${H}
     const b = strip().find((x) => /E2E load B/.test(x.textContent)); b.click(); await __t.sleep(500);
     const input = [...document.querySelectorAll('main input')].find((i) => /4010\\/health/.test(i.value)); if (!input) return 'NO URL FIELD';
     setVal(input, 'http://127.0.0.1:4010/health?edited'); await __t.sleep(400);
     strip().find((x) => /E2E load A/.test(x.textContent)).click(); await __t.sleep(500);
     const inA = url();
     strip().find((x) => /E2E load B/.test(x.textContent)).click(); await __t.sleep(500);
     return 'A: ' + inA + ' | B: ' + url();`,
  ),
  step(
    'evaluations-has-tabs',
    `await __t.view('Evaluations'); await __t.sleep(800);
     return 'strip: ' + !!document.querySelector('[role=tablist][aria-label="Open evaluations"]');`,
  ),
  // closing the last tab shows that nothing is open (and a button for a new one), as in the request editors
  step(
    'last-tab-closes',
    `await __t.view('Evaluations'); await __t.sleep(600);
     const strip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open evaluations"] [role=tab]')];
     for (const t of strip()) { t.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); await __t.sleep(300); }
     const empty = !!(await __t.waitFor(() => /No open evaluations/.test(document.body.innerText), 3000));
     const none = strip().length;
     const btn = [...document.querySelectorAll('main button, button')].find((b) => b.offsetParent && /^New evaluation$/.test(b.textContent.trim()));
     if (btn) { btn.click(); await __t.sleep(600); }
     return 'empty: ' + empty + ', tabs: ' + none + ', new: ' + !!btn + ' → tabs: ' + strip().length + ', editor: ' + !!document.querySelector('[aria-label="Evaluation name"]');`,
  ),
  // HTTP requests: a click in the explorer opens the request in a tab of its own (never replacing another) and shows it;
  // a request already open is shown, not opened again
  step(
    'requests-open-in-tabs',
    `const http = () => [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].filter((t) => /^(GET|POST|PUT|PATCH|DELETE)/.test(t.textContent.trim()));
     const label = () => http().map((t) => t.textContent.trim().replace(/^(GET|POST|PUT|PATCH|DELETE)/, '') + (t.hasAttribute('data-preview') ? '(preview)' : '') + (t.getAttribute('aria-selected') === 'true' ? '*' : '')).join(', ');
     await __t.requests(); await __t.sleep(500);
     // start from no request tabs
     for (const t of http()) { t.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); await __t.sleep(150); }
     const f = document.querySelector('aside input[placeholder^="Filter"]');
     const set = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
     const click = async (n) => {
       set(n); await __t.sleep(900);
       const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.getAttribute('aria-expanded') === null && b.textContent.trim().endsWith(n));
       if (r) { await __t.real.click(r); await __t.sleep(1000); }
       set(''); await __t.sleep(400);
       return !!r;
     };
     for (const n of ['Custom headers', 'GET with query parameters']) if (!(await click(n))) return 'NO ROW ' + n;
     const two = label();
     if (!(await click('Custom headers'))) return 'NO ROW again';
     return two + ' → ' + label();`,
  ),
  // saved prompts: the same tabs; the Model comparison has its own prompt
  step(
    'prompts-preview-and-own-compare',
    `${H}
     const pstrip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open prompts"] [role=tab]')];
     const pnames = () => pstrip().map((t) => t.textContent.trim() + (t.hasAttribute('data-preview') ? '(preview)' : '')).join(', ');
     await __t.view('AI Lab'); await __t.sleep(800); await __t.tab('Playground'); await __t.sleep(800);
     const a = await __t.waitFor(() => item('Classify intent (JSON)'), 4000); if (!a) return 'NO SAVED PROMPT';
     a.click(); await __t.sleep(600);
     item('Summarise a text').click(); await __t.sleep(600);
     const first = pnames();
     const editorText = () => (window.__monaco?.editor.getEditors() ?? []).filter((e) => e.getDomNode()?.offsetParent).map((e) => e.getValue()).join(' ');
     const inPlayground = editorText();
     await __t.tab('Model comparison'); await __t.sleep(1000);
     const inCompare = editorText();
     await __t.tab('Playground'); await __t.sleep(500);
     return first + ' | compare has its own prompt: ' + (!!inCompare && !inCompare.includes('Summarise') && /summari[sz]e/i.test(inPlayground));`,
  ),
  // environments: tabs with their own unsaved edits
  step(
    'environments-tabs-keep-edits',
    `const estrip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open environments"] [role=tab]')];
     const enames = () => estrip().map((t) => t.textContent.trim().replace(/[●•]$/, '') + (t.hasAttribute('data-preview') ? '(preview)' : '')).join(', ');
     const row = (n) => [...document.querySelectorAll('main [data-tree-row]')].find((r) => r.offsetParent && r.textContent.includes(n));
     const nameField = () => [...document.querySelectorAll('main input')].find((i) => i.offsetParent && i.closest('label')?.textContent.startsWith('Name'));
     await __t.view('Environments'); await __t.sleep(800);
     if (!(await __t.waitFor(() => row('E2E staging'), 4000))) return 'NO ENV ROW';
     // the first environment is open when the view opens; a click on another previews it, a double-click keeps it
     await __t.real.click(row('Public APIs')); await __t.sleep(500);
     const previewed = enames();
     await __t.real.dblclick(row('Public APIs')); await __t.sleep(500);
     const f = nameField(); if (!f) return 'NO NAME FIELD';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'Public APIs edited'); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     estrip().find((t) => /E2E staging/.test(t.textContent))?.click(); await __t.sleep(400);
     const other = nameField()?.value;
     estrip().find((t) => /Public APIs/.test(t.textContent))?.click(); await __t.sleep(400);
     return previewed + ' → ' + enames() + ' | other tab: ' + other + ' | kept edit: ' + nameField()?.value;`,
  ),
  // Debugger: a saved session opens in a tab beside the live capture, which stays where it was
  step(
    'debugger-session-tab',
    `const dstrip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open sessions"] [role=tab]')];
     await __t.view('Debugger'); await __t.sleep(800);
     await window.aps.invoke('debug.clear');
     const sessionsBtn = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && /^Session/.test(b.textContent.trim()));
     if (!sessionsBtn) return 'NO SESSION MENU';
     sessionsBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); sessionsBtn.click();
     const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Open e2e-session/.test(m.textContent.trim())), 3000);
     if (!it) { await __t.esc(); return 'NO SESSION ITEM'; }
     it.click();
     const rows = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].filter((r) => /saved\.test/.test(r.textContent)).length === 3, 5000);
     const tabs = dstrip().map((t) => t.textContent.trim()).join(', ');
     const bar = !!document.querySelector('[data-session-tab="e2e-session"]');
     dstrip().find((t) => /Live capture/.test(t.textContent))?.click(); await __t.sleep(800);
     const liveClean = ![...document.querySelectorAll('main [role=row]')].some((r) => /saved\.test/.test(r.textContent));
     return 'tabs: ' + tabs + ' | rows: ' + !!rows + ' | bar: ' + bar + ' | live untouched: ' + liveClean;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'preview-replaced': /^E2E load A\(preview\) → E2E load B\(preview\)$/,
    'double-click-keeps': /^E2E load B, E2E load A\(preview\)$/,
    'each-tab-its-own-edits': /^A: http:\/\/127\.0\.0\.1:4010\/health\?a \| B: http:\/\/127\.0\.0\.1:4010\/health\?edited$/,
    'evaluations-has-tabs': /^strip: true$/,
    'last-tab-closes': /^empty: true, tabs: 0, new: true → tabs: 1, editor: true$/,
    'requests-open-in-tabs': /^Custom headers, GET with query parameters\* → Custom headers\*, GET with query parameters$/,
    'prompts-preview-and-own-compare': /^Summarise a text\(preview\) \| compare has its own prompt: true$/,
    'environments-tabs-keep-edits': /^E2E staging, Public APIs\(preview\) → E2E staging, Public APIs \| other tab: E2E staging \| kept edit: Public APIs edited$/,
    'debugger-session-tab': /^tabs: Live capture, e2e-session \| rows: true \| bar: true \| live untouched: true$/,
  },
  { prepare },
);
