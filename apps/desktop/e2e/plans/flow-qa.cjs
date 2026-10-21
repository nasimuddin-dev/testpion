// QA of the flow canvas with REAL input: every mouse press, drag, wheel and key goes through Chromium's input pipeline
// (__t.real, e2e/real-input.cjs: the DevTools protocol's Input domain), so hit-testing, pointer capture, focus and the
// click / dblclick / contextmenu the browser synthesises are a user's. (Events dispatched on an element from the page
// skip all that: the sticky-note double-click bug passed such a test and failed for every user.)
// Covers the empty flow (Start, triggers, inputs, suggestions), the block picker (port click, port +, a dropped
// connection, the toolbar, search, arrows, Enter, Esc, every block type, saved requests), selection, dragging (snap,
// guides), connecting (and a refused cycle), edges, delete / duplicate / copy / paste / undo / redo, the inspector of
// every block type, sticky notes, frames, parallel / finally lanes, the minimap, zoom, pan, find, the hover card, the
// problems strip, Ctrl+K, align / distribute, Auto-arrange, the toolbar at narrow widths, runs (breakpoints, from the
// selection, pins, history), Deploy, Editor <-> canvas sync, keyboard focus, right-click menus, themes and a 200-step flow.
// Steps marked KNOWN-FAIL in their comment assert the expected behaviour of a bug reported to the canvas owner.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';
const F_EMPTY = 'rest/qa-empty.yaml';
const F_MAIN = 'rest/qa-flow.yaml';
const F_BLOCKS = 'rest/qa-blocks.yaml';
const F_BIG = 'rest/qa-big.yaml';
const F_SUB = 'rest/qa-sub.yaml';
const MAIN = [
  'name: QA flow',
  'defaults:',
  '  type: http',
  '  assertions: [{ type: status, expected: 200 }]',
  'tests:',
  `  - { id: login, name: Log in, url: "${API}/health?step=login", extract: { token: $.status } }`,
  `  - { id: profile, name: Read the profile, url: "${API}/health?t={{token}}", dependsOn: [login] }`,
  `  - { id: orders, name: List the orders, url: "${API}/health?step=orders", dependsOn: [login] }`,
  `  - { id: check, name: Orders ok, type: condition, if: "status == 200", dependsOn: [orders], assertions: [] }`,
  `  - { id: happy, name: Happy path, url: "${API}/health?step=happy", dependsOn: [check], when: true }`,
  `  - { id: logout, name: Log out, url: "${API}/health?c={{neverSet}}", dependsOn: [profile] }`,
  '',
].join('\n');
// 200 steps: 20 chains of 10
const BIG = [
  'name: QA big',
  'defaults:',
  '  type: http',
  '  assertions: [{ type: status, expected: 200 }]',
  'tests:',
  ...Array.from({ length: 200 }, (_, i) => `  - { id: s${i}, name: Step ${i}, url: "${API}/health?i=${i}"${i % 10 ? `, dependsOn: [s${i - 1}]` : ''} }`),
  '',
].join('\n');
const SUB = ['name: QA sub', 'tests:', `  - { id: s1, name: Sub one, url: "${API}/health" }`, ''].join('\n');
const PALETTE_BLOCKS = [
  ['HTTP request', 'http'],
  ['GraphQL', 'graphql'],
  ['gRPC call', 'grpc'],
  ['WebSocket', 'websocket'],
  ['MCP tool call', 'mcp'],
  ['LLM prompt', 'llm'],
  ['Condition (if / else)', 'condition'],
  ['For each (loop)', 'http'],
  ['Wait until (poll)', 'http'],
  ['Delay', 'delay'],
  ['Finally (clean-up)', 'http'],
  ['Set variable', 'set'],
  ['Script', 'script'],
  ['Assert', 'assert'],
  ['Log', 'log'],
  ['Sub-flow', 'flow'],
];

const H = `
  const R = __t.real;
  const sleep = __t.sleep;
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  /** A node's box (the rect drawn for it), the target of a click on the step. */
  const box = (id) => { const g = byId(id); return g && [...g.children].find((c) => c.tagName === 'rect' && !c.hasAttribute('x')); };
  const port = (id, when) => byId(id)?.querySelector(when === undefined ? '[data-flow-port="out"]' : '[data-flow-port="out"][data-flow-when="' + when + '"]');
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const canvas = () => document.querySelector('[data-flow-designer] [data-flow-diagram]');
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const fileText = (p) => window.aps.invoke('tests.read', { path: p });
  const flowOf = (p) => window.aps.invoke('tests.flow', { file: p });
  const stepOf = async (p, id) => (await flowOf(p)).steps.find((s) => s.id === id);
  const selected = () => nodes().filter((n) => n.dataset.selected).map((n) => n.dataset.flowNode).join(',') || 'none';
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).join(' / ');
  const transform = () => svg().querySelector('g[transform]').getAttribute('transform');
  const scale = () => Number(/scale\\(([\\d.]+)\\)/.exec(transform())?.[1]);
  const menuItems = () => vis('[role=menuitem]').map((m) => m.textContent.trim());
  const menuItem = (label) => vis('[role=menuitem]').find((m) => m.textContent.trim() === label) ?? vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith(label));
  const palette = () => vis('[data-palette="blocks"]')[0];
  const options = () => [...(palette()?.querySelectorAll('[role=option]') ?? [])];
  const activeOption = () => palette()?.querySelector('[role=option][aria-selected="true"] [data-command-label]')?.textContent.trim();
  const inspector = () => vis('[data-flow-inspector]')[0];
  const tabEl = (name) => vis('[role=tablist][aria-label="Open test files"] [role=tab]').find((x) => { const t = x.textContent.trim(); return t === name || t.endsWith(name) || (t.startsWith(name) && !/\\.ya?ml/.test(t)); });
  const notesEl = () => vis('[data-flow-designer] [data-flow-note]');
  const paper = (n) => n.querySelector('[data-flow-note-paper]');
  /** A point of the empty canvas (nothing but the svg under it and around it), searched from (fx, fy) of the canvas. */
  const emptySpot = (fx = 0, fy = 0) => {
    const s = svg(); const r = s.getBoundingClientRect();
    const free = (x, y) => [[0, 0], [28, 0], [-28, 0], [0, 28], [0, -28], [28, 28], [-28, -28]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === s);
    for (let y = r.top + 40 + fy * (r.height - 80); y < r.bottom - 40; y += 20) for (let x = r.left + 40 + fx * (r.width - 80); x < r.right - 40; x += 20) if (free(x, y)) return { x, y };
    for (let y = r.top + 40; y < r.bottom - 40; y += 20) for (let x = r.left + 40; x < r.right - 40; x += 20) if (free(x, y)) return { x, y };
    return null;
  };
  /** A point on an edge's hit path, on screen (the middle, or along it), with the path itself under it. */
  const edgePoint = (key) => {
    const p = vis('[data-flow-edge-hit="' + key + '"]')[0]; if (!p) return null;
    const L = p.getTotalLength(); const m = p.getScreenCTM();
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) { const q = p.getPointAtLength(L * f); const x = m.a * q.x + m.c * q.y + m.e; const y = m.b * q.x + m.d * q.y + m.f; if (document.elementFromPoint(x, y) === p) return { x, y }; }
    return null;
  };
  const openFile = async (name) => {
    await __t.esc(); await __t.view('Home'); await __t.view('Tests'); await sleep(600);
    const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)), 4000); if (!r) return false;
    r.scrollIntoView({ block: 'center' }); await sleep(200);
    await R.click(r); await sleep(1200);
    if (!(await __t.waitFor(() => tabEl(name)?.getAttribute('aria-selected') === 'true', 3000))) return false;
    // (the tab strip scrolls to the opened file's tab: the Flow tab is clicked once it stopped moving)
    await sleep(600); const t = await __t.waitFor(() => tabEl('Flow'), 3000); if (!t) return false;
    t.scrollIntoView({ inline: 'nearest', block: 'nearest' }); await sleep(300); await R.click(t);
    if (!(await __t.waitFor(() => tabEl('Flow')?.getAttribute('aria-selected') === 'true', 1500))) { await sleep(500); await R.click(tabEl('Flow')); }
    return !!(await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-start]') && tabEl('Flow')?.getAttribute('aria-selected') === 'true', 8000));
  };
  /** A toolbar action: its button on a wide canvas, else the item of the toolbar's ⋯ menu (real clicks). */
  const act = async (label) => {
    const b = vis('[data-flow-toolbar] [data-overflow-buttons] button').find((x) => x.textContent.trim() === label);
    if (b) { await R.click(b); await sleep(300); return 'button'; }
    const more = vis('[data-flow-toolbar] [data-overflow-menu] button')[0]; if (!more) return 'NO MORE';
    await R.click(more);
    const item = await __t.waitFor(() => menuItem(label), 2000); if (!item) return 'NO ITEM ' + label;
    await R.click(item); await sleep(400); return 'menu';
  };
  const pickMenu = async (label) => { const it = await __t.waitFor(() => menuItem(label), 2500); if (!it) return false; await R.click(it); await sleep(400); return true; };
  /** Choose a block in the open picker by its exact label (typed, then clicked). */
  const choose = async (label) => {
    const pal = await __t.waitFor(() => palette(), 2500); if (!pal) return 'NO PICKER';
    await R.type(label); await sleep(250);
    const o = options().find((x) => x.querySelector('[data-command-label]')?.textContent.trim() === label); if (!o) return 'NO OPTION ' + label + ' in ' + options().map((x) => x.textContent.trim()).slice(0, 5).join(',');
    // (a user scrolls the list to it: an exact match is not always first, see picker-search-ranks-the-exact-match-first)
    o.scrollIntoView({ block: 'nearest' }); await sleep(100);
    await R.click(o); await sleep(300); return '';
  };
  const selectStep = async (id, o = {}) => { const b = box(id); if (!b) return false; await R.click(b, { fx: 0.4, fy: 0.3, ...o }); await sleep(250); return true; };
  /** Steps (and notes over steps) drawn on top of each other, by screen boxes: 'none', or the pairs. */
  const overlaps = () => {
    const rs = nodes().map((n) => [n.dataset.flowNode, box(n.dataset.flowNode).getBoundingClientRect()]).concat(notesEl().map((n, i) => ['note' + i, paper(n).getBoundingClientRect()]));
    const out = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const [a, p] = rs[i]; const [b, q] = rs[j]; const w = Math.min(p.right, q.right) - Math.max(p.left, q.left); const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top); if (w > 2 && h > 2) out.push(a + '/' + b); }
    return out.join(',') || 'none';
  };
  const waitIdle = async () => { await until(() => !vis('[data-flow-toolbar] [data-flow-undo]')[0]?.disabled || true, 200); await sleep(250); };
`;
const step = stepOf(H);
const main = (name, code) => [name, `main:${code}`, false];
const resize = (name, width) =>
  main(
    name,
    `const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows().find((x) => x.webContents.debugger.isAttached()) ?? BrowserWindow.getAllWindows()[0]; w.setContentSize(${width}, 900); await new Promise((r) => setTimeout(r, 1500)); return 'width ' + w.getContentSize()[0];`,
  );

const steps = [
  /* ------------------------------------------------------------------ real input works at all */
  step(
    'real-input-hits-the-element-under-the-pointer',
    `const files = [[${JSON.stringify(F_EMPTY)}, 'name: QA empty\\ntests: []\\n'], [${JSON.stringify(F_MAIN)}, ${JSON.stringify(MAIN)}], [${JSON.stringify(F_BLOCKS)}, 'name: QA blocks\\ntests: []\\n'], [${JSON.stringify(F_BIG)}, ${JSON.stringify(BIG)}], [${JSON.stringify(F_SUB)}, ${JSON.stringify(SUB)}]];
     for (const [path, content] of files) await window.aps.invoke('tests.write', { path, content });
     let seen = '';
     const nav = document.querySelector('nav [aria-label="Tests"]');
     const h = (e) => (seen += e.type + ':' + (e.target === nav || nav.contains(e.target)) + ',');
     for (const t of ['pointerdown', 'pointerup', 'click']) window.addEventListener(t, h, true);
     const r = await R.click(nav);
     for (const t of ['pointerdown', 'pointerup', 'click']) window.removeEventListener(t, h, true);
     return 'send: ' + r + ' | events: ' + seen;`,
  ),
  /* ------------------------------------------------------------------ the empty flow */
  step(
    'empty-flow-start-and-suggestions',
    `if (!(await openFile('qa-empty.yaml'))) return 'NO FLOW';
     const sugg = vis('[data-flow-designer] [data-flow-suggestion]').map((x) => x.dataset.flowSuggestion);
     return 'trigger: ' + vis('[data-flow-trigger]')[0]?.textContent.trim() + ' | suggestions: ' + sugg.join(',') + ' | start edges: ' + vis('[data-flow-start-edge]').length + ' | run disabled: ' + vis('[data-flow-run]')[0]?.disabled;`,
  ),
  step(
    'trigger-menu-lists-every-trigger',
    `await R.click('[data-flow-trigger]');
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 2500); if (!items) return 'NO MENU';
     const ok = await pickMenu('Manual');
     const t = await __t.waitFor(() => (/Run flow/.test(toasts()) ? toasts() : null), 3000);
     return 'items: ' + items.join(',') + ' | manual toast: ' + !!t + ' | menu closed: ' + !menuItems().length;`,
  ),
  step(
    'trigger-webhook-turns-it-on',
    `await R.click('[data-flow-trigger]');
     if (!(await pickMenu('Webhook'))) return 'NO ITEM';
     const t = await until(async () => /\\nwebhook:/.test(await fileText(${JSON.stringify(F_EMPTY)})), 5000);
     const label = await __t.waitFor(() => (/Webhook/i.test(vis('[data-flow-trigger]')[0]?.textContent ?? '') ? vis('[data-flow-trigger]')[0].textContent.trim() : null), 4000);
     return 'written: ' + !!t + ' | trigger: ' + label;`,
  ),
  step(
    'trigger-mcp-and-ci-open-their-dialogs',
    `await R.click('[data-flow-trigger]'); if (!(await pickMenu('MCP tool'))) return 'NO MCP ITEM';
     const d1 = await __t.waitFor(() => vis('[role=dialog]')[0], 3000);
     const mcp = d1 ? d1.textContent.slice(0, 40) : 'none';
     await R.key('Escape'); await sleep(400);
     await R.click('[data-flow-trigger]'); if (!(await pickMenu('CI'))) return 'NO CI ITEM';
     const d2 = await __t.waitFor(() => vis('[role=dialog]').find((d) => /CI/.test(d.textContent)), 3000);
     await R.key('Escape'); await sleep(400);
     return 'mcp dialog: ' + !!d1 + ' | ci dialog: ' + !!d2 + ' | closed: ' + !vis('[role=dialog]').length;`,
  ),
  step(
    'add-input-by-typing',
    `await R.click('[data-flow-add-input]');
     const row = await __t.waitFor(() => vis('[data-flow-inputs] [data-flow-input]').pop(), 2000); if (!row) return 'NO ROW';
     const [name, value] = row.querySelectorAll('input');
     await R.click(name); const focusedName = document.activeElement === name;
     await R.keys('who');
     await R.click(value); await R.keys('tester');
     await R.key('Enter');
     const saved = await until(async () => /who: tester/.test(await fileText(${JSON.stringify(F_EMPTY)})), 5000);
     // Backspace in the value is typing, not a canvas Delete
     await R.key('Backspace');
     const after = vis('[data-flow-inputs] [data-flow-input] input')[1]?.value;
     return 'name focused: ' + focusedName + ' | saved: ' + !!saved + ' | backspace edits the field: ' + (after === 'teste');`,
  ),
  step(
    'input-saved-when-focus-leaves',
    `const sp = emptySpot(0.5, 0.5); if (!sp) return 'NO SPOT';
     await R.click(sp);
     const saved = await until(async () => /who: teste\\b/.test(await fileText(${JSON.stringify(F_EMPTY)})), 5000);
     return 'saved on blur: ' + !!saved;`,
  ),
  step(
    'suggestion-add-blocks-opens-the-picker-esc-closes',
    `await R.click('[data-flow-suggestion="blocks"] button');
     const pal = await __t.waitFor(() => palette(), 2500); if (!pal) return 'NO PICKER';
     const focused = document.activeElement === pal.querySelector('input');
     await __t.waitFor(() => options().length, 1500);
     const groups = [...new Set(options().map((o) => o.closest('[role=listbox] > div')?.firstChild?.textContent?.trim()))].length;
     await R.key('Escape'); await sleep(300);
     return 'focused: ' + focused + ' | options: ' + options().length + ' | closed by Esc: ' + !palette();`,
  ),
  step(
    'suggestion-collection-opens-the-picker',
    `await R.click('[data-flow-suggestion="collection"] button');
     const p = await __t.waitFor(() => vis('[data-collection-picker]')[0], 3000);
     await R.key('Escape'); await sleep(400);
     return 'picker: ' + !!p + ' | closed: ' + !vis('[data-collection-picker]').length;`,
  ),
  step(
    'suggestion-ai-asks-and-cancels',
    `const before = await fileText(${JSON.stringify(F_EMPTY)});
     await R.click('[data-flow-suggestion="ai"] button');
     // the shared "Generate integration flow with AI" dialog (AI-1), the same as the explorer's
     const d = await __t.waitFor(() => vis('[role=dialog]').find((x) => x.querySelector('[data-flow-generate-dialog]') && /Generate integration flow with AI/.test(x.textContent)), 3000);
     await R.key('Escape'); await sleep(400);
     return 'dialog: ' + !!d + ' | closed: ' + !vis('[role=dialog]').length + ' | file unchanged: ' + (before === (await fileText(${JSON.stringify(F_EMPTY)})));`,
  ),
  step(
    // the API example's button is gone once the step is added (the flow is not empty): Ctrl+Z right after must still undo
    'suggestion-example-then-ctrl-z-undoes',
    `await R.click('[data-flow-suggestion="example"] button');
     if (!(await __t.waitFor(() => nodes().length === 1, 6000))) return 'NO NODE';
     await sleep(300);
     const focus = document.activeElement === document.body ? 'body' : document.activeElement?.tagName + (document.activeElement?.closest('[data-flow-designer]') ? ' in designer' : ' outside');
     await R.key('z', { ctrl: true });
     const undone = await __t.waitFor(() => nodes().length === 0, 2500);
     if (!undone) { const sp = emptySpot(0.6, 0.6); await R.click(sp); await R.key('z', { ctrl: true }); }
     const second = await __t.waitFor(() => nodes().length === 0, 3000);
     return 'focus after adding: ' + focus + ' | ctrl+z at once undoes: ' + !!undone + ' | after a canvas click: ' + !!second;`,
  ),
  step(
    'start-port-click-adds-a-block-after-start',
    `const p = vis('[data-flow-start-port]')[0]; if (!p) return 'NO PORT';
     await R.click(p);
     const e = await choose('Delay'); if (e) return e;
     const n = await __t.waitFor(() => nodes()[0], 6000); if (!n) return 'NO NODE';
     const s = (await flowOf(${JSON.stringify(F_EMPTY)})).steps.find((x) => x.type === 'delay') ?? { type: 'none' };
     return 'type: ' + s.type + ' | waits for: ' + (s.dependsOn ?? []).join(',') + ' | hangs off start: ' + vis('[data-flow-start-edge]').length + ' | selected: ' + selected();`,
  ),
  /* ------------------------------------------------------------------ every block type */
  step(
    'every-block-type-from-the-toolbar-picker',
    `if (!(await openFile('qa-blocks.yaml'))) return 'NO FLOW';
     const blocks = ${JSON.stringify(PALETTE_BLOCKS)};
     const bad = [];
     for (const [i, [label, type]] of blocks.entries()) {
       await R.click('[data-flow-add]');
       const e = await choose(label); if (e) { bad.push(e); await R.key('Escape'); continue; }
       const ok = await __t.waitFor(() => nodes().length === i + 1 - bad.length && selected() !== 'none' ? true : null, 6000);
       if (!ok) bad.push(label + ': not added');
       await sleep(200);
     }
     const f = await flowOf(${JSON.stringify(F_BLOCKS)});
     const types = f.steps.map((s) => s.type).join(',');
     const want = blocks.map((b) => b[1]).join(',');
     // each block waits for the one selected when it was added (the one added before it)
     const chain = f.steps.slice(1).filter((s, i) => !(s.dependsOn ?? []).includes(f.steps[i].id)).map((s) => s.id);
     return 'added: ' + f.steps.length + ' | types as picked: ' + (types === want ? 'yes' : types) + ' | not chained: ' + (chain.join(',') || 'none') + ' | problems: ' + (bad.join(';') || 'none');`,
  ),
  step(
    'parallel-group-block',
    `await R.click('[data-flow-add]');
     const e = await choose('Parallel group'); if (e) return e;
     const g = await __t.waitFor(() => vis('[data-flow-group][data-flow-group-kind="parallel"]')[0], 6000);
     const f = await flowOf(${JSON.stringify(F_BLOCKS)});
     const par = f.steps.filter((s) => s.parallel);
     return 'frame: ' + !!g + ' | steps in group: ' + par.length;`,
  ),
  step(
    'inspector-edits-of-every-block-type-save-to-yaml',
    `const f0 = await flowOf(${JSON.stringify(F_BLOCKS)});
     const out = [];
     const field = (label) => { const ins = inspector(); const l = [...ins.querySelectorAll('label')].find((x) => x.querySelector('span')?.textContent.trim() === label); return l?.querySelector('input, textarea, select'); };
     const setText = async (el, text, commit = 'Enter') => { await R.click(el); await R.key('a', { ctrl: true }); await R.type(text); await R.key(commit); await sleep(500); };
     const fit = () => R.click(vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit'));
     for (const s of f0.steps) {
       await fit(); await sleep(200);
       if (!(await selectStep(s.id))) { out.push(s.id + ':no node'); continue; }
       const ins = await __t.waitFor(() => vis('[data-step-inspector="' + s.id + '"]')[0], 3000); if (!ins) { out.push(s.id + ':no inspector'); continue; }
       const nameEl = ins.querySelector('input[aria-label="Step name"]');
       const newName = 'QA ' + s.type + ' ' + s.id.slice(0, 12);
       await setText(nameEl, newName);
       let fieldOk = 'n/a';
       const t = s.type;
       let target;
       if (t === 'http' && !s.parallel) target = [ins.querySelector('input[aria-label="URL"]'), '${API}/health?qa=' + s.id, 'Enter', 'qa=' + s.id];
       else if (t === 'delay') target = [ins.querySelector('[data-inspector-wait]'), '250', 'Enter', 'ms: 250'];
       else if (t === 'condition') target = [ins.querySelector('input[aria-label="Condition"]'), 'status == 201', 'Enter', 'status == 201'];
       else if (t === 'log') target = [ins.querySelector('input[aria-label="Message"]'), 'Hello QA', 'Enter', 'Hello QA'];
       else if (t === 'graphql') target = [field('Endpoint'), 'http://127.0.0.1:4010/graphql', 'Tab', '4010/graphql'];
       else if (t === 'grpc') target = [field('Target (host:port)'), '127.0.0.1:50051', 'Tab', '127.0.0.1:50051'];
       else if (t === 'websocket') target = [field('URL'), 'ws://127.0.0.1:4010/ws', 'Tab', 'ws://127.0.0.1:4010/ws'];
       else if (t === 'mcp') target = [field('Server'), 'qa-server', 'Tab', 'qa-server'];
       else if (t === 'llm') target = [field('Model (provider/name)'), 'mock/qa', 'Tab', 'mock/qa'];
       if (target) {
         if (!target[0]) fieldOk = 'NO FIELD';
         else { await setText(target[0], target[1], target[2]); const txt = await until(async () => { const x = await fileText(${JSON.stringify(F_BLOCKS)}); return x.includes(target[3]) ? x : null; }, 4000); fieldOk = txt ? 'saved' : 'NOT SAVED'; }
       }
       const named = await until(async () => (await flowOf(${JSON.stringify(F_BLOCKS)})).steps.some((x) => x.name === newName), 4000);
       const still = !!vis('[data-step-inspector]')[0];
       out.push(s.id + ':' + t + ' name=' + (named ? 'saved' : 'NOT SAVED') + ' field=' + fieldOk + (still ? '' : ' INSPECTOR GONE'));
     }
     const bad = out.filter((x) => /NOT|NO |GONE|no /.test(x));
     return 'steps: ' + f0.steps.length + ' | problems: ' + (bad.join('; ') || 'none');`,
  ),
  step(
    'sub-flow-file-picked-in-the-inspector',
    `const s = (await flowOf(${JSON.stringify(F_BLOCKS)})).steps.find((x) => x.type === 'flow'); if (!s) return 'NO SUB-FLOW STEP';
     await selectStep(s.id);
     const sel = await __t.waitFor(() => vis('[data-step-inspector] select[aria-label="Flow file"]')[0], 3000); if (!sel) return 'NO SELECT';
     const opts = [...sel.options].map((o) => o.value);
     sel.focus(); // a native <select>'s popup is outside the page: the keyboard picks
     const want = opts.find((v) => /qa-sub/.test(v)); if (!want) return 'NO qa-sub OPTION: ' + opts.join(',');
     for (let i = 0; i < opts.length && sel.value !== want; i++) { await R.key('ArrowDown'); await sleep(300); }
     const saved = await until(async () => /file: .*qa-sub\\.yaml/.test(await fileText(${JSON.stringify(F_BLOCKS)})), 4000);
     return 'saved: ' + !!saved;`,
  ),
  /* ------------------------------------------------------------------ the main flow: selection, drag, connect */
  step(
    'open-main-flow',
    `if (!(await openFile('qa-flow.yaml'))) return 'NO FLOW';
     if (!(await __t.waitFor(() => nodes().length === 6, 6000))) return 'NODES ' + nodes().length;
     const checks = vis('[data-flow-checks] [data-flow-check]').map((b) => b.dataset.flowCheck + ':' + b.dataset.flowCheckKind);
     return 'nodes: 6 | edges: ' + vis('[data-flow-edge]').length + ' | checks: ' + checks.join(',') + ' | when label: ' + vis('[data-flow-edge-when="check>happy"]')[0]?.textContent;`,
  ),
  step(
    'click-selects-a-step',
    `await selectStep('profile');
     const ins = await __t.waitFor(() => vis('[data-step-inspector="profile"]')[0], 3000);
     return 'selected: ' + selected() + ' | inspector: ' + !!ins + ' | canvas focused: ' + canvas().contains(document.activeElement);`,
  ),
  step(
    'shift-click-adds-and-removes',
    `await selectStep('orders', { shift: true });
     const two = selected();
     const multi = !!(await __t.waitFor(() => (/2 steps selected/.test(inspector()?.textContent ?? '') ? 1 : null), 2000));
     await selectStep('orders', { shift: true });
     return 'two: ' + two + ' | multi inspector: ' + multi + ' | after second shift-click: ' + selected();`,
  ),
  step(
    'click-on-empty-canvas-clears',
    `const sp = emptySpot(0.5, 0.6); if (!sp) return 'NO SPOT';
     await R.click(sp); await sleep(200);
     return 'selected: ' + selected();`,
  ),
  step(
    'escape-clears-the-selection',
    `await selectStep('profile'); await R.key('Escape'); await sleep(200);
     return 'selected after Esc: ' + selected();`,
  ),
  step(
    'ctrl-a-selects-every-step',
    `await selectStep('profile'); await R.key('a', { ctrl: true }); await sleep(300);
     const n = selected().split(',').length;
     const text = String(getSelection()).length;
     // with the page's text selected, a press on a step starts the browser's drag of that text (pointercancel)
     const p0 = (await stepOf(${JSON.stringify(F_MAIN)}, 'logout')).position;
     await R.drag(box('logout'), box('logout'), { from: { fx: 0.4, fy: 0.3 }, to: { fx: 0.4, fy: 0.3, dx: 90, dy: 60 }, steps: 12 });
     const moved = await until(async () => (await stepOf(${JSON.stringify(F_MAIN)}, 'logout')).position, 3000);
     if (moved && !p0) { await R.key('z', { ctrl: true }); await until(async () => !(await stepOf(${JSON.stringify(F_MAIN)}, 'logout')).position, 4000); }
     getSelection().removeAllRanges(); // (the next steps start clean)
     const sp = emptySpot(0.5, 0.6); await R.click(sp);
     return 'selected by Ctrl+A: ' + n + ' | page text selected: ' + text + ' | a step drags after it: ' + !!moved;`,
  ),
  step(
    'drag-on-empty-canvas',
    `const t0 = transform(); const sp = emptySpot(0.3, 0.5); if (!sp) return 'NO SPOT';
     await R.drag(sp, { x: sp.x + 120, y: sp.y + 60 }, { steps: 10 }); await sleep(400);
     const panned = transform() !== t0;
     // back where it was (Fit)
     const fit = vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit'); await R.click(fit); await sleep(300);
     return 'panned: ' + panned + ' | box-selected: ' + selected();`,
  ),
  step(
    'drag-a-step-moves-it',
    `const k = scale();
     const n0 = [...byId('logout').getAttribute('transform').matchAll(/[-\\d.]+/g)].map((m) => Number(m[0]));
     await R.drag(box('logout'), box('logout'), { from: { fx: 0.4, fy: 0.3 }, to: { fx: 0.4, fy: 0.3, dx: 100, dy: 70 }, steps: 12 });
     const f = await until(async () => { const s = await stepOf(${JSON.stringify(F_MAIN)}, 'logout'); return s?.position ? s : null; }, 6000); if (!f) return 'NOT MOVED: ' + toasts();
     const all = (await flowOf(${JSON.stringify(F_MAIN)})).steps.every((s) => s.position);
     const dx = Math.round(f.position[0] - n0[0]); const dy = Math.round(f.position[1] - n0[1]);
     // (a guide may line it up with another step: a few pixels of the screen either way)
     const near = Math.abs(dx - 100 / k) < 12 / k && Math.abs(dy - 70 / k) < 12 / k;
     return 'moved by the pointer: ' + near + ' (' + dx + ',' + dy + ' at zoom ' + k.toFixed(2) + ') | every step placed: ' + all + ' | selected after the drag: ' + selected();`,
  ),
  step(
    'drag-the-top-step-above-the-first-row',
    `const top = nodes().map((n) => [n.dataset.flowNode, box(n.dataset.flowNode).getBoundingClientRect()]).sort((a, b) => a[1].top - b[1].top)[0];
     const id = top[0]; const k = scale(); const y0 = (await stepOf(${JSON.stringify(F_MAIN)}, id)).position?.[1];
     const live = [];
     const a = R.pt(box(id), { fx: 0.4, fy: 0.3 });
     await R.down(a); for (let i = 1; i <= 8; i++) await R.move({ x: a.x, y: a.y - i * 10 }, { pressed: true });
     const shown = box(id).getBoundingClientRect().top;
     await R.up({ x: a.x, y: a.y - 80 });
     await sleep(1500);
     const landed = box(id).getBoundingClientRect().top;
     await R.key('z', { ctrl: true }); await sleep(800);
     return 'step: ' + id + ' | drawn while dragging at ' + Math.round(shown) + ', after the drop at ' + Math.round(landed) + ' | jumps back: ' + (Math.abs(landed - shown) > 8);`,
  ),
  step(
    'ctrl-z-and-ctrl-y-undo-and-redo-the-move',
    `await R.key('z', { ctrl: true });
     const undone = await until(async () => !(await stepOf(${JSON.stringify(F_MAIN)}, 'logout'))?.position, 5000);
     await R.key('y', { ctrl: true });
     const redone = await until(async () => !!(await stepOf(${JSON.stringify(F_MAIN)}, 'logout'))?.position, 5000);
     await R.key('z', { ctrl: true }); await R.key('y', { ctrl: true });
     await R.key('z', { ctrl: true, shift: true });
     return 'undo: ' + !!undone + ' | redo: ' + !!redone + ' | focus: ' + (canvas().contains(document.activeElement) ? 'canvas' : document.activeElement?.tagName);`,
  ),
  step(
    'snap-and-alignment-guides',
    `const how = await act('Snap'); const on = vis('[data-flow-snap-toggle]')[0]?.getAttribute('aria-pressed');
     // orders sits under profile (one column): moved straight down it lines up with it and a guide shows
     const b = box('orders'); const a = R.pt(b, { fx: 0.4, fy: 0.3 });
     await R.down(a); for (let i = 1; i <= 8; i++) await R.move({ x: a.x + (i % 2), y: a.y + i * 6 }, { pressed: true });
     const guides = vis('[data-flow-guide]').length;
     await R.up({ x: a.x, y: a.y + 48 });
     const s = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'orders'); const p = await stepOf(${JSON.stringify(F_MAIN)}, 'profile'); return x && p ? [x.position, p.position] : null; }, 5000);
     const lined = s && s[0][0] === s[1][0];
     // a drag lined up with nothing lands on the 16 px grid
     const c = box('happy'); const q = R.pt(c, { fx: 0.4, fy: 0.3 });
     await R.drag(q, { x: q.x + 37, y: q.y + 151 }, { steps: 8 });
     const h = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'happy'); return x?.position && (x.position[0] % 16 === 0 && x.position[1] % 16 === 0) ? x.position : null; }, 5000);
     await act('Snap');
     return 'toggle: ' + how + ' pressed=' + on + ' | guide while dragging: ' + (guides > 0) + ' | lined up: ' + lined + ' | on the grid: ' + !!h;`,
  ),
  step(
    'connect-by-dragging-a-port-onto-a-step',
    `await R.drag(port('orders'), box('logout'), { to: { fx: 0.5, fy: 0.5 }, steps: 14 });
     const s = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'logout'); return (x.dependsOn ?? []).includes('orders') ? x : null; }, 5000);
     return 'logout waits for: ' + (s ? s.dependsOn.join(',') : (await stepOf(${JSON.stringify(F_MAIN)}, 'logout')).dependsOn?.join(',')) + ' | edge drawn: ' + !!(await __t.waitFor(() => vis('[data-flow-edge="orders>logout"]')[0], 3000)) + ' | picker opened: ' + !!palette();`,
  ),
  step(
    'connect-refuses-a-cycle',
    `const before = await fileText(${JSON.stringify(F_MAIN)});
     await R.drag(port('logout'), box('login'), { to: { fx: 0.5, fy: 0.5 }, steps: 14 });
     const t = await __t.waitFor(() => (/cycle/i.test(toasts()) ? toasts() : null), 4000);
     return 'refused: ' + /cycle/i.test(t ?? '') + ' | file unchanged: ' + (before === (await fileText(${JSON.stringify(F_MAIN)})));`,
  ),
  step(
    'start-port-dragged-onto-a-step-makes-it-wait-for-nothing',
    `await R.drag(vis('[data-flow-start-port]')[0], box('profile'), { steps: 14 });
     const s = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'profile'); return !(x.dependsOn ?? []).length ? x : null; }, 5000);
     const hangs = vis('[data-flow-start-edge="profile"]').length;
     await R.key('z', { ctrl: true });
     const back = await until(async () => ((await stepOf(${JSON.stringify(F_MAIN)}, 'profile')).dependsOn ?? []).includes('login'), 5000);
     return 'waits for nothing: ' + !!s + ' | hangs off start: ' + hangs + ' | undone: ' + !!back;`,
  ),
  step(
    'click-an-edge-then-delete-removes-it',
    `const p = edgePoint('orders>logout'); if (!p) return 'NO EDGE POINT';
     await R.click(p); await sleep(300);
     const said = /waits for/.test(inspector()?.textContent ?? '');
     const thick = vis('[data-flow-edge="orders>logout"]')[0]?.getAttribute('stroke-width');
     await R.key('Delete');
     const s = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'logout'); return !(x.dependsOn ?? []).includes('orders') ? x : null; }, 5000);
     return 'inspector says: ' + said + ' | drawn selected: ' + (thick === '2.5') + ' | removed: ' + !!s;`,
  ),
  step(
    'right-click-an-edge-offers-a-menu',
    `const p = edgePoint('login>orders'); if (!p) return 'NO EDGE POINT';
     await R.rightClick(p);
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 1500);
     await R.key('Escape'); await sleep(200);
     return 'menu: ' + (items ? items.join(',') : 'none');`,
  ),
  step(
    'condition-false-port-click-adds-on-the-false-branch',
    `await R.click(port('check', false));
     const e = await choose('Log'); if (e) return e;
     const s = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).steps.find((x) => x.type === 'log'), 6000); if (!s) return 'NOT ADDED';
     return 'waits for: ' + (s.dependsOn ?? []).join(',') + ' | when: ' + s.when + ' | selected: ' + selected();`,
  ),
  step(
    'condition-true-port-drag-onto-a-step',
    `// a new request, then the condition's true dot dragged onto it
     await R.click(port('check', true)); const e = await choose('HTTP request'); if (e) return e;
     const s = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).steps.find((x) => x.type === 'http' && x.when === true && x.id !== 'happy'), 6000);
     return 'added on true: ' + !!s + ' | label: ' + (s ? vis('[data-flow-edge-when="check>' + s.id + '"]')[0]?.textContent : 'n/a');`,
  ),
  step(
    'port-plus-shows-on-hover-and-opens-the-picker',
    `const g = byId('orders'); const plus = g.querySelector('[data-flow-port-add]');
     await R.move(box('orders')); await sleep(400);
     const shown = getComputedStyle(plus).opacity;
     await R.click(plus.querySelector('circle'));
     const pal = await __t.waitFor(() => palette(), 2500);
     const sel = selected();
     await R.key('Escape'); await sleep(300);
     return 'plus opacity on hover: ' + shown + ' | picker: ' + !!pal + ' | closed: ' + !palette() + ' | selection changed to: ' + sel;`,
  ),
  step(
    'connection-dropped-on-empty-canvas-opens-the-picker-arrows-enter',
    `const sp = emptySpot(0.75, 0.15); if (!sp) return 'NO SPOT';
     await R.drag(port('logout'), sp, { steps: 14 });
     const pal = await __t.waitFor(() => palette(), 2500); if (!pal) return 'NO PICKER';
     const r = pal.getBoundingClientRect(); const near = Math.abs(r.left - sp.x) < 400 && Math.abs(r.top - sp.y) < 400;
     await R.type('del'); await sleep(200);
     const first = activeOption();
     await R.key('ArrowDown'); const second = activeOption(); await R.key('ArrowUp'); const back = activeOption();
     await R.key('Enter');
     const s = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).steps.find((x) => x.type === 'delay'), 6000);
     return 'at the drop: ' + near + ' | first: ' + first + ' | arrows: ' + (second !== first && back === first) + ' | added: ' + (s ? s.type + ' after ' + (s.dependsOn ?? []).join(',') : 'none');`,
  ),
  step(
    'toolbar-block-adds-after-the-selected-step',
    `await selectStep('login');
     await R.click('[data-flow-add]');
     const e = await choose('Assert'); if (e) return e;
     const s = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).steps.find((x) => x.type === 'assert'), 6000); if (!s) return 'NOT ADDED';
     await sleep(600);
     return 'waits for: ' + (s.dependsOn ?? []).join(',') + ' | selected: ' + selected() + ' | overlapping: ' + overlaps();`,
  ),
  step(
    'picker-search-ranks-the-exact-match-first',
    `await R.click('[data-flow-add]'); if (!(await __t.waitFor(() => palette(), 2000))) return 'NO PICKER';
     const first = () => options()[0]?.querySelector('[data-command-label]')?.textContent.trim();
     await R.type('Log'); await sleep(250); const log = first();
     await R.key('a', { ctrl: true }); await R.type('del'); await sleep(250); const del = first();
     await R.key('a', { ctrl: true }); await R.type('set'); await sleep(250); const set = first();
     await R.key('Escape'); await sleep(250);
     return 'Log: ' + log + ' | del: ' + del + ' | set: ' + set;`,
  ),
  step(
    'picker-adds-a-saved-request',
    `const sp = emptySpot(0.5, 0.7); await R.click(sp);
     await R.click('[data-flow-add]'); const pal = await __t.waitFor(() => palette(), 2500); if (!pal) return 'NO PICKER';
     await R.type('carts'); await sleep(300);
     const o = options().find((x) => x.querySelector('[data-command-label]')?.textContent.trim().startsWith('A user')); if (!o) return 'NO SAVED REQUEST: ' + options().map((x) => x.textContent.trim()).slice(0, 4).join(' / ');
     const n0 = nodes().length; await R.click(o);
     const ok = await __t.waitFor(() => nodes().length === n0 + 1, 6000);
     return 'added: ' + !!ok + ' | selected: ' + selected();`,
  ),
  step(
    'delete-key-removes-the-selected-step',
    `const id = selected(); if (id === 'none' || id.includes(',')) return 'SELECTION ' + id;
     const n0 = nodes().length;
     await R.key('Delete');
     const gone = await __t.waitFor(() => nodes().length === n0 - 1 && !byId(id), 5000);
     return 'removed: ' + !!gone;`,
  ),
  step(
    'delete-removes-several-selected-steps-and-undo-brings-them-back',
    `const n0 = nodes().length; const ids = ['happy', 'logout'];
     await selectStep(ids[0]); await selectStep(ids[1], { shift: true });
     await R.key('Delete');
     const gone = await __t.waitFor(() => nodes().length === n0 - 2, 5000);
     const focus = document.activeElement === document.body ? 'body' : canvas().contains(document.activeElement) ? 'canvas' : document.activeElement?.tagName;
     await R.key('z', { ctrl: true });
     const back = await __t.waitFor(() => nodes().length === n0 && ids.every((i) => byId(i)), 4000);
     // (put them back for the next steps: a click on the canvas gives it the keys again)
     if (!back) { await R.click(emptySpot(0.5, 0.85)); await R.key('z', { ctrl: true }); await __t.waitFor(() => nodes().length === n0, 5000); }
     return 'deleted both: ' + !!gone + ' | focus after the delete: ' + focus + ' | Ctrl+Z at once undoes: ' + !!back;`,
  ),
  step(
    'ctrl-d-duplicates-and-ctrl-z-undoes',
    `await selectStep('profile'); const n0 = nodes().length;
     await R.key('d', { ctrl: true });
     const dup = await __t.waitFor(() => nodes().length === n0 + 1, 5000);
     const sel = selected();
     await R.key('z', { ctrl: true });
     const back = await __t.waitFor(() => nodes().length === n0, 5000);
     return 'duplicated: ' + !!dup + ' | copy selected: ' + (sel !== 'profile' && sel !== 'none') + ' | undone: ' + !!back;`,
  ),
  step(
    'ctrl-c-ctrl-v-pastes-a-copy',
    `await selectStep('orders'); const n0 = nodes().length;
     await R.key('c', { ctrl: true });
     const told = await __t.waitFor(() => (/copied/.test(toasts()) ? 1 : null), 3000);
     await R.key('v', { ctrl: true });
     const pasted = await __t.waitFor(() => nodes().length === n0 + 1, 5000);
     await R.key('z', { ctrl: true });
     const back = await __t.waitFor(() => nodes().length === n0, 5000);
     return 'toast: ' + !!told + ' | pasted: ' + !!pasted + ' | undone: ' + !!back;`,
  ),
  step(
    'double-click-a-step-opens-it-in-the-editor',
    `await R.dblclick(box('orders'), { fx: 0.4, fy: 0.3 });
     const ed = await __t.waitFor(() => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent), 4000);
     const line = ed ? ed.getModel().getLineContent(ed.getPosition().lineNumber) : '';
     const t = tabEl('Flow'); if (t) await R.click(t);
     await __t.waitFor(() => nodes().length > 0, 6000);
     return 'editor: ' + !!ed + ' | at the step: ' + /List the orders/.test(line);`,
  ),
  step(
    'rename-in-the-inspector',
    `await selectStep('profile');
     const name = await __t.waitFor(() => vis('[data-step-inspector="profile"] input[aria-label="Step name"]')[0], 3000); if (!name) return 'NO NAME FIELD';
     await R.click(name); await R.key('a', { ctrl: true }); await R.type('Read the user profile'); await R.key('Enter');
     const s = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'profile'); return x?.name === 'Read the user profile' ? x : null; }, 5000);
     const label = await __t.waitFor(() => (/Read the user/.test(byId('profile')?.textContent ?? '') ? 1 : null), 3000);
     return 'saved: ' + !!s + ' | node shows it: ' + !!label + ' | still selected: ' + selected();`,
  ),
  step(
    'typing-in-the-inspector-never-triggers-canvas-shortcuts',
    `await selectStep('profile');
     const name = await __t.waitFor(() => vis('[data-step-inspector="profile"] input[aria-label="Step name"]')[0], 3000); if (!name) return 'NO NAME FIELD';
     const before = await fileText(${JSON.stringify(F_MAIN)}); const n0 = nodes().length;
     await R.click(name); await R.key('End');
     await R.keys('xy'); await R.key('Backspace'); await R.key('Backspace'); await R.key('Delete');
     await R.key('d', { ctrl: true }); await R.key('c', { ctrl: true }); await R.key('a', { ctrl: true });
     await sleep(800);
     const url = vis('[data-step-inspector="profile"] input[aria-label="URL"]')[0];
     if (url) { await R.click(url); await R.key('z', { ctrl: true }); await R.key('End'); await R.keys('x'); await R.key('Backspace'); await R.key('Delete'); }
     await R.click(name); await sleep(600);
     return 'steps: ' + (nodes().length === n0 ? 'same' : nodes().length) + ' | still selected: ' + selected() + ' | file: ' + ((await fileText(${JSON.stringify(F_MAIN)})) === before ? 'unchanged' : 'CHANGED');`,
  ),
  /* ------------------------------------------------------------------ sticky notes */
  step(
    'text-button-adds-a-note',
    `const sp = emptySpot(0.5, 0.6); await R.click(sp);
     await R.click('[data-flow-add-note]');
     const n = await __t.waitFor(() => notesEl()[0], 5000); if (!n) return 'NO NOTE';
     const t = await fileText(${JSON.stringify(F_MAIN)});
     return 'notes: ' + notesEl().length + ' | saved: ' + /notes:/.test(t) + ' | hint: ' + /Double-click to write/.test(n.textContent);`,
  ),
  step(
    'note-double-click-edits-type-ctrl-enter-saves',
    `const n = notesEl()[0];
     await R.dblclick(paper(n), { fy: 0.5 });
     const ta = await __t.waitFor(() => n.querySelector('textarea') ?? notesEl()[0]?.querySelector('textarea'), 2500); if (!ta) return 'NO EDITOR: double-click did not edit (target ' + document.elementFromPoint(R.pt(paper(n)).x, R.pt(paper(n)).y)?.tagName + ')';
     const focused = document.activeElement === ta;
     await R.type('**Bold** note'); await R.key('Enter', { ctrl: true });
     const saved = await until(async () => (await fileText(${JSON.stringify(F_MAIN)})).includes('**Bold** note'), 5000);
     const shown = await __t.waitFor(() => vis('[data-flow-note] strong')[0]?.textContent, 3000);
     return 'editing: true | focused: ' + focused + ' | saved: ' + !!saved + ' | markdown: ' + shown + ' | editor closed: ' + !vis('[data-flow-note] textarea').length;`,
  ),
  step(
    'note-escape-cancels-the-edit',
    `const n = notesEl()[0];
     await R.dblclick(paper(n), { fy: 0.5 });
     const ta = await __t.waitFor(() => vis('[data-flow-note] textarea')[0], 2500); if (!ta) return 'NO EDITOR';
     await R.key('a', { ctrl: true }); await R.type('discard me'); await R.key('Escape');
     await sleep(1200);
     const t = await fileText(${JSON.stringify(F_MAIN)});
     return 'closed: ' + !vis('[data-flow-note] textarea').length + ' | discarded: ' + (!t.includes('discard me') && t.includes('**Bold** note')) + ' | shown: ' + vis('[data-flow-note]')[0]?.textContent.trim().slice(0, 30);`,
  ),
  step(
    'note-blur-saves',
    `const n = notesEl()[0];
     await R.dblclick(paper(n), { fy: 0.5 });
     const ta = await __t.waitFor(() => vis('[data-flow-note] textarea')[0], 2500); if (!ta) return 'NO EDITOR';
     await R.key('a', { ctrl: true }); await R.type('Saved on *blur*');
     const sp = emptySpot(0.5, 0.8); await R.click(sp);
     const saved = await until(async () => (await fileText(${JSON.stringify(F_MAIN)})).includes('Saved on *blur*'), 5000);
     return 'saved: ' + !!saved + ' | closed: ' + !vis('[data-flow-note] textarea').length + ' | italic: ' + !!vis('[data-flow-note] em')[0];`,
  ),
  step(
    'typing-in-a-note-never-triggers-canvas-shortcuts',
    `await selectStep('orders');
     const n = notesEl()[0]; const before = await fileText(${JSON.stringify(F_MAIN)}); const n0 = nodes().length;
     await R.dblclick(paper(n), { fy: 0.5 });
     const ta = await __t.waitFor(() => vis('[data-flow-note] textarea')[0], 2500); if (!ta) return 'NO EDITOR';
     await R.key('End', { ctrl: true }); await R.keys(' x'); await R.key('Backspace'); await R.key('Backspace'); await R.key('Delete');
     await R.key('d', { ctrl: true }); await R.key('z', { ctrl: true }); await R.key('f', { ctrl: true }); await R.key('k', { ctrl: true }); await R.key('F9');
     await sleep(600);
     const stillEditing = !!vis('[data-flow-note] textarea')[0];
     const find = !!vis('[data-flow-find]')[0]; const pal = !!vis('[role=dialog][aria-label="Command palette"]')[0];
     await R.key('Escape'); await sleep(800);
     return 'steps: ' + (nodes().length === n0 ? 'same' : nodes().length) + ' | still editing: ' + stillEditing + ' | find opened: ' + find + ' | palette opened: ' + pal + ' | breakpoint set: ' + !!byId('orders')?.dataset.breakpoint + ' | file: ' + ((await fileText(${JSON.stringify(F_MAIN)})) === before ? 'unchanged' : 'CHANGED');`,
  ),
  step(
    'note-drag-moves-it',
    `const k = scale(); const n0 = (await flowOf(${JSON.stringify(F_MAIN)})).notes[0];
     const p = paper(notesEl()[0]);
     await R.drag(p, p, { from: { fy: 0.4 }, to: { fy: 0.4, dx: 90, dy: 50 }, steps: 10 });
     const n1 = await until(async () => { const x = (await flowOf(${JSON.stringify(F_MAIN)})).notes[0]; return x.x !== n0.x ? x : null; }, 5000); if (!n1) return 'NOT MOVED';
     return 'moved with the pointer: ' + (Math.abs(n1.x - n0.x - 90 / k) < 10 && Math.abs(n1.y - n0.y - 50 / k) < 10) + ' | not editing: ' + !vis('[data-flow-note] textarea').length;`,
  ),
  step(
    'note-corner-resizes-it',
    `const k = scale(); const n0 = (await flowOf(${JSON.stringify(F_MAIN)})).notes[0];
     const c = vis('[data-flow-note] rect[data-flow-note-resize]')[0]; if (!c) return 'NO HANDLE';
     await R.drag(c, c, { to: { dx: 60, dy: 40 }, steps: 8 });
     const n1 = await until(async () => { const x = (await flowOf(${JSON.stringify(F_MAIN)})).notes[0]; return x.w !== n0.w ? x : null; }, 5000); if (!n1) return 'NOT RESIZED';
     return 'resized with the pointer: ' + (Math.abs(n1.w - n0.w - 60 / k) < 10 && Math.abs(n1.h - n0.h - 40 / k) < 10) + ' | moved: ' + (n1.x !== n0.x || n1.y !== n0.y);`,
  ),
  step(
    'note-right-click-colour',
    `await R.rightClick(paper(notesEl()[0]), { fy: 0.5 });
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 2000); if (!items) return 'NO MENU';
     const col = menuItem('Colour'); await R.click(col); await sleep(400);
     const ok = await pickMenu('Blue');
     const saved = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).notes[0].color === 'blue', 5000);
     return 'menu: ' + items.join(',') + ' | blue: ' + !!saved;`,
  ),
  step(
    'canvas-double-click-menu-adds-a-note-there',
    `const sp = emptySpot(0.2, 0.75); if (!sp) return 'NO SPOT';
     await R.dblclick(sp);
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 2000); if (!items) return 'NO MENU';
     const n0 = notesEl().length;
     await pickMenu('Add note here');
     const n = await __t.waitFor(() => notesEl().length === n0 + 1 ? notesEl().at(-1) : null, 5000); if (!n) return 'NO NOTE';
     const r = paper(n).getBoundingClientRect();
     return 'menu: ' + items.join(',') + ' | note near the click: ' + (Math.abs(r.left - sp.x) < 60 && Math.abs(r.top - sp.y) < 60);`,
  ),
  step(
    'canvas-double-click-add-step-here',
    `const sp = emptySpot(0.6, 0.85); if (!sp) return 'NO SPOT';
     await R.dblclick(sp);
     if (!(await __t.waitFor(() => menuItem('Add step here'), 2000))) return 'NO MENU';
     await R.click(menuItem('Add step here')); await sleep(400);
     const n0 = nodes().length;
     if (!(await pickMenu('Log'))) return 'NO SUBMENU: ' + menuItems().join(',');
     const n = await __t.waitFor(() => nodes().length === n0 + 1, 5000);
     const id = selected(); const b = box(id)?.getBoundingClientRect();
     return 'added: ' + !!n + ' | near the click: ' + (b ? Math.abs(b.left - sp.x) < 80 && Math.abs(b.top - sp.y) < 80 : 'n/a');`,
  ),
  step(
    'a-selected-note-is-deleted-with-the-delete-key',
    `const n0 = notesEl().length; const n = notesEl().at(-1);
     await R.click(paper(n), { fy: 0.5 }); await R.key('Delete'); await sleep(800);
     return 'notes: ' + n0 + ' -> ' + notesEl().length;`,
  ),
  step(
    'note-right-click-delete-and-undo',
    `const n0 = notesEl().length;
     await R.rightClick(paper(notesEl().at(-1)), { fy: 0.5 });
     if (!(await pickMenu('Delete note'))) return 'NO ITEM';
     const gone = await __t.waitFor(() => notesEl().length === n0 - 1, 5000);
     await R.click(emptySpot(0.5, 0.5)); await R.key('z', { ctrl: true });
     const back = await __t.waitFor(() => notesEl().length === n0, 5000);
     return 'deleted: ' + !!gone + ' | undone: ' + !!back;`,
  ),
  /* ------------------------------------------------------------------ frames, lanes */
  step(
    'frame-selection',
    `await selectStep('profile'); await selectStep('orders', { shift: true });
     const b = await __t.waitFor(() => vis('[data-flow-frame-selection]')[0], 3000); if (!b) return 'NO BUTTON';
     await R.click(b);
     const input = await __t.waitFor(() => vis('[role=dialog] input')[0], 3000); if (!input) return 'NO DIALOG';
     await R.type('Reads'); await R.key('Enter');
     const f = await __t.waitFor(() => vis('[data-flow-designer] [data-flow-frame]')[0], 5000); if (!f) return 'NO FRAME';
     return 'title: ' + f.querySelector('[data-flow-frame-title]').textContent + ' | saved: ' + /frames:/.test(await fileText(${JSON.stringify(F_MAIN)}));`,
  ),
  step(
    'frame-rename-and-recolour',
    `const h = () => vis('[data-flow-frame-handle]')[0];
     await R.rightClick(h(), { fx: 0.15 });
     if (!(await pickMenu('Rename frame'))) return 'NO RENAME: ' + menuItems().join(',');
     const input = await __t.waitFor(() => vis('[role=dialog] input')[0], 3000); if (!input) return 'NO DIALOG';
     await R.key('a', { ctrl: true }); await R.type('Reading'); await R.key('Enter');
     const renamed = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).frames?.[0]?.title === 'Reading', 5000);
     await R.rightClick(h(), { fx: 0.15 }); await R.click(await __t.waitFor(() => menuItem('Colour'), 2000)); await sleep(300);
     await pickMenu('Green');
     const green = await until(async () => (await flowOf(${JSON.stringify(F_MAIN)})).frames?.[0]?.color === 'green', 5000);
     return 'renamed: ' + !!renamed + ' | green: ' + !!green;`,
  ),
  step(
    'frame-title-drag-moves-its-steps',
    `const k = scale(); const f0 = await flowOf(${JSON.stringify(F_MAIN)}); const p0 = f0.steps.find((s) => s.id === 'profile').position;
     const h = vis('[data-flow-frame-handle]')[0];
     await R.drag(h, h, { from: { fx: 0.1 }, to: { fx: 0.1, dx: 0, dy: 60 }, steps: 10 });
     const s = await until(async () => { const x = await stepOf(${JSON.stringify(F_MAIN)}, 'profile'); return x.position && x.position[1] !== p0?.[1] ? x : null; }, 5000);
     return 'moved: ' + !!s + (s ? ' by ' + Math.round(s.position[1] - (p0?.[1] ?? 0)) + ' (want ' + Math.round(60 / k) + ')' : '');`,
  ),
  step(
    'frame-select-its-steps',
    `await R.rightClick(vis('[data-flow-frame-handle]')[0], { fx: 0.15 });
     if (!(await pickMenu('Select its steps'))) return 'NO ITEM';
     return 'selected: ' + selected();`,
  ),
  step(
    'right-click-a-step-offers-its-menu',
    `await R.rightClick(box('login'), { fx: 0.4, fy: 0.3 });
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 2000);
     await R.key('Escape'); await sleep(300);
     return 'menu: ' + (items ?? []).join(',') + ' | selected: ' + selected();`,
  ),
  step(
    'right-click-the-empty-canvas-offers-a-menu',
    `await R.rightClick(emptySpot(0.5, 0.5));
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 1500);
     await R.key('Escape'); await sleep(200);
     return 'menu: ' + (items ? items.join(',') : 'none');`,
  ),
  step(
    'align-left-and-distribute',
    `await selectStep('login'); await selectStep('happy', { shift: true });
     await R.click(await __t.waitFor(() => vis('[data-flow-align="left"]')[0], 3000));
     const a = await until(async () => { const f = await flowOf(${JSON.stringify(F_MAIN)}); const x = f.steps.find((s) => s.id === 'login').position; const y = f.steps.find((s) => s.id === 'happy').position; return x && y && x[0] === y[0] ? [x, y] : null; }, 5000);
     await selectStep('login'); await selectStep('orders', { shift: true }); await selectStep('logout', { shift: true });
     await R.click(await __t.waitFor(() => vis('[data-flow-align="distribute"]')[0], 3000));
     const d = await until(async () => { const f = await flowOf(${JSON.stringify(F_MAIN)}); const p = ['login', 'orders', 'logout'].map((id) => f.steps.find((s) => s.id === id).position); const xs = p.map((q) => q[0]).sort((m, n) => m - n); const ys = p.map((q) => q[1]).sort((m, n) => m - n); const even = (v) => Math.abs(v[1] - v[0] - (v[2] - v[1])) <= 1; return even(xs) || even(ys) ? 1 : null; }, 5000);
     return 'left: ' + !!a + ' | distributed: ' + !!d;`,
  ),
  step(
    'auto-arrange-keeps-notes-and-frames',
    `const r = await act('Auto-arrange');
     const t = await until(async () => { const x = await flowOf(${JSON.stringify(F_MAIN)}); return x.steps.every((s) => !s.position) ? x : null; }, 6000);
     await sleep(800);
     return 'via: ' + r + ' | positions gone: ' + !!t + ' | notes kept: ' + (t?.notes?.length ?? 0) + ' | frames kept: ' + (t?.frames?.length ?? 0) + ' | overlapping: ' + overlaps() + ' | frame title under: ' + (() => { const h = vis('[data-flow-frame-handle]')[0]; if (!h) return 'none'; const p = R.pt(h, { fx: 0.1 }); const u = document.elementFromPoint(p.x, p.y); return u?.closest('[data-flow-frame-handle]') ? 'title' : u?.closest('[data-flow-node]')?.dataset.flowNode ?? u?.tagName; })();`,
  ),
  step(
    'frame-remove-keeps-the-steps',
    `const n0 = nodes().length;
     await R.rightClick(vis('[data-flow-frame-handle]')[0], { fx: 0.15 });
     if (!(await pickMenu('Remove frame'))) return 'NO ITEM';
     const gone = await until(async () => !((await flowOf(${JSON.stringify(F_MAIN)})).frames ?? []).length, 5000);
     return 'removed: ' + !!gone + ' | steps kept: ' + (nodes().length === n0);`,
  ),
  step(
    'parallel-and-finally-lanes',
    `await selectStep('profile'); await selectStep('orders', { shift: true });
     await R.click(await __t.waitFor(() => vis('[data-flow-make-parallel]')[0], 3000));
     const g = await __t.waitFor(() => vis('[data-flow-group][data-flow-group-kind="parallel"]')[0], 5000);
     // (two steps nothing waits for: a step another one waits for cannot run last)
     await selectStep('happy'); await selectStep('assert', { shift: true });
     const mk = vis('[data-flow-group-actions] button').find((b) => b.textContent.trim() === 'Make finally'); if (mk) await R.click(mk);
     const lane = await __t.waitFor(() => vis('[data-flow-group][data-flow-group-kind="finally"]')[0], 5000);
     const f = await flowOf(${JSON.stringify(F_MAIN)});
     await sleep(800);
     return 'parallel frame: ' + !!g + ' | group: ' + f.steps.filter((s) => s.parallel).map((s) => s.id).join(',') + ' | finally lane: ' + !!lane + ' | finally: ' + f.steps.filter((s) => s.finally).map((s) => s.id).join(',') + ' | overlapping: ' + overlaps();`,
  ),
  step(
    'drop-a-step-into-the-parallel-frame',
    `const g = vis('[data-flow-group][data-flow-group-kind="parallel"] rect')[0]; if (!g) return 'NO FRAME';
     const gr = g.getBoundingClientRect(); const b = box('logout').getBoundingClientRect();
     await R.drag(box('logout'), { x: gr.left + gr.width / 2 - b.width * 0.1, y: gr.bottom - b.height * 0.2 }, { from: { fx: 0.4, fy: 0.3 }, steps: 16 });
     const s = await until(async () => (await stepOf(${JSON.stringify(F_MAIN)}, 'logout')).parallel, 5000);
     await sleep(800); return 'joined: ' + (s ?? 'no') + ' | overlapping: ' + overlaps();`,
  ),
  /* ------------------------------------------------------------------ view: zoom, pan, fit, find, Ctrl+K */
  step(
    'wheel-zooms-around-the-pointer',
    `const k0 = scale(); const c = R.pt(svg());
     await R.wheel(c, -400); await sleep(400); const k1 = scale();
     await R.wheel(c, 400); await sleep(400); const k2 = scale();
     await R.wheel(c, -200, { ctrl: true }); await sleep(400); const k3 = scale();
     return 'in: ' + (k1 > k0) + ' | out: ' + (k2 < k1) + ' | ctrl+wheel zooms: ' + (k3 > k2) + ' | zoom buttons: ' + vis('[data-flow-toolbar] button').filter((b) => /zoom/i.test(b.getAttribute('aria-label') ?? b.title ?? '')).length;`,
  ),
  step(
    'fit-shows-everything',
    `await R.wheel(R.pt(svg()), -1200); await sleep(400);
     await R.click(vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit')); await sleep(400);
     const r = svg().getBoundingClientRect();
     const out = nodes().filter((n) => { const b = n.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1; }).map((n) => n.dataset.flowNode);
     return 'outside the view: ' + (out.join(',') || 'none');`,
  ),
  step(
    'ctrl-f-finds-enter-shift-enter-esc',
    `await R.click(emptySpot(0.5, 0.5)); await R.key('f', { ctrl: true });
     const input = await __t.waitFor(() => vis('[data-flow-find] input')[0], 2000); if (!input) return 'NO FIND BOX';
     const focused = document.activeElement === input;
     await R.type('health'); await sleep(200);
     const count0 = vis('[data-flow-find-count]')[0]?.textContent;
     await R.key('Enter'); const a = selected();
     await R.key('Enter'); const b = selected();
     await R.key('Enter', { shift: true }); const c = selected();
     const count = vis('[data-flow-find-count]')[0]?.textContent;
     await R.key('Escape'); await sleep(200);
     return 'focused: ' + focused + ' | before Enter: ' + count0 + ' | next: ' + (a !== b) + ' | previous: ' + (c === a) + ' | count: ' + count + ' | closed: ' + !vis('[data-flow-find]')[0] + ' | focus back on canvas: ' + (document.activeElement === canvas());`,
  ),
  step(
    'ctrl-k-lists-canvas-commands-first',
    `await R.click(emptySpot(0.5, 0.5)); await R.key('k', { ctrl: true });
     const pal = await __t.waitFor(() => vis('[role=dialog][aria-label="Command palette"]')[0], 2000); if (!pal) return 'NO PALETTE';
     const first = [...pal.querySelectorAll('[role=option]')].slice(0, 2).map((o) => o.textContent.trim()).join(' / ');
     await R.type('Snap'); await sleep(200); const snap = !!pal.querySelector('[data-command="flow-snap"]');
     await R.key('Escape'); await sleep(300);
     return 'first: ' + first + ' | snap command: ' + snap + ' | closed: ' + !vis('[role=dialog][aria-label="Command palette"]')[0];`,
  ),
  step(
    'problems-strip-click-selects-the-step',
    `const b = vis('[data-flow-check="logout"]')[0]; if (!b) return 'NO PROBLEM: ' + vis('[data-flow-check]').map((x) => x.dataset.flowCheck).join(',');
     await R.click(b);
     const ins = await __t.waitFor(() => vis('[data-step-inspector="logout"]')[0], 3000);
     const r = box('logout').getBoundingClientRect(); const v = svg().getBoundingClientRect();
     return 'selected: ' + !!ins + ' | in view: ' + (r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom);`,
  ),
  /* ------------------------------------------------------------------ runs */
  step(
    'run-flow-colours-the-steps',
    `await R.click('[data-flow-run]');
     const done = await __t.waitFor(() => (nodes().every((n) => ['passed', 'failed', 'error', 'skipped'].includes(n.dataset.status)) ? 1 : null), 60000);
     return 'done: ' + !!done + ' | statuses: ' + nodes().map((n) => n.dataset.flowNode + '=' + n.dataset.status).join(',');`,
  ),
  step(
    'hover-shows-the-last-response',
    `await sleep(1200);
     await R.move(emptySpot(0.5, 0.9)); await sleep(200);
     await R.move(box('orders'), { fx: 0.4, fy: 0.3 });
     const card = await __t.waitFor(() => vis('[data-flow-preview="orders"] [data-flow-preview-result]')[0], 3000);
     const body = card?.querySelector('[data-flow-preview-body]')?.textContent ?? '';
     await R.move(emptySpot(0.5, 0.9)); await sleep(300);
     return 'card: ' + (card?.dataset.flowPreviewResult ?? 'none') + ' | body: ' + /"status"/.test(body) + ' | gone: ' + !vis('[data-flow-preview]')[0];`,
  ),
  step(
    'click-a-step-result-opens-the-run',
    `const r = byId('login')?.querySelector('[data-flow-result]'); if (!r) return 'NO RESULT TEXT';
     await R.click(r);
     const runs = await __t.waitFor(() => (tabEl('Runs')?.getAttribute('aria-selected') === 'true' ? 1 : null), 3000);
     const t = tabEl('Flow'); if (t) await R.click(t); await __t.waitFor(() => nodes().length > 0, 6000);
     return 'runs tab: ' + !!runs;`,
  ),
  step(
    'breakpoint-pauses-and-continue-finishes',
    `await selectStep('orders'); await R.key('F9');
     const dot = await __t.waitFor(() => byId('orders')?.dataset.breakpoint, 2000);
     await R.click('[data-flow-run-menu]'); if (!(await pickMenu('Run with breakpoints'))) return 'NO ITEM';
     const panel = await __t.waitFor(() => vis('[data-flow-paused-panel]')[0], 15000); if (!panel) return 'NOT PAUSED';
     const paused = nodes().filter((n) => n.dataset.paused).map((n) => n.dataset.flowNode).join(',');
     await R.click('[data-flow-continue]');
     const done = await __t.waitFor(() => (!vis('[data-flow-paused-panel]')[0] && nodes().every((n) => ['passed', 'failed', 'error', 'skipped'].includes(n.dataset.status)) ? 1 : null), 30000);
     await selectStep('orders'); await R.key('F9'); await sleep(300);
     return 'breakpoint: ' + !!dot + ' | paused at: ' + paused + ' | finished after Continue: ' + !!done + ' | removed by F9: ' + !byId('orders')?.dataset.breakpoint;`,
  ),
  step(
    'run-from-selected-and-selected-step',
    `await selectStep('orders');
     await R.click('[data-flow-run-menu]'); if (!(await pickMenu('Run from selected'))) return 'NO ITEM';
     await sleep(500);
     await __t.waitFor(() => (nodes().some((n) => n.dataset.status === 'passed') && !nodes().some((n) => n.dataset.status === 'running') ? 1 : null), 20000);
     await sleep(3000); const a = nodes().filter((n) => n.dataset.status).map((n) => n.dataset.flowNode).join(',');
     await selectStep('profile');
     await R.click('[data-flow-run-menu]'); if (!(await pickMenu('Run selected step'))) return 'NO ITEM 2';
     await sleep(500);
     await __t.waitFor(() => (nodes().some((n) => n.dataset.status === 'passed') && !nodes().some((n) => n.dataset.status === 'running') ? 1 : null), 20000);
     await sleep(3000); const b = nodes().filter((n) => n.dataset.status).map((n) => n.dataset.flowNode).join(',');
     return 'from orders ran: ' + a + ' | profile step ran: ' + b;`,
  ),
  step(
    'pin-a-response-then-unpin',
    `await sleep(1500);
     // close enough to read the step's result line (zoomed far out a step is drawn compact)
     await R.click(vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit')); await sleep(300);
     for (let i = 0; i < 6 && scale() < 0.8; i++) { await R.wheel(box('login'), -200); await sleep(250); }
     await sleep(400);
     await R.rightClick(box('login'), { fx: 0.4, fy: 0.3 }); if (!(await pickMenu('Pin last response'))) return 'NO PIN ITEM: ' + menuItems().join(',');
     const pinned = await __t.waitFor(() => byId('login')?.dataset.pinned, 3000);
     await R.click('[data-flow-run]');
     const res = await __t.waitFor(() => (/pinned/.test(byId('login')?.querySelector('[data-flow-result]')?.textContent ?? '') ? byId('login').querySelector('[data-flow-result]').textContent : null), 30000);
     await __t.waitFor(() => (!nodes().some((n) => n.dataset.status === 'running') ? 1 : null), 30000); await sleep(1500);
     await R.rightClick(box('login'), { fx: 0.4, fy: 0.3 }); await pickMenu('Unpin response');
     const un = await __t.waitFor(() => !byId('login')?.dataset.pinned, 3000);
     return 'pinned: ' + !!pinned + ' | result: ' + res + ' | unpinned: ' + !!un;`,
  ),
  step(
    'marks-and-ports-show-when-zoomed-out',
    `// a breakpoint and a pin on login, then zoomed out until the steps are drawn compact (a long flow fitted in the pane)
     await selectStep('login'); await R.key('F9');
     await R.rightClick(box('login'), { fx: 0.4, fy: 0.3 }); await pickMenu('Pin last response'); await sleep(500);
     for (let i = 0; i < 12 && scale() >= 0.42; i++) { await R.wheel(R.pt(svg()), 300); await sleep(200); }
     await sleep(500);
     const g = byId('login');
     const out = 'zoom: ' + scale().toFixed(2) + ' | breakpoint dot: ' + !!g.querySelector('[data-flow-breakpoint-dot]') + ' | pin badge: ' + !!g.querySelector('[data-flow-pin]') + ' | ports: ' + g.querySelectorAll('[data-flow-port]').length + ' | unresolved mark on logout: ' + !!byId('logout')?.querySelector('[data-flow-unresolved]');
     // undo the marks, back to a readable zoom
     await R.click(vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit')); await sleep(300);
     for (let i = 0; i < 6 && scale() < 0.8; i++) { await R.wheel(box('login'), -200); await sleep(250); }
     await selectStep('login'); await R.key('F9');
     await R.rightClick(box('login'), { fx: 0.4, fy: 0.3 }); await pickMenu('Unpin response'); await sleep(300);
     return out;`,
  ),
  step(
    'enter-on-a-selected-step-opens-the-editor-without-typing-into-it',
    `const before = await fileText(${JSON.stringify(F_MAIN)});
     await selectStep('login'); await R.key('Enter'); await sleep(1200);
     const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
     const v = ed?.getModel().getValue();
     const changed = v !== undefined && v !== before;
     // (the file as it was, for the next steps)
     if (changed) { ed.getModel().setValue(before); }
     await R.click(tabEl('Flow')); await __t.waitFor(() => nodes().length > 0, 6000);
     return 'editor shown: ' + !!ed + ' | the Enter typed into the YAML: ' + changed;`,
  ),
  step(
    'run-history-shows-a-run-on-the-canvas',
    `await act('History');
     const rows = await __t.waitFor(() => (vis('[data-flow-history-run]').length ? vis('[data-flow-history-run]') : null), 5000); if (!rows) return 'NO RUNS';
     rows[0].scrollIntoView({ block: 'nearest' }); await R.click(rows[0]);
     const view = await __t.waitFor(() => vis('[data-flow-run-view]')[0], 4000);
     await act('History');
     return 'runs: ' + rows.length + ' | shown: ' + !!view + ' | closed: ' + !vis('[data-flow-history]')[0];`,
  ),
  step(
    'deploy-panel-lists-every-target',
    `await R.click('[data-flow-deploy]');
     const panel = await __t.waitFor(() => vis('[data-deploy-panel]')[0], 3000); if (!panel) return 'NO PANEL';
     await __t.waitFor(() => panel.querySelector('[data-deploy-target], [data-deploy-unavailable]'), 4000);
     const rows = [...panel.querySelectorAll('[data-deploy-target]')].map((x) => x.dataset.deployTarget + ':' + [...x.querySelectorAll('button')].map((b) => b.textContent.trim()).join('/'));
     await R.key('Escape'); await sleep(300);
     return 'targets: ' + rows.join(', ') + ' | closed by Esc: ' + !vis('[data-deploy-panel]')[0];`,
  ),
  /* ------------------------------------------------------------------ Editor <-> canvas */
  step(
    'editor-edit-saved-shows-on-the-canvas',
    `const t = tabEl('qa-flow.yaml'); if (!t) return 'NO TAB'; await R.click(t);
     const ed = await __t.waitFor(() => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent), 4000); if (!ed) return 'NO EDITOR';
     const model = ed.getModel();
     // a new first item of tests: (the designer may have rewritten the file in block style): Enter at the end of the
     // tests: line, the editor's indentation replaced by the items' own (Shift+Home selects it), the item typed
     const typeItem = async (e) => {
       const m = e.getModel(); const lines = m.getLinesContent(); const t = lines.findIndex((x) => /^tests:/.test(x)) + 1; if (!t) return false;
       const indent = /^(\\s*)/.exec(lines[t] ?? '  ')[1];
       e.setPosition({ lineNumber: t, column: m.getLineMaxColumn(t) }); e.focus(); await sleep(150);
       await R.key('Enter'); await R.key('Home', { shift: true });
       await R.type(indent + '- { id: typed, name: Typed in the editor, url: "${API}/health?typed=1" }'); await sleep(300);
       return /^\\s*- \\{ id: typed/.test(m.getLineContent(t + 1)) && /^\\s*- /.test(m.getLineContent(t + 2)) && /^(\\s*)/.exec(m.getLineContent(t + 2))[1] === indent;
     };
     if (!(await typeItem(ed))) return 'NOT TYPED: ' + model.getValue().split(String.fromCharCode(10)).slice(4, 8).join(' / ');
     // to the canvas without saving: the canvas shows the editor's text?
     await R.click(tabEl('Flow')); await __t.waitFor(() => nodes().length > 0, 6000); await sleep(500);
     const unsaved = !!byId('typed');
     // back to the editor by its tab: the typed text must still be there
     await R.click(tabEl('qa-flow.yaml')); await sleep(600);
     const ed2 = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
     const kept = !!ed2?.getModel().getValue().includes('id: typed');
     if (!kept) await typeItem(ed2);
     ed2.focus(); await R.key('s', { ctrl: true }); await sleep(800);
     await R.click(tabEl('Flow'));
     const n = await __t.waitFor(() => byId('typed'), 6000);
     return 'unsaved edit on the canvas: ' + unsaved + ' | unsaved text kept after Flow and back: ' + kept + ' | saved edit on the canvas: ' + !!n;`,
  ),
  step(
    'canvas-edit-shows-in-the-editor',
    `await selectStep('typed');
     const name = await __t.waitFor(() => vis('[data-step-inspector="typed"] input[aria-label="Step name"]')[0], 3000); if (!name) return 'NO NAME FIELD';
     await R.click(name); await R.key('a', { ctrl: true }); await R.type('Renamed on the canvas'); await R.key('Enter');
     await until(async () => (await fileText(${JSON.stringify(F_MAIN)})).includes('Renamed on the canvas'), 5000);
     await R.click(tabEl('qa-flow.yaml')); await sleep(600);
     const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
     const has = ed?.getModel().getValue().includes('Renamed on the canvas');
     const dirty = /•|●/.test(tabEl('qa-flow.yaml')?.textContent ?? '');
     await R.click(tabEl('Flow')); await __t.waitFor(() => nodes().length > 0, 6000);
     return 'editor shows it: ' + !!has + ' | tab dirty: ' + dirty;`,
  ),
  step(
    'canvas-keeps-view-and-selection-across-tab-switches',
    `await selectStep('orders'); await R.wheel(R.pt(svg()), -300); await sleep(400);
     const t0 = transform();
     await R.click(tabEl('qa-flow.yaml')); await sleep(400); await R.click(tabEl('Flow'));
     await __t.waitFor(() => nodes().length > 0, 6000); await sleep(400);
     return 'view kept: ' + (transform() === t0) + ' | selection kept: ' + selected();`,
  ),
  /* ------------------------------------------------------------------ themes, narrow window */
  step(
    'light-theme',
    `document.documentElement.dataset.theme = 'light'; await sleep(600);
     const c = getComputedStyle(byId('login').querySelector('text')).fill;
     return 'theme: light | step text fill: ' + c;`,
  ),
  step(
    'dark-theme',
    `document.documentElement.dataset.theme = 'dark'; await sleep(600);
     return 'theme: dark | step text fill: ' + getComputedStyle(byId('login').querySelector('text')).fill;`,
  ),
  resize('narrow-900', 900),
  step(
    'toolbar-at-the-narrowest-window',
    `const bar = vis('[data-flow-toolbar]')[0]; if (!bar) return 'NO TOOLBAR';
     const more = vis('[data-flow-toolbar] [data-overflow-menu] button')[0]; if (!more) return 'NO MORE MENU';
     await R.click(more);
     const items = await __t.waitFor(() => (menuItems().length ? menuItems() : null), 2000);
     await R.key('Escape'); await sleep(200);
     const btns = [...bar.querySelectorAll('button')].filter((b) => b.getClientRects().length);
     const cut = btns.filter((b) => b.getBoundingClientRect().right > bar.getBoundingClientRect().right + 1).map((b) => b.textContent.trim() || b.getAttribute('aria-label'));
     return 'menu: ' + (items ?? []).join(',') + ' | cut off: ' + (cut.join(',') || 'none');`,
  ),
  step(
    'toolbar-with-the-canvas-pane-dragged-narrow',
    `const bar = vis('[data-flow-toolbar]')[0]; if (!bar) return 'NO TOOLBAR';
     // the divider between the canvas and the inspector, dragged left (as a user makes room for the inspector)
     const seps = vis('[data-flow-designer] [role=separator]').filter((x) => { const r = x.getBoundingClientRect(); return r.height > r.width; });
     const sep = seps[0]; if (!sep) return 'NO DIVIDER';
     await R.drag(sep, sep, { to: { dx: -(svg().getBoundingClientRect().width - 380) }, steps: 10 }); await sleep(500);
     const btns = [...bar.querySelectorAll('button')].filter((b) => b.getClientRects().length);
     const br = bar.getBoundingClientRect();
     const cut = btns.filter((b) => b.getBoundingClientRect().right > br.right + 1 || b.getBoundingClientRect().width < 8).map((b) => b.textContent.trim() || b.getAttribute('aria-label'));
     const w = Math.round(svg().getBoundingClientRect().width);
     await R.drag(sep, sep, { to: { dx: 500 }, steps: 10 }); await sleep(400);
     return 'buttons: ' + btns.length + ' | cut off: ' + (cut.join(',') || 'none') + ' | canvas width: ' + w;`,
  ),
  resize('wide-again', 1440),
  /* ------------------------------------------------------------------ a 200-step flow */
  step(
    'big-flow-opens',
    `if (!(await openFile('qa-big.yaml'))) return 'NO FLOW';
     await __t.waitFor(() => nodes().length > 0, 10000);
     // again, timed: from the click on the Flow tab to the steps on screen
     await R.click(tabEl('qa-big.yaml')); await sleep(800);
     const t0 = performance.now(); await R.click(tabEl('Flow'));
     await __t.waitFor(() => nodes().length > 0, 10000); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
     const ms = Math.round(performance.now() - t0);
     const map = !!vis('[data-flow-minimap]')[0];
     return 'drawn: ' + nodes().length + ' | ms: ' + ms + ' | minimap: ' + map;`,
  ),
  step(
    'big-flow-minimap-click-and-drag',
    `let map = vis('[data-flow-minimap]')[0]; if (!map) { await act('Minimap'); map = await __t.waitFor(() => vis('[data-flow-minimap]')[0], 2000); } if (!map) return 'NO MINIMAP';
     const t0 = transform();
     await R.click(map, { fx: 0.85, fy: 0.85 }); await sleep(300); const t1 = transform();
     await R.drag(map, map, { from: { fx: 0.85, fy: 0.85 }, to: { fx: 0.15, fy: 0.15 }, steps: 10 }); await sleep(300); const t2 = transform();
     const r0 = await act('Minimap'); const hidden = !vis('[data-flow-minimap]')[0]; await act('Minimap');
     return 'click moves: ' + (t1 !== t0) + ' | drag moves: ' + (t2 !== t1) + ' | toggle hides: ' + hidden;`,
  ),
  step(
    'big-flow-wheel-zoom-is-smooth',
    `const c = R.pt(svg()); const frames = []; let last = performance.now(); let on = true;
     const tick = () => { const n = performance.now(); frames.push(n - last); last = n; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
     for (let i = 0; i < 12; i++) await R.wheel(c, i < 6 ? -120 : 120);
     await sleep(600); on = false;
     const worst = Math.round(Math.max(...frames.slice(1)));
     return 'worst frame ms: ' + worst + ' | frames: ' + frames.length;`,
  ),
  step(
    'big-flow-drag-a-step',
    `await R.click(vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit')); await sleep(400);
     await R.wheel(R.pt(svg()), -600); await sleep(500);
     const n = nodes().find((x) => { const r = x.getBoundingClientRect(); const v = svg().getBoundingClientRect(); return r.left > v.left + 50 && r.right < v.right - 200 && r.top > v.top + 50 && r.bottom < v.bottom - 120; }); if (!n) return 'NO STEP IN VIEW';
     const id = n.dataset.flowNode; const t0 = performance.now();
     await R.drag(box(id), box(id), { from: { fx: 0.4, fy: 0.3 }, to: { fx: 0.4, fy: 0.3, dx: 80, dy: 40 }, steps: 12 });
     const dragMs = Math.round(performance.now() - t0);
     const s = await until(async () => (await stepOf(${JSON.stringify(F_BIG)}, id))?.position, 8000);
     return 'saved: ' + !!s + ' | drag ms (12 moves): ' + dragMs + ' | save ms: ' + Math.round(performance.now() - t0 - dragMs);`,
  ),
  step(
    'big-flow-find',
    `await R.click(emptySpot(0.5, 0.5)); await R.key('f', { ctrl: true });
     const input = await __t.waitFor(() => vis('[data-flow-find] input')[0], 2000); if (!input) return 'NO FIND BOX';
     await R.type('Step 187'); await R.key('Enter');
     const ok = await __t.waitFor(() => (selected() === 's187' ? 1 : null), 3000);
     const r = box('s187')?.getBoundingClientRect(); const v = svg().getBoundingClientRect();
     await R.key('Escape');
     return 'selected: ' + !!ok + ' | in view: ' + (!!r && r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom);`,
  ),
];

module.exports = withExpect(steps, {
  'real-input-hits-the-element-under-the-pointer': /^send: ok \| events: pointerdown:true,pointerup:true,click:true,$/,
  'empty-flow-start-and-suggestions': /^trigger: Manual \| suggestions: blocks,example,collection,record,ai \| start edges: 5 \| run disabled: true$/,
  'trigger-menu-lists-every-trigger': /^items: Manual,Schedule…,Webhook,MCP tool…,CI… \| manual toast: true \| menu closed: true$/,
  'trigger-webhook-turns-it-on': /^written: true \| trigger: .*Webhook/,
  'trigger-mcp-and-ci-open-their-dialogs': /^mcp dialog: true \| ci dialog: true \| closed: true$/,
  'add-input-by-typing': /^name focused: true \| saved: true \| backspace edits the field: true$/,
  'input-saved-when-focus-leaves': /^saved on blur: true$/,
  'suggestion-add-blocks-opens-the-picker-esc-closes': /^focused: true \| options: \d+ \| closed by Esc: true$/,
  'suggestion-collection-opens-the-picker': /^picker: true \| closed: true$/,
  'suggestion-ai-asks-and-cancels': /^dialog: true \| closed: true \| file unchanged: true$/,
  'suggestion-example-then-ctrl-z-undoes': /ctrl\+z at once undoes: true/,
  'start-port-click-adds-a-block-after-start': /^type: delay \| waits for:  \| hangs off start: [12] \| selected: \S+$/,
  'every-block-type-from-the-toolbar-picker': /^added: 16 \| types as picked: yes \| not chained: none \| problems: none$/,
  'parallel-group-block': /^frame: true \| steps in group: 2$/,
  'inspector-edits-of-every-block-type-save-to-yaml': /^steps: 18 \| problems: none$/,
  'sub-flow-file-picked-in-the-inspector': /^saved: true$/,
  'open-main-flow': /^nodes: 6 \| edges: 5 \| checks: logout:unset-variable \| when label: true$/,
  'click-selects-a-step': /^selected: profile \| inspector: true \| canvas focused: true$/,
  'shift-click-adds-and-removes': /^two: profile,orders \| multi inspector: true \| after second shift-click: profile$/,
  'click-on-empty-canvas-clears': /^selected: none$/,
  'escape-clears-the-selection': /^selected after Esc: none$/,
  'ctrl-a-selects-every-step': /^selected by Ctrl\+A: 6 \| page text selected: 0 \| a step drags after it: true$/,
  'drag-on-empty-canvas': /^panned: true \| box-selected: none$/,
  'drag-a-step-moves-it': /^moved by the pointer: true .* every step placed: true \| selected after the drag: logout$/,
  'drag-the-top-step-above-the-first-row': /jumps back: false$/,
  'ctrl-z-and-ctrl-y-undo-and-redo-the-move': /^undo: true \| redo: true \| focus: canvas$/,
  'snap-and-alignment-guides': /pressed=(true|undefined) \| guide while dragging: true \| lined up: true \| on the grid: true$/,
  'connect-by-dragging-a-port-onto-a-step': /^logout waits for: profile,orders \| edge drawn: true \| picker opened: false$/,
  'connect-refuses-a-cycle': /^refused: true \| file unchanged: true$/,
  'start-port-dragged-onto-a-step-makes-it-wait-for-nothing': /^waits for nothing: true \| hangs off start: 1 \| undone: true$/,
  'picker-search-ranks-the-exact-match-first': /^Log: Log \| del: Delay \| set: Set variable$/,
  'delete-removes-several-selected-steps-and-undo-brings-them-back': /^deleted both: true \| focus after the delete: canvas \| Ctrl\+Z at once undoes: true$/,
  'click-an-edge-then-delete-removes-it': /^inspector says: true \| drawn selected: true \| removed: true$/,
  'right-click-an-edge-offers-a-menu': /^menu: .*Delete/,
  'condition-false-port-click-adds-on-the-false-branch': /^waits for: check \| when: false \| selected: log$/,
  'condition-true-port-drag-onto-a-step': /^added on true: true \| label: true$/,
  'port-plus-shows-on-hover-and-opens-the-picker': /^plus opacity on hover: 1 \| picker: true \| closed: true \| selection changed to: /,
  'connection-dropped-on-empty-canvas-opens-the-picker-arrows-enter': /^at the drop: true \| first: Delay \| arrows: true \| added: delay after logout$/,
  'toolbar-block-adds-after-the-selected-step': /^waits for: login \| selected: assert \| overlapping: none$/,
  'picker-adds-a-saved-request': /^added: true \| selected: a-user/,
  'delete-key-removes-the-selected-step': /^removed: true$/,
  'ctrl-d-duplicates-and-ctrl-z-undoes': /^duplicated: true \| copy selected: true \| undone: true$/,
  'ctrl-c-ctrl-v-pastes-a-copy': /^toast: true \| pasted: true \| undone: true$/,
  'double-click-a-step-opens-it-in-the-editor': /^editor: true \| at the step: true$/,
  'rename-in-the-inspector': /^saved: true \| node shows it: true \| still selected: profile$/,
  'typing-in-the-inspector-never-triggers-canvas-shortcuts': /^steps: same \| still selected: profile \| file: unchanged$/,
  'text-button-adds-a-note': /^notes: 1 \| saved: true \| hint: true$/,
  'note-double-click-edits-type-ctrl-enter-saves': /^editing: true \| focused: true \| saved: true \| markdown: Bold \| editor closed: true$/,
  'note-escape-cancels-the-edit': /^closed: true \| discarded: true \| shown: /,
  'note-blur-saves': /^saved: true \| closed: true \| italic: true$/,
  'typing-in-a-note-never-triggers-canvas-shortcuts': /^steps: same \| still editing: true \| find opened: false \| palette opened: false \| breakpoint set: false \| file: unchanged$/,
  'note-drag-moves-it': /^moved with the pointer: true \| not editing: true$/,
  'note-corner-resizes-it': /^resized with the pointer: true \| moved: false$/,
  'note-right-click-colour': /^menu: Colour,Delete note \| blue: true$/,
  'canvas-double-click-menu-adds-a-note-there': /^menu: Add note here,Add step here \| note near the click: true$/,
  'canvas-double-click-add-step-here': /^added: true \| near the click: true$/,
  'a-selected-note-is-deleted-with-the-delete-key': /^notes: (\d+) -> (?!\1)\d+$/,
  'note-right-click-delete-and-undo': /^deleted: true \| undone: true$/,
  'frame-selection': /^title: Reads \| saved: true$/,
  'frame-rename-and-recolour': /^renamed: true \| green: true$/,
  'frame-title-drag-moves-its-steps': (r) => {
    const m = /^moved: true by (-?\d+) \(want (-?\d+)\)$/.exec(r);
    return m && Math.abs(+m[1] - +m[2]) <= 3 ? true : 'expected the steps to move with the pointer';
  },
  'frame-select-its-steps': /^selected: profile,orders$/,
  'right-click-a-step-offers-its-menu': /Run from here.*Open in editor.*(Duplicate|Delete)|(Duplicate|Delete).*Run from here/,
  'right-click-the-empty-canvas-offers-a-menu': /^menu: .*Add note/,
  'align-left-and-distribute': /^left: true \| distributed: true$/,
  'auto-arrange-keeps-notes-and-frames': /^via: (button|menu) \| positions gone: true \| notes kept: [1-9]\d* \| frames kept: 1 \| overlapping: none \| frame title under: title$/,
  'frame-remove-keeps-the-steps': /^removed: true \| steps kept: true$/,
  'parallel-and-finally-lanes': /^parallel frame: true \| group: profile,orders \| finally lane: true \| finally: (happy,assert|assert,happy) \| overlapping: none$/,
  'drop-a-step-into-the-parallel-frame': /^joined: group-\d+ \| overlapping: none$/,
  'wheel-zooms-around-the-pointer': /^in: true \| out: true \| ctrl\+wheel zooms: true \| zoom buttons: [1-9]/,
  'fit-shows-everything': /^outside the view: none$/,
  'ctrl-f-finds-enter-shift-enter-esc': /^focused: true \| before Enter: 0 of \d+ \| next: true \| previous: true \| count: \d+ of \d+ \| closed: true \| focus back on canvas: true$/,
  'ctrl-k-lists-canvas-commands-first': /^first: Add step: HTTP request.* \| snap command: true \| closed: true$/,
  'problems-strip-click-selects-the-step': /^selected: true \| in view: true$/,
  'run-flow-colours-the-steps': /^done: true \| statuses: /,
  'hover-shows-the-last-response': /^card: passed \| body: true \| gone: true$/,
  'click-a-step-result-opens-the-run': /^runs tab: true$/,
  'breakpoint-pauses-and-continue-finishes': /^breakpoint: true \| paused at: orders \| finished after Continue: true \| removed by F9: true$/,
  'run-from-selected-and-selected-step': (r) => {
    const m = /^from orders ran: (.*) \| profile step ran: (.*)$/.exec(r);
    if (!m) return 'no result';
    const a = m[1].split(',');
    const b = m[2].split(',').sort().join(',');
    return a.includes('orders') && !a.includes('login') && b === 'login,profile' ? true : 'expected the run from orders to skip login, and the step run to be login + profile';
  },
  'pin-a-response-then-unpin': /^pinned: true \| result: pinned · passed \| unpinned: true$/,
  'run-history-shows-a-run-on-the-canvas': /^runs: \d+ \| shown: true \| closed: true$/,
  'deploy-panel-lists-every-target': /^targets: schedule:.*, webhook:.*, mcp:.*, ci:.* \| closed by Esc: true$/,
  'editor-edit-saved-shows-on-the-canvas': /^unsaved edit on the canvas: true \| unsaved text kept after Flow and back: true \| saved edit on the canvas: true$/,
  'marks-and-ports-show-when-zoomed-out': /^zoom: 0\.\d+ \| breakpoint dot: true \| pin badge: true \| ports: [1-9] \| unresolved mark on logout: true$/,
  'enter-on-a-selected-step-opens-the-editor-without-typing-into-it': /^editor shown: true \| the Enter typed into the YAML: false$/,
  'canvas-edit-shows-in-the-editor': /^editor shows it: true \| tab dirty: false$/,
  'canvas-keeps-view-and-selection-across-tab-switches': /^view kept: true \| selection kept: orders$/,
  'light-theme': /^theme: light/,
  'dark-theme': /^theme: dark/,
  'narrow-900': /^width \d+$/,
  'toolbar-at-the-narrowest-window': /^menu: .*Snap \| cut off: none$/,
  'toolbar-with-the-canvas-pane-dragged-narrow': /^buttons: \d+ \| cut off: none \| canvas width: \d+$/,
  'wide-again': /^width 1440$/,
  'big-flow-opens': (r) => {
    const m = /drawn: (\d+) \| ms: (\d+) \| minimap: true/.exec(r);
    return m && +m[1] > 0 && +m[2] < 1500 ? true : 'expected drawn steps, under 1.5 s and a minimap';
  },
  'big-flow-minimap-click-and-drag': /^click moves: true \| drag moves: true \| toggle hides: true$/,
  'big-flow-wheel-zoom-is-smooth': (r) => {
    const m = /worst frame ms: (\d+)/.exec(r);
    return m && +m[1] < 100 ? true : 'a frame over 100 ms while zooming';
  },
  'big-flow-drag-a-step': /^saved: true/,
  'big-flow-find': /^selected: true \| in view: true$/,
});
