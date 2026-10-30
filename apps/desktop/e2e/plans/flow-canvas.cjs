// Canvas comfort in the flow designer: a double-click on the empty canvas adds a sticky note (its Markdown text saved
// in layout.notes), two selected steps get a frame (layout.frames), the minimap shows for a flow of more than 8 steps,
// toggles, and dragging in it moves the view; Ctrl+F finds a step and selects it; after a run, hovering a step shows its
// last response; a step reading a variable nothing sets is listed under the canvas and a click selects it; Ctrl+K lists
// the canvas's actions first (Auto-arrange keeps the notes and frames); Align left lines two steps up; a narrow window
// folds the toolbar's less used actions into its ⋯ menu.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const FILE = 'rest/canvas-flow.yaml';
const API = 'http://127.0.0.1:4010';
const TEXT = [
  'name: Canvas flow',
  'defaults:',
  '  type: http',
  '  assertions: [{ type: status, expected: 200 }]',
  'tests:',
  `  - { id: login, name: Log in, url: "${API}/health?step=login", extract: { token: $.status } }`,
  `  - { id: profile, name: Read the profile, url: "${API}/health?t={{token}}", dependsOn: [login] }`,
  `  - { id: orders, name: List the orders, url: "${API}/health?step=orders", dependsOn: [login] }`,
  `  - { id: teapot, name: Brew some tea, url: "${API}/health?step=teapot", dependsOn: [orders] }`,
  `  - { id: cart, name: Read the cart, url: "${API}/health?step=cart", dependsOn: [login] }`,
  `  - { id: uses-missing, name: Uses a missing value, url: "${API}/health?c={{neverSet}}", dependsOn: [cart] }`,
  `  - { id: search, name: Search, url: "${API}/health?step=search" }`,
  `  - { id: stock, name: Stock level, url: "${API}/health?step=stock", dependsOn: [search] }`,
  `  - { id: prices, name: Prices, url: "${API}/health?step=prices", dependsOn: [search] }`,
  `  - { id: logout, name: Log out, url: "${API}/health?step=logout", dependsOn: [profile, teapot] }`,
  '',
].join('\n');

// the Start node, the block picker and Deploy: an empty flow, and a one-step flow with an output for its webhook
const START_FILE = 'rest/start-flow.yaml';
const HOOK_FILE = 'rest/hook-flow.yaml';
const HOOK_TEXT = [
  'name: Hook flow',
  'output:',
  '  who: "{{who}}"',
  'tests:',
  `  - { id: echo, name: Echo who, url: "${API}/echo?who={{who}}", assertions: [{ type: status, expected: 200 }] }`,
  '',
].join('\n');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const canvas = () => document.querySelector('[data-flow-designer] [data-flow-diagram]');
  const centre = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  const pointer = (el, type, at) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const fileText = (path = ${JSON.stringify(FILE)}) => window.aps.invoke('tests.read', { path });
  const openFile = async (name) => { await __t.view('Home'); await __t.view('Tests'); await __t.sleep(600); const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)), 4000); if (!r) return false; r.click(); await __t.sleep(1200); await __t.tab('Flow'); return !!(await __t.waitFor(() => document.querySelector('[data-flow-designer]'), 5000)); };
  const click = (el, opts = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...opts }));
  const select = async (...ids) => { for (const [i, id] of ids.entries()) { click(byId(id).querySelector('rect'), { shiftKey: i > 0 }); await __t.sleep(250); } };
  const key = (el, k, mods = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  const transform = () => svg().querySelector('g[transform]').getAttribute('transform');
  /** A toolbar action: its button on a wide canvas, else the item of the toolbar's ⋯ menu. */
  const act = async (label) => {
    const b = vis('[data-flow-toolbar] [data-overflow-buttons] button').find((x) => x.textContent.trim() === label);
    if (b) { b.click(); await __t.sleep(400); return 'button'; }
    const more = vis('[data-flow-toolbar] [data-overflow-menu] button')[0]; if (!more) return 'NO MORE';
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
    const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim() === label), 2000); if (!item) return 'NO ITEM ' + label;
    item.click(); await __t.sleep(500); return 'menu';
  };
`;
const step = stepOf(H);
/**
 * Real input: mouse and keys sent by the main process through Chromium (sendInputEvent), so hit-testing, pointer
 * capture, click and dblclick happen as for a person (a dispatched event would skip them and hide such bugs).
 */
const REAL = `const { BrowserWindow } = require('electron'); const wc = BrowserWindow.getAllWindows()[0].webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code);
  const centre = (sel) => { const el = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const at = (sel) => js('(' + centre.toString() + ')(' + JSON.stringify(sel) + ')');
  const click = async (p, count = 1) => { wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await wait(30); for (let c = 1; c <= count; c++) { wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: c }); await wait(20); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: c }); await wait(60); } };
  const drag = async (p, q) => { wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await wait(30); wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); for (let i = 1; i <= 10; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + ((q.x - p.x) * i) / 10), y: Math.round(p.y + ((q.y - p.y) * i) / 10), button: 'left', modifiers: ['leftButtonDown'] }); await wait(20); } wc.sendInputEvent({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 1 }); };
  const type = async (text) => { for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await wait(10); } };
  const key = (keyCode, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };`;
const real = (name, body) => [name, `main:${REAL} ${body}`];
const resize = (name, width) => [
  name,
  `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(${width}, 900); await new Promise((r) => setTimeout(r, 1500)); return 'width ' + w.getContentSize()[0];`,
  false,
];

const steps = [
  step(
    'open-the-flow',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: ${JSON.stringify(TEXT)} });
     // the later steps' files too: the Tests view lists the files it found when it opened
     await window.aps.invoke('tests.write', { path: ${JSON.stringify(START_FILE)}, content: ${JSON.stringify('name: Start flow\ntests: []\n')} });
     await window.aps.invoke('tests.write', { path: ${JSON.stringify(HOOK_FILE)}, content: ${JSON.stringify(HOOK_TEXT)} });
     await __t.view('Tests'); await __t.sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('canvas-flow.yaml')), 4000);
     if (!r) return 'NO ROW'; r.click(); await __t.sleep(1200);
     await __t.tab('Flow');
     if (!(await __t.waitFor(() => nodes().length === 10, 8000))) return 'NODES: ' + nodes().length;
     const checks = vis('[data-flow-checks] [data-flow-check]').map((b) => b.dataset.flowCheck + ':' + b.dataset.flowCheckKind);
     return 'nodes: ' + nodes().length + ' | checks: ' + checks.join(',') + ' | marked: ' + !!byId('uses-missing').querySelector('[data-flow-unresolved]');`,
  ),
  step(
    'problem-click-selects-the-step',
    `const b = vis('[data-flow-check="uses-missing"]')[0]; if (!b) return 'NO PROBLEM'; b.click();
     const ins = await __t.waitFor(() => document.querySelector('[data-step-inspector="uses-missing"]'), 3000);
     return 'selected: ' + !!ins + ' | node: ' + byId('uses-missing').dataset.selected + ' | text: ' + b.textContent.trim();`,
  ),
  step(
    'double-click-adds-a-note',
    `const s = svg(); const r = s.getBoundingClientRect();
     // an empty spot of the canvas: the top left corner, left of the first column
     const at = { clientX: r.left + 12, clientY: r.top + 12 };
     s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ...at }));
     const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim() === 'Add note here'), 2000); if (!item) return 'NO MENU';
     item.click();
     const note = await __t.waitFor(() => vis('[data-flow-designer] [data-flow-note]')[0], 6000); if (!note) return 'NO NOTE';
     note.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
     const ta = await __t.waitFor(() => note.querySelector('textarea'), 2000); if (!ta) return 'NO EDITOR';
     ta.focus(); setInput(ta, '**Checkout** happens after login'); ta.blur();
     const saved = await until(async () => { const t = await fileText(); return /notes:/.test(t) && t.includes('**Checkout** happens after login') ? t : null; }, 6000);
     const shown = await __t.waitFor(() => vis('[data-flow-note] strong')[0]?.textContent, 4000);
     return 'saved: ' + !!saved + ' | markdown: ' + shown;`,
  ),
  real(
    'real-double-click-edits-a-note',
    `const p = await at('[data-flow-designer] [data-flow-note-paper]'); if (!p) return 'NO NOTE';
     await click(p, 2); await wait(400);
     return js("(() => { const t = document.querySelector('[data-flow-note] textarea'); return t ? 'editing: true | focused: ' + (document.activeElement === t) + ' | text: ' + t.value : 'editing: false'; })()");`,
  ),
  real(
    'typing-and-ctrl-enter-saves-the-note',
    `key('End', ['control']); await type(' (and more)'); await wait(100);
     key('Enter', ['control']); await wait(1500);
     return js("window.aps.invoke('tests.read', { path: 'rest/canvas-flow.yaml' }).then((t) => 'saved: ' + t.includes('(and more)') + ' | editing: ' + !!document.querySelector('[data-flow-note] textarea'))");`,
  ),
  real(
    'escape-cancels-an-edit',
    `const p = await at('[data-flow-designer] [data-flow-note-paper]'); if (!p) return 'NO NOTE';
     await click(p, 2); await wait(400);
     await type('zzz'); key('Escape'); await wait(1200);
     return js("window.aps.invoke('tests.read', { path: 'rest/canvas-flow.yaml' }).then((t) => 'kept: ' + !t.includes('zzz') + ' | editing: ' + !!document.querySelector('[data-flow-note] textarea') + ' | shown: ' + (document.querySelector('[data-flow-note]')?.textContent.includes('(and more)') ?? false))");`,
  ),
  real(
    'real-drag-moves-the-note',
    `const before = await js("window.aps.invoke('tests.flow', { file: 'rest/canvas-flow.yaml' }).then((f) => f.notes?.[0]?.x ?? null)");
     const p = await at('[data-flow-designer] [data-flow-note-paper]'); if (!p) return 'NO NOTE';
     await drag(p, { x: p.x + 60, y: p.y + 30 }); await wait(1500);
     const after = await js("window.aps.invoke('tests.flow', { file: 'rest/canvas-flow.yaml' }).then((f) => f.notes?.[0]?.x ?? null)");
     return 'moved right: ' + (after > before) + ' | editing: ' + (await js("!!document.querySelector('[data-flow-note] textarea')"));`,
  ),
  real(
    'real-double-click-opens-a-step',
    `const p = await at('[data-flow-designer] [data-flow-node="teapot"] rect'); if (!p) return 'NO STEP';
     await click(p, 2); await wait(1500);
     const r = await js("(() => { const e = (window.__monaco?.editor.getEditors() ?? []).find((x) => x.getDomNode()?.offsetParent); return e ? e.getModel().getLineContent(e.getPosition().lineNumber).trim().slice(0, 60) : 'NO EDITOR'; })()");
     await js("[...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim() === 'Flow')?.click()"); await wait(1200);
     return 'editor at: ' + r;`,
  ),
  step(
    'frame-two-steps',
    `await select('search', 'stock');
     const b = await __t.waitFor(() => vis('[data-flow-frame-selection]')[0], 3000); if (!b) return 'NO FRAME BUTTON'; b.click();
     const input = await __t.waitFor(() => vis('[role=dialog] input')[0], 3000); if (!input) return 'NO DIALOG';
     setInput(input, 'Catalogue'); await __t.sleep(100);
     const ok = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Frame'); if (!ok) return 'NO OK'; ok.click();
     const frame = await __t.waitFor(() => vis('[data-flow-designer] [data-flow-frame]')[0], 6000); if (!frame) return 'NO FRAME';
     const t = await fileText();
     const solid = !frame.querySelector('rect').getAttribute('stroke-dasharray');
     return 'title: ' + frame.querySelector('[data-flow-frame-title]').textContent + ' | yaml: ' + /frames:[\\s\\S]*title: Catalogue[\\s\\S]*steps: \\[ ?search, stock ?\\]/.test(t) + ' | solid: ' + solid;`,
  ),
  step(
    'minimap-toggles-and-pans',
    `const shown0 = !!vis('[data-flow-minimap]')[0];
     if (shown0) await act('Minimap');
     const hidden = !vis('[data-flow-minimap]')[0];
     await act('Minimap');
     const map = await __t.waitFor(() => vis('[data-flow-minimap]')[0], 2000); if (!map) return 'NO MINIMAP';
     const vp = map.querySelector('[data-flow-minimap-viewport]');
     const before = transform(); const r = map.getBoundingClientRect();
     pointer(map, 'pointerdown', { clientX: r.left + 20, clientY: r.top + 20 }); await __t.sleep(50);
     pointer(map, 'pointermove', { clientX: r.left + r.width - 20, clientY: r.top + r.height - 20 }); await __t.sleep(50);
     pointer(map, 'pointerup', { clientX: r.left + r.width - 20, clientY: r.top + r.height - 20 }); await __t.sleep(200);
     return 'hidden when off: ' + hidden + ' | shown when on: true | viewport: ' + !!vp + ' | view moved: ' + (transform() !== before);`,
  ),
  step(
    'ctrl-f-finds-a-step',
    `canvas().focus(); key(canvas(), 'f', { ctrlKey: true });
     const input = await __t.waitFor(() => vis('[data-flow-find] input')[0], 2000); if (!input) return 'NO FIND BOX';
     setInput(input, 'tea'); await __t.sleep(200);
     key(input, 'Enter');
     const ins = await __t.waitFor(() => document.querySelector('[data-step-inspector="teapot"]'), 3000);
     const count = vis('[data-flow-find-count]')[0]?.textContent;
     const current = byId('teapot')?.dataset.flowMatch;
     key(input, 'Escape'); await __t.sleep(200);
     return 'selected: ' + !!ins + ' | count: ' + count + ' | highlighted: ' + current + ' | closed: ' + !vis('[data-flow-find]')[0];`,
  ),
  step(
    'hover-shows-the-last-response',
    `const run = vis('[data-flow-run]')[0]; if (!run) return 'NO RUN'; run.click();
     const done = await __t.waitFor(() => nodes().length === 10 && nodes().every((n) => ['passed', 'failed', 'error', 'skipped'].includes(n.dataset.status)) ? true : null, 60000);
     if (!done) return 'NOT DONE: ' + nodes().map((n) => n.dataset.status).join(',');
     await __t.sleep(1500);
     const n = byId('orders').querySelector('rect');
     // (the real mouse may cross the window meanwhile: hover again when the card did not come)
     let card;
     for (let i = 0; i < 3 && !card; i++) {
       n.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
       n.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
       card = await __t.waitFor(() => vis('[data-flow-preview="orders"] [data-flow-preview-result]')[0], 3000);
     } if (!card) return 'NO CARD: ' + (vis('[data-flow-preview]')[0]?.textContent ?? 'none');
     const body = card.querySelector('[data-flow-preview-body]')?.textContent ?? '';
     n.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })); await __t.sleep(200);
     return 'status: ' + card.dataset.flowPreviewResult + ' | body: ' + /"status": "ok"/.test(body) + ' | gone: ' + !vis('[data-flow-preview]')[0];`,
  ),
  step(
    'align-two-steps',
    `await select('cart', 'prices');
     const b = await __t.waitFor(() => vis('[data-flow-align="left"]')[0], 3000); if (!b) return 'NO ALIGN';
     b.click();
     const f = await until(async () => { const x = await window.aps.invoke('tests.flow', { file: ${JSON.stringify(FILE)} }); const a = x.steps.find((s) => s.id === 'cart'); const c = x.steps.find((s) => s.id === 'prices'); return a?.position && c?.position ? [a.position, c.position] : null; }, 6000);
     if (!f) return 'NOT ALIGNED: ' + [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).join(' / ');
     return 'same left: ' + (f[0][0] === f[1][0]) + ' | rows differ: ' + (f[0][1] !== f[1][1]);`,
  ),
  step(
    'ctrl-k-auto-arranges',
    `canvas().focus(); key(canvas(), 'k', { ctrlKey: true });
     const pal = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Command palette"]'), 2000); if (!pal) return 'NO PALETTE';
     const first = [...pal.querySelectorAll('[role=option]')].slice(0, 2).map((o) => o.textContent.trim()).join(' / ');
     const input = pal.querySelector('input'); setInput(input, 'Auto-arrange'); await __t.sleep(200);
     const cmd = pal.querySelector('[data-command="flow-arrange"]'); if (!cmd) return 'NO AUTO-ARRANGE: ' + first; cmd.click();
     const t = await until(async () => { const x = await fileText(); return /notes:/.test(x) && !/\\n  cart: \\[/.test(x) ? x : null; }, 6000);
     return 'first: ' + first + ' | positions gone: ' + !!t + ' | notes and frames kept: ' + (!!t && /notes:/.test(t) && /frames:/.test(t));`,
  ),
  ['remember-width', `main:const { BrowserWindow } = require('electron'); global.__canvasWidth = BrowserWindow.getAllWindows()[0].getContentSize()[0]; return 'ok';`, false],
  resize('narrow-window', 900),
  step(
    'toolbar-folds-into-more',
    `const bar = vis('[data-flow-toolbar]')[0]; if (!bar) return 'NO TOOLBAR';
     const more = vis('[data-flow-toolbar] [data-overflow-menu] button')[0];
     const buttons = vis('[data-flow-toolbar] [data-overflow-buttons]').length;
     if (!more) return 'NO MORE MENU (buttons shown: ' + buttons + ')';
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
     const items = await __t.waitFor(() => { const m = vis('[role=menuitem]').map((x) => x.textContent.trim()); return m.length ? m : null; }, 2000);
     await __t.esc();
     // nothing is cut off: the last control (Fit) ends inside the toolbar
     const last = [...bar.querySelectorAll('button')].filter((b) => b.getClientRects().length).pop();
     const fits = last.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1;
     return 'one row: ' + (bar.getBoundingClientRect().height < 50) + ' | buttons hidden: ' + (buttons === 0) + ' | menu: ' + (items ?? []).join(',') + ' | fits: ' + fits;`,
  ),
  [
    'restore-width',
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(global.__canvasWidth || 1440, 900); await new Promise((r) => setTimeout(r, 1200)); return 'ok';`,
    false,
  ],
  step(
    'empty-flow-shows-start-and-suggestions',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(START_FILE)}, content: 'name: Start flow\\ntests: []\\n' });
     if (!(await openFile('start-flow.yaml'))) return 'NO ROW';
     const start = await __t.waitFor(() => vis('[data-flow-designer] [data-flow-start]')[0], 6000); if (!start) return 'NO START';
     const sugg = vis('[data-flow-designer] [data-flow-suggestion]').map((x) => x.dataset.flowSuggestion);
     const edges = vis('[data-flow-designer] [data-flow-start-edge]').length;
     return 'trigger: ' + start.querySelector('[data-flow-trigger]')?.textContent.trim() + ' | suggestions: ' + sugg.join(',') + ' | edges: ' + edges;`,
  ),
  step(
    'api-example-adds-a-runnable-step',
    `const b = vis('[data-flow-suggestion="example"] button')[0]; if (!b) return 'NO BUTTON'; b.click();
     if (!(await __t.waitFor(() => nodes().length === 1, 6000))) return 'NO NODE';
     const t = await fileText(${JSON.stringify(START_FILE)});
     const lint = await window.aps.invoke('tests.lint', { content: t, path: ${JSON.stringify(START_FILE)} });
     return 'node: ' + nodes()[0].dataset.flowNode + ' | extract: ' + /extract:[\\s\\S]*todoTitle/.test(t) + ' | check: ' + /type: status/.test(t) + ' | lint errors: ' + lint.filter((p) => p.severity === 'error').length + ' | suggestions gone: ' + !vis('[data-flow-suggestion]').length + ' | hangs off start: ' + vis('[data-flow-start-edge]').length;`,
  ),
  step(
    'port-click-opens-the-picker',
    `const port = byId('get-a-todo')?.querySelector('[data-flow-port="out"]'); if (!port) return 'NO PORT';
     const at = centre(port); pointer(port, 'pointerdown', at); await __t.sleep(50); pointer(svg(), 'pointerup', at);
     const pal = await __t.waitFor(() => vis('[data-palette="blocks"]')[0], 2000); if (!pal) return 'NO PICKER';
     const input = pal.querySelector('input'); const focused = document.activeElement === input;
     const groups = [...pal.querySelectorAll('[role=listbox] > div')].map((d) => d.textContent.trim()).slice(0, 4).join(',');
     setInput(input, 'cond'); await __t.sleep(200);
     const first = pal.querySelector('[role=option] [data-command-label]')?.textContent.trim();
     key(input, 'Enter');
     const n = await __t.waitFor(() => byId('condition'), 6000); if (!n) return 'NO CONDITION';
     const f = await window.aps.invoke('tests.flow', { file: ${JSON.stringify(START_FILE)} });
     return 'focused: ' + focused + ' | groups: ' + groups + ' | first: ' + first + ' | waits for: ' + (f.steps.find((s) => s.id === 'condition')?.dependsOn ?? []).join(',');`,
  ),
  step(
    'picker-adds-a-saved-request',
    `const add = vis('[data-flow-add]')[0]; if (!add) return 'NO BLOCK BUTTON'; add.click();
     const pal = await __t.waitFor(() => vis('[data-palette="blocks"]')[0], 2000); if (!pal) return 'NO PICKER';
     setInput(pal.querySelector('input'), 'carts'); await __t.sleep(200);
     const opt = [...pal.querySelectorAll('[role=option]')].find((o) => o.querySelector('[data-command-label]')?.textContent.trim().startsWith("A user")); if (!opt) return 'NO SAVED REQUEST';
     opt.click();
     const n = await __t.waitFor(() => nodes().find((x) => x.dataset.flowNode.startsWith('a-user')), 6000);
     return 'added: ' + !!n + ' | steps: ' + nodes().length;`,
  ),
  step(
    'add-input-is-used-by-the-run',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(HOOK_FILE)}, content: ${JSON.stringify(HOOK_TEXT)} });
     if (!(await openFile('hook-flow.yaml'))) return 'NO ROW';
     if (!(await __t.waitFor(() => nodes().length === 1, 6000))) return 'NO NODE';
     const add = vis('[data-flow-add-input]')[0]; if (!add) return 'NO ADD INPUT'; add.click();
     const row = await __t.waitFor(() => vis('[data-flow-inputs] [data-flow-input]').pop(), 2000); if (!row) return 'NO ROW';
     const [name, value] = row.querySelectorAll('input');
     name.focus(); setInput(name, 'who'); await __t.sleep(100); value.focus(); setInput(value, 'tester'); await __t.sleep(100);
     // Enter saves the inputs (as leaving them does; a test window may not have the system focus, so no blur would come)
     value.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     const saved = await until(async () => /defaults:\\s+vars:\\s+who: tester/.test(await fileText(${JSON.stringify(HOOK_FILE)})), 5000);
     vis('[data-flow-run]')[0].click();
     const done = await __t.waitFor(() => nodes()[0]?.dataset.status && nodes()[0].dataset.status !== 'running' ? nodes()[0].dataset.status : null, 30000);
     // the run's results are written as it finishes: wait for them in the history
     const input = await until(async () => {
       const runs = await window.aps.invoke('tests.flowRuns', { file: ${JSON.stringify(HOOK_FILE)} });
       if (!runs.runs[0]) return null;
       const r = await window.aps.invoke('tests.flowRunResults', { file: ${JSON.stringify(HOOK_FILE)}, runId: runs.runs[0].runId });
       return r.results[0]?.input ?? null;
     }, 10000);
     return 'saved: ' + !!saved + ' | run: ' + done + ' | sent who: ' + /who=tester/.test(input ?? '');`,
  ),
  step(
    'deploy-panel-enables-a-webhook',
    `const b = vis('[data-flow-deploy]')[0]; if (!b) return 'NO DEPLOY BUTTON'; b.click();
     const panel = await __t.waitFor(() => vis('[data-deploy-panel]')[0], 3000); if (!panel) return 'NO PANEL';
     const ready = await __t.waitFor(() => panel.querySelector('[data-deploy-target], [data-deploy-unavailable]'), 4000);
     if (!ready || panel.querySelector('[data-deploy-unavailable]')) return 'UNAVAILABLE: ' + panel.textContent.trim().slice(0, 200);
     const targets = [...panel.querySelectorAll('[data-deploy-target]')].map((x) => x.dataset.deployTarget).join(',');
     const hint = !!panel.querySelector('[data-deploy-hint]');
     const en = panel.querySelector('[data-deploy-enable-webhook]'); if (!en) return 'NO ENABLE';
     en.click();
     const written = await until(async () => /\\nwebhook:/.test(await fileText(${JSON.stringify(HOOK_FILE)})), 5000);
     const url = await __t.waitFor(() => vis('[data-deploy-webhook-url]')[0]?.textContent.trim(), 5000);
     return 'targets: ' + targets + ' | hint: ' + hint + ' | written: ' + !!written + ' | url: ' + /^POST http:\\/\\/127\\.0\\.0\\.1:\\d+\\/hooks\\//.test(url ?? '');`,
  ),
  step(
    'start-serving',
    `const s = await __t.waitFor(() => vis('[data-deploy-serve="start"]')[0], 3000); if (!s) return 'NO START';
     s.click();
     const on = await __t.waitFor(() => vis('[data-deploy-serve="stop"]')[0], 8000);
     return 'serving: ' + !!on;`,
  ),
  [
    'post-to-the-webhook',
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
     const text = await w.webContents.executeJavaScript("document.querySelector('[data-deploy-webhook-url]')?.textContent ?? ''");
     const url = text.replace(/^POST\\s+/, '').trim();
     const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: 'hooked' }) });
     const body = await res.text();
     return 'status: ' + res.status + ' | output: ' + /"who"/.test(body);`,
    false,
  ],
  step(
    'stop-serving',
    `const s = vis('[data-deploy-serve="stop"]')[0]; if (!s) return 'NO STOP'; s.click();
     const off = await __t.waitFor(() => vis('[data-deploy-serve="start"]')[0], 8000);
     const st = await window.aps.invoke('flows.webhooks.status', {});
     await __t.esc();
     return 'stopped: ' + !!off + ' | serving: ' + st.serving;`,
  ),
  step(
    'schedule-set-up-from-deploy',
    `const b = vis('[data-flow-deploy]')[0]; if (!b) return 'NO DEPLOY BUTTON';
     if (!vis('[data-deploy-panel]')[0]) b.click();
     const row = await __t.waitFor(() => vis('[data-deploy-target="schedule"]')[0], 4000); if (!row) return 'NO SCHEDULE ROW';
     const setUp = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Set up'); if (!setUp) return 'NO SET UP: ' + row.textContent;
     setUp.click();
     const create = await __t.waitFor(() => vis('button').find((x) => x.textContent.trim() === 'Create monitor'), 6000); if (!create) return 'NO MONITOR EDITOR';
     const target = vis('select[aria-label="What the monitor runs"]')[0]?.value;
     create.click();
     const st = await until(async () => { const s = await window.aps.invoke('tests.deployStatus', { file: ${JSON.stringify(HOOK_FILE)} }); return s.schedule ? s : null; }, 8000);
     if (!st) return 'NO SCHEDULE SAVED';
     if (!(await openFile('hook-flow.yaml'))) return 'NO ROW';
     vis('[data-flow-deploy]')[0].click();
     const shown = await __t.waitFor(() => { const r = vis('[data-deploy-target="schedule"]')[0]; return r && /every/.test(r.textContent) ? r.textContent : null; }, 5000);
     await __t.esc();
     return 'editor target: ' + target + ' | saved: ' + st.schedule.every + ' | panel: ' + /every 15 minutes/.test(shown ?? '');`,
  ),
  step(
    'ci-for-this-file',
    `vis('[data-flow-deploy]')[0].click();
     const row = await __t.waitFor(() => vis('[data-deploy-target="ci"]')[0], 4000); if (!row) return 'NO CI ROW';
     [...row.querySelectorAll('button')].find((x) => /Set up|Open/.test(x.textContent))?.click();
     const dlg = await __t.waitFor(() => vis('[role=dialog]').find((d) => d.textContent.includes('Run in CI')), 5000); if (!dlg) return 'NO CI DIALOG';
     const picked = [...dlg.querySelectorAll('select')][0]?.value;
     const pipeline = await __t.waitFor(() => (dlg.textContent.includes('test tests/rest/hook-flow.yaml') ? true : null), 5000);
     await __t.esc();
     return 'run: ' + picked + ' | command runs the file: ' + !!pipeline;`,
  ),
  step(
    'result-links-to-its-step',
    `const runs = await window.aps.invoke('tests.flowRuns', { file: ${JSON.stringify(HOOK_FILE)} }); if (!runs.runs[0]) return 'NO RUN';
     // the Runs tab is there once something opened it: the sidebar's Runs pane does
     [...document.querySelectorAll('[role=tablist][aria-label="Sidebar"] [role=tab]')].find((x) => x.offsetParent && x.textContent.trim().startsWith('Runs'))?.click(); await __t.sleep(800);
     document.querySelector('main [role=tab][data-tab-id="run"]')?.click(); await __t.sleep(800);
     // the run's result (the run panel selects one; a click makes sure)
     await __t.waitFor(() => vis('main button[data-result]')[0], 4000); vis('main button[data-result]')[0]?.click(); await __t.sleep(300);
     const link = await __t.waitFor(() => vis('main [data-ref-link="test"]')[0], 6000); if (!link) return 'NO REF LINK';
     link.click();
     const ed = await __t.waitFor(() => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent), 6000); if (!ed) return 'NO EDITOR';
     // the editor moves to the step once the file's steps are read
     const text = await __t.waitFor(() => { const e = (window.__monaco?.editor.getEditors() ?? []).find((x) => x.getDomNode()?.offsetParent); const t = e?.getModel().getLineContent(e.getPosition().lineNumber).trim(); return t && t.includes('Echo who') ? t : null; }, 5000);
     return 'text: ' + (text ?? 'line ' + ed.getPosition().lineNumber).slice(0, 40);`,
  ),
  // a testpion://open link to a line of a flow file (a problem, a search hit): the editor at the line, its step selected
  // on the canvas. The link arrives as from another program (a second launch of the app: Windows passes it that way).
  [
    'link-to-a-line-arrives',
    `main: const { readFileSync } = require('node:fs'); const { join } = require('node:path');
     const text = readFileSync(join(home, 'ws', 'tests', ${JSON.stringify(HOOK_FILE)}), 'utf8');
     const line = text.split(/\\r?\\n/).findIndex((l) => /id: echo/.test(l)) + 1; if (!line) return 'NO LINE';
     require('electron').app.emit('second-instance', {}, ['testpion', 'testpion://open?kind=test&path=' + encodeURIComponent(${JSON.stringify(HOOK_FILE)}) + '&line=' + line]);
     return 'sent line ' + line;`,
    false,
  ],
  step(
    'link-to-a-line-opens-the-editor-there',
    `const ed = await __t.waitFor(() => { const e = (window.__monaco?.editor.getEditors() ?? []).find((x) => x.getDomNode()?.offsetParent); return e && /id: echo/.test(e.getModel().getLineContent(e.getPosition().lineNumber)) ? e : null; }, 6000);
     const sel = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-node="echo"][data-selected]'), 4000);
     return 'editor at the line: ' + !!ed + ' | step selected on the canvas: ' + !!sel;`,
  ),
  step(
    'canvas-edit-before-an-outside-change',
    `await __t.tab('Flow');
     if (!(await __t.waitFor(() => nodes().length === 1, 6000))) return 'NO FLOW';
     const b = vis('[data-flow-add-note]')[0]; if (!b) return 'NO TEXT BUTTON'; b.click();
     const saved = await until(async () => /notes:/.test(await fileText(${JSON.stringify(HOOK_FILE)})), 5000);
     const undo = vis('[data-flow-undo]')[0];
     return 'saved: ' + !!saved + ' | undo: ' + (undo ? !undo.disabled : 'NO UNDO');`,
  ),
  [
    'file-changed-outside-the-app',
    `main:const fs = require('fs'); const p = require('path').join(home, 'ws', 'tests', 'rest', 'hook-flow.yaml');
     const t = fs.readFileSync(p, 'utf8');
     fs.writeFileSync(p, t.replace(/^tests:\\r?\\n/m, (m) => m + '  - { id: added, name: Added outside, url: "http://127.0.0.1:4010/health" }\\n'));
     return 'written';`,
    false,
  ],
  step(
    'canvas-shows-the-outside-change',
    `const n = await __t.waitFor(() => nodes().find((x) => x.dataset.flowNode === 'added'), 8000);
     const undo = vis('[data-flow-undo]')[0];
     const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => t.includes('changed on disk')), 3000);
     return 'new step: ' + !!n + ' | undo cleared: ' + (undo ? undo.disabled : 'NO UNDO') + ' | told: ' + !!toast;`,
  ),
  real(
    'run-row-right-click-menu',
    `await js("[...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Runs'))?.click()"); await wait(800);
     await js("[...document.querySelectorAll('aside [role=tab], [role=tablist] [role=tab]')].find((t) => t.offsetParent && t.textContent.trim() === 'Runs')?.click()"); await wait(800);
     const p = await at('[data-run-row]'); if (!p) return 'NO RUN ROW';
     wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await wait(30);
     wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 }); await wait(600);
     const items = await js("[...document.querySelectorAll('[role=menuitem]')].filter((m) => m.getClientRects().length).map((m) => m.textContent.trim()).join(',')");
     key('Escape'); await wait(300);
     return 'menu: ' + items;`,
  ),
  step(
    'editor-has-unsaved-edits',
    `const tabEl = [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.getAttribute('data-tab-id') === 'file:' + ${JSON.stringify(HOOK_FILE)}); if (!tabEl) return 'NO FILE TAB'; tabEl.click(); await __t.sleep(1200);
     const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent); if (!ed) return 'NO EDITOR';
     const m = ed.getModel(); m.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '# my unsaved note\\n' }]); await __t.sleep(300);
     return 'dirty: ' + m.getValue().startsWith('# my unsaved note');`,
  ),
  [
    'file-changed-outside-again',
    `main:const fs = require('fs'); const p = require('path').join(home, 'ws', 'tests', 'rest', 'hook-flow.yaml');
     fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('name: Hook flow', 'name: Hook flow (pulled)'));
     return 'written';`,
    false,
  ],
  step(
    'keep-or-take-is-asked',
    `const dlg = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes('changed on disk')), 8000); if (!dlg) return 'NOT ASKED';
     const buttons = [...dlg.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /Keep|Take/.test(t));
     [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Take the new version').click();
     const text = await __t.waitFor(() => { const e = (window.__monaco?.editor.getEditors() ?? []).find((x) => x.getDomNode()?.offsetParent); const v = e?.getValue() ?? ''; return v.includes('(pulled)') ? v : null; }, 5000);
     return 'asked: ' + buttons.join(' / ') + ' | taken: ' + !!text + ' | my edit dropped: ' + (!!text && !text.includes('# my unsaved note'));`,
  ),
];

module.exports = withExpect(
  steps,
  {
  'open-the-flow': /^nodes: 10 \| checks: uses-missing:unset-variable \| marked: true$/,
  'problem-click-selects-the-step': /^selected: true \| node: true \| text: "Uses a missing value" reads \{\{neverSet\}\}/,
  'double-click-adds-a-note': /^saved: true \| markdown: Checkout$/,
  'frame-two-steps': /^title: Catalogue \| yaml: true \| solid: true$/,
  'minimap-toggles-and-pans': /^hidden when off: true \| shown when on: true \| viewport: true \| view moved: true$/,
  'ctrl-f-finds-a-step': /^selected: true \| count: 1 of 1 \| highlighted: current \| closed: true$/,
  'hover-shows-the-last-response': /^status: passed \| body: true \| gone: true$/,
  'align-two-steps': /^same left: true \| rows differ: true$/,
  'ctrl-k-auto-arranges': /^first: Add step: HTTP request.* \| positions gone: true \| notes and frames kept: true$/,
  'toolbar-folds-into-more': /^one row: true \| buttons hidden: true \| menu: Undo,Redo,History,Auto-arrange,Find,Minimap,Snap \| fits: true$/,
  'empty-flow-shows-start-and-suggestions': /^trigger: Manual \| suggestions: blocks,example,collection,record,ai \| edges: 5$/,
  'api-example-adds-a-runnable-step': /^node: get-a-todo \| extract: true \| check: true \| lint errors: 0 \| suggestions gone: true \| hangs off start: 1$/,
  'port-click-opens-the-picker': /^focused: true \| groups: Requests,Logic,Data,Flow \| first: Condition \(if \/ else\) \| waits for: get-a-todo$/,
  'picker-adds-a-saved-request': /^added: true \| steps: 3$/,
  'add-input-is-used-by-the-run': /^saved: true \| run: passed \| sent who: true$/,
  'deploy-panel-enables-a-webhook': /^targets: schedule,webhook,mcp,ci \| hint: true \| written: true \| url: true$/,
  'start-serving': /^serving: true$/,
  'post-to-the-webhook': /^status: 200 \| output: true$/,
  'stop-serving': /^stopped: true \| serving: false$/,
  'schedule-set-up-from-deploy': /^editor target: file \| saved: every 15 minutes \| panel: true$/,
  'ci-for-this-file': /^run: file:rest\/hook-flow\.yaml \| command runs the file: true$/,
  'result-links-to-its-step': /^text: - \{ id: echo, name: Echo who/,
  'link-to-a-line-arrives': /^sent line \d+$/,
  'link-to-a-line-opens-the-editor-there': /^editor at the line: true \| step selected on the canvas: true$/,
  'real-double-click-edits-a-note': /^editing: true \| focused: true \| text: \*\*Checkout\*\* happens after login$/,
  'typing-and-ctrl-enter-saves-the-note': /^saved: true \| editing: false$/,
  'escape-cancels-an-edit': /^kept: true \| editing: false \| shown: true$/,
  'real-drag-moves-the-note': /^moved right: true \| editing: false$/,
  'real-double-click-opens-a-step': /^editor at: - \{ id: teapot, name: Brew some tea/,
  'canvas-edit-before-an-outside-change': /^saved: true \| undo: true$/,
  'canvas-shows-the-outside-change': /^new step: true \| undo cleared: true \| told: true$/,
  'run-row-right-click-menu': /^menu: Open,(Rerun failed,)?Copy link,Copy CLI command,Copy run id,Export report…,Run in CI…$/,
  'editor-has-unsaved-edits': /^dirty: true$/,
  'keep-or-take-is-asked': /^asked: Keep mine \/ Take the new version \| taken: true \| my edit dropped: true$/,
},
  {
    // a plan before this one may have left the demo RAG system on port 4020, the default port of a flow's webhook
    async prepare() {
      const s = globalThis.__e2eRagServer;
      if (s) (delete globalThis.__e2eRagServer, await s.close());
    },
  },
);
