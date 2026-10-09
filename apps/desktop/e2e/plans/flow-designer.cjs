// The flow designer (a test file's Flow tab): an empty flow file starts from the designer's first choices; a step comes
// from a saved request of a collection, a second is a blank HTTP step, dragging from one step's output port onto the
// other connects them (dependsOn), the inspector edits the URL and adds an extract, Run flow lights both steps up,
// the Editor tab shows the YAML the canvas wrote, Undo takes the last change back, and a Delay of 300 ms put between
// the two steps runs and passes.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const FILE = 'rest/designed-flow.yaml';
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const node = (i) => nodes()[i];
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const centre = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  const pointer = (el, type, at) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
  const editorText = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)?.getValue() ?? 'NO EDITOR';
  // waits for an async check (__t.waitFor takes a synchronous one)
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const fileText = () => window.aps.invoke('tests.read', { path: ${JSON.stringify(FILE)} });
  const clickBackground = () => { const s = svg(); const r = s.getBoundingClientRect(); const at = { clientX: r.left + 6, clientY: r.top + 6 }; pointer(s, 'pointerdown', at); pointer(s, 'pointerup', at); };
  const select = async (i) => { node(i).dispatchEvent(new MouseEvent('click', { bubbles: true })); return __t.waitFor(() => document.querySelector('[data-step-inspector="' + node(i).dataset.flowNode + '"]'), 3000); };
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  const selectId = async (id) => { const n = byId(id); if (!n) return null; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return __t.waitFor(() => document.querySelector('[data-step-inspector="' + id + '"]'), 3000); };
  const setUrl = async (url) => { const u = vis('[data-flow-inspector] input[aria-label="URL"]')[0]; if (!u) return false; u.focus(); setInput(u, url); u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'empty-flow-starts-the-designer',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: 'name: Designed flow\\ntests: []\\n' });
     await __t.view('Tests'); await __t.sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('designed-flow.yaml')), 4000);
     if (!r) return 'NO ROW'; r.click(); await __t.sleep(1200);
     await __t.tab('Flow');
     const d = await __t.waitFor(() => document.querySelector('[data-flow-designer]'), 5000); if (!d) return 'NO DESIGNER';
     return [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' | ');`,
  ),
  step(
    'add-from-a-collection',
    `if (!(await __t.button('Create from a collection'))) return 'NO BUTTON';
     const sel = await __t.waitFor(() => document.querySelector('[data-collection-picker] select'), 3000); if (!sel) return 'NO PICKER';
     const opt = [...sel.options].find((o) => o.textContent.startsWith('Public REST')); if (!opt) return 'NO COLLECTION';
     setInput(sel, opt.value); await __t.sleep(400);
     const req = await __t.waitFor(() => [...document.querySelectorAll('[data-pick-request]')].find((b) => b.dataset.pickRequest.startsWith('A user')), 3000); if (!req) return 'NO REQUEST';
     req.click();
     if (!(await __t.waitFor(() => nodes().length === 1, 6000))) return 'NO NODE';
     return 'nodes: ' + nodes().map((n) => n.dataset.flowNode).join(',') + ' | dialog closed: ' + !document.querySelector('[data-collection-picker]');`,
  ),
  step(
    'add-a-blank-http-step',
    `clickBackground(); await __t.sleep(300);
     const add = vis('[data-flow-add]')[0]; if (!add) return 'NO ADD BUTTON'; add.click();
     const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim() === 'HTTP request'), 2000); if (!item) return 'NO MENU ITEM';
     item.click();
     if (!(await __t.waitFor(() => nodes().length === 2, 6000))) return 'NO SECOND NODE';
     return 'nodes: ' + nodes().map((n) => n.dataset.flowNode).join(',') + ' | edges: ' + document.querySelectorAll('[data-flow-designer] [data-flow-edge]').length;`,
  ),
  step(
    'connect-port-to-port',
    `const [a, b] = nodes(); const from = a.dataset.flowNode; const to = b.dataset.flowNode;
     const port = a.querySelector('[data-flow-port="out"]'); if (!port) return 'NO PORT';
     const target = b.querySelector('rect');
     pointer(port, 'pointerdown', centre(port)); await __t.sleep(50);
     pointer(svg(), 'pointermove', centre(target)); await __t.sleep(50);
     pointer(svg(), 'pointerup', centre(target));
     const edge = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-edge="' + from + '>' + to + '"]'), 6000);
     return 'edge: ' + !!edge + ' | yaml dependsOn: ' + /dependsOn: \\[ ?a-user-s-carts ?\\]/.test(await fileText());`,
  ),
  step(
    'drag-saves-the-layout',
    `const b = node(1); const at = centre(b.querySelector('rect'));
     pointer(b, 'pointerdown', at); await __t.sleep(50);
     pointer(svg(), 'pointermove', { clientX: at.clientX + 40, clientY: at.clientY + 60 }); await __t.sleep(50);
     pointer(svg(), 'pointerup', { clientX: at.clientX + 40, clientY: at.clientY + 60 });
     const t = await until(async () => { const x = await fileText(); return /\\nlayout:/.test(x) ? x : null; }, 5000);
     if (!t) return 'NO LAYOUT';
     return 'layout: ' + /a-user-s-carts: \\[ ?\\d+, \\d+ ?\\]/.test(t) + ',' + /http-request: \\[ ?\\d+, \\d+ ?\\]/.test(t);`,
  ),
  step(
    'inspector-url-and-extract',
    `if (!(await select(0))) return 'NO INSPECTOR';
     if (!(await setUrl('http://127.0.0.1:4010/health'))) return 'NO URL FIELD';
     if (!(await until(async () => (await fileText()).includes('url: http://127.0.0.1:4010/health'), 5000))) return 'URL NOT SAVED';
     const box = await __t.waitFor(() => document.querySelector('[data-step-inspector] [data-inspector-extract]'), 3000); if (!box) return 'NO EXTRACT';
     const key = box.querySelector('input[aria-label="New variable"]'); if (!key) return 'NO KEY FIELD';
     setInput(key, 'status'); await __t.sleep(300);
     const value = await __t.waitFor(() => box.querySelector('input[aria-label="Value of status"]'), 2000); if (!value) return 'NO VALUE FIELD';
     setInput(value, '$.status');
     const saved = await until(async () => /extract:\\r?\\n\\s+status: \\$\\.status/.test(await fileText()), 6000);
     // the second step reads the value: the edge is labelled with it
     if (!(await select(1))) return 'NO SECOND INSPECTOR';
     if (!(await setUrl('http://127.0.0.1:4010/health?s={{status}}'))) return 'NO URL FIELD 2';
     const label = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-edge-vars]')?.textContent, 6000);
     return 'extract saved: ' + !!saved + ' | edge label: ' + label;`,
  ),
  step(
    'run-flow-lights-the-steps',
    `if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     const done = await __t.waitFor(() => nodes().length === 2 && nodes().every((n) => ['passed', 'failed', 'error', 'skipped'].includes(n.dataset.status)) ? true : null, 60000);
     if (!done) return 'NOT ALL STATUSES: ' + nodes().map((n) => n.dataset.status).join(',');
     return 'statuses: ' + nodes().map((n) => n.dataset.status).join(',') + ' | still on the flow: ' + !!document.querySelector('[data-flow-designer]');`,
  ),
  step(
    'yaml-in-the-editor',
    `document.querySelector('main [role=tab][data-tab-id="file:${FILE}"]')?.click(); await __t.sleep(1500);
     const t = editorText();
     return ['name: A user', 'name: HTTP request', 'url: http://127.0.0.1:4010/health', 'status: $.status', '{{status}}'].map((s) => s + ': ' + t.includes(s)).join(' | ') + ' | dependsOn: ' + /dependsOn: \\[ ?a-user-s-carts ?\\]/.test(t);`,
  ),
  step(
    'undo-takes-the-last-change-back',
    `await __t.tab('Flow'); if (!(await __t.waitFor(() => nodes().length === 2, 5000))) return 'NO FLOW';
     const undo = vis('[data-flow-undo]')[0]; if (!undo || undo.disabled) return 'NO UNDO';
     undo.click();
     const back = await until(async () => !(await fileText()).includes('{{status}}'), 5000);
     await __t.sleep(500);
     document.querySelector('main [role=tab][data-tab-id="file:${FILE}"]')?.click(); await __t.sleep(1200);
     const t = editorText();
     return 'undone: ' + !!back + ' | edge label gone: ' + !document.querySelector('[data-flow-edge-vars]') + ' | editor: ' + (!t.includes('{{status}}') && t.includes('status: $.status'));`,
  ),
  step(
    'delay-between-the-steps',
    `await __t.tab('Flow'); if (!(await __t.waitFor(() => nodes().length === 2, 5000))) return 'NO FLOW';
     // the second step calls the health URL again (Undo took its URL back)
     if (!(await selectId('http-request'))) return 'NO SECOND INSPECTOR';
     if (!(await setUrl('http://127.0.0.1:4010/health'))) return 'NO URL FIELD';
     if (!(await until(async () => (await fileText()).split('url: http://127.0.0.1:4010/health').length === 3, 5000))) return 'URL NOT SAVED';
     // a Delay after the first step (it waits for it)
     if (!(await selectId('a-user-s-carts'))) return 'NO FIRST INSPECTOR';
     const add = vis('[data-flow-add]')[0]; if (!add) return 'NO ADD BUTTON'; add.click();
     const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim() === 'Delay'), 2000); if (!item) return 'NO DELAY ITEM';
     item.click();
     if (!(await __t.waitFor(() => byId('wait'), 6000))) return 'NO DELAY NODE: ' + nodes().map((n) => n.dataset.flowNode).join(',');
     if (!(await selectId('wait'))) return 'NO DELAY INSPECTOR';
     const ms = await __t.waitFor(() => vis('[data-step-inspector="wait"] input[data-inspector-wait]')[0], 3000); if (!ms) return 'NO WAIT FIELD';
     ms.focus(); setInput(ms, '300'); ms.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     if (!(await until(async () => /type: delay\\r?\\n\\s+ms: 300/.test(await fileText()), 5000))) return 'MS NOT SAVED: ' + (await fileText());
     // the second step waits for the delay
     if (!(await selectId('http-request'))) return 'NO SECOND INSPECTOR AGAIN';
     const box = vis('[data-step-inspector="http-request"] [data-inspector-waits] label').find((l) => l.textContent.includes('wait')); if (!box) return 'NO WAITS-FOR ROW';
     const cb = box.querySelector('input[type=checkbox]'); if (!cb.checked) cb.click();
     if (!(await until(async () => /dependsOn: \\[ ?a-user-s-carts, wait ?\\]/.test(await fileText()), 5000))) return 'NOT CONNECTED: ' + (await fileText());
     if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     const done = await __t.waitFor(() => nodes().length === 3 && nodes().every((n) => ['passed', 'failed', 'error', 'skipped'].includes(n.dataset.status)) ? true : null, 60000);
     if (!done) return 'NOT ALL STATUSES: ' + nodes().map((n) => n.dataset.flowNode + '=' + n.dataset.status).join(',');
     return 'delay: ' + byId('wait').dataset.status + ' | statuses: ' + nodes().map((n) => n.dataset.status).join(',') + ' | edges: ' + document.querySelectorAll('[data-flow-designer] [data-flow-edge]').length;`,
  ),
];

module.exports = withExpect(steps, {
  'empty-flow-starts-the-designer': /Add a step \| Create from a collection \| Generate with AI/,
  'add-from-a-collection': /^nodes: a-user-s-carts \| dialog closed: true$/,
  'add-a-blank-http-step': /^nodes: a-user-s-carts,http-request \| edges: 0$/,
  'connect-port-to-port': /^edge: true \| yaml dependsOn: true$/,
  'drag-saves-the-layout': /^layout: true,true$/,
  'inspector-url-and-extract': /^extract saved: true \| edge label: \{\{status\}\}$/,
  'run-flow-lights-the-steps': /^statuses: passed,passed \| still on the flow: true$/,
  'yaml-in-the-editor': /^name: A user: true \| name: HTTP request: true \| url: http:\/\/127\.0\.0\.1:4010\/health: true \| status: \$\.status: true \| \{\{status\}\}: true \| dependsOn: true$/,
  'undo-takes-the-last-change-back': /^undone: true \| edge label gone: true \| editor: true$/,
  'delay-between-the-steps': /^delay: passed \| statuses: passed,passed,passed \| edges: 3$/,
});
