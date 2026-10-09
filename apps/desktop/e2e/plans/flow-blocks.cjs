// The flow designer's blocks: on an empty flow file, a request followed by a Condition (status == 200) with a Log on its
// true branch and a request on its false branch (dragged from the condition's false dot), a For each over a 3-row
// inline list hitting the demo server with ?i={{$index}}, a Script setting a variable the next step (a Log) reads, a
// Sub-flow running another file with an input, and the flow's Output. Run flow: the taken branch passes, the other is
// skipped, the loop shows × 3; the Editor tab shows the YAML the canvas wrote.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const FILE = 'rest/blocks-flow.yaml';
const CHILD = 'rest/child-flow.yaml';
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const centre = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  const pointer = (el, type, at) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
  const editorText = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)?.getValue() ?? 'NO EDITOR';
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const fileText = () => window.aps.invoke('tests.read', { path: ${JSON.stringify(FILE)} });
  const clickBackground = () => { const s = svg(); const r = s.getBoundingClientRect(); const at = { clientX: r.left + 6, clientY: r.top + 6 }; pointer(s, 'pointerdown', at); pointer(s, 'pointerup', at); };
  const selectId = async (id) => { const n = byId(id); if (!n) return null; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return __t.waitFor(() => document.querySelector('[data-step-inspector="' + id + '"]'), 3000); };
  const add = async (label, id) => {
    const b = vis('[data-flow-add]')[0]; if (!b) return 'NO ADD BUTTON'; b.click();
    const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim() === label), 2000); if (!item) return 'NO MENU ITEM ' + label;
    item.click();
    if (!(await __t.waitFor(() => byId(id), 6000))) return 'NO NODE ' + id + ': ' + nodes().map((n) => n.dataset.flowNode).join(',');
    return '';
  };
  const setUrl = async (url) => { const u = vis('[data-flow-inspector] input[aria-label="URL"]')[0]; if (!u) return false; u.focus(); setInput(u, url); u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-an-empty-flow',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(CHILD)}, content: 'name: Child flow\\noutput:\\n  greeting: "hello {{who}}"\\ntests:\\n  - { name: Child log, type: log, message: "child for {{who}}" }\\n' });
     await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: 'name: Blocks flow\\ntests: []\\n' });
     await __t.view('Tests'); await __t.sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('blocks-flow.yaml')), 4000);
     if (!r) return 'NO ROW'; r.click(); await __t.sleep(1200);
     await __t.tab('Flow');
     if (!(await __t.waitFor(() => document.querySelector('[data-flow-designer]'), 5000))) return 'NO DESIGNER';
     if (!(await __t.button('Add a step'))) return 'NO ADD A STEP';
     if (!(await __t.waitFor(() => byId('http-request'), 6000))) return 'NO FIRST NODE';
     if (!(await setUrl('http://127.0.0.1:4010/health'))) return 'NO URL FIELD';
     return 'url saved: ' + !!(await until(async () => (await fileText()).includes('url: http://127.0.0.1:4010/health'), 5000));`,
  ),
  step(
    'condition-after-the-request',
    `if (!(await selectId('http-request'))) return 'NO INSPECTOR';
     const e = await add('Condition (if / else)', 'condition'); if (e) return e;
     const t = await until(async () => { const x = await fileText(); return /type: condition/.test(x) ? x : null; }, 5000);
     if (!t) return 'NOT SAVED';
     const field = await __t.waitFor(() => vis('[data-step-inspector="condition"] input[aria-label="Condition"]')[0], 3000);
     return 'condition: ' + /if: status == 200/.test(t) + ' | after the request: ' + /dependsOn: \\[ ?http-request ?\\]/.test(t) + ' | inspector: ' + (field ? field.value : 'NO FIELD') + ' | two ports: ' + byId('condition').querySelectorAll('[data-flow-port="out"][data-flow-when]').length;`,
  ),
  step(
    'log-on-the-true-branch',
    `if (!(await selectId('condition'))) return 'NO CONDITION INSPECTOR';
     const e = await add('Log', 'log'); if (e) return e;
     const t = await until(async () => { const x = await fileText(); return /type: log[\\s\\S]*when: true/.test(x) ? x : null; }, 5000);
     const label = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-edge-when="condition>log"]')?.textContent, 4000);
     return 'when true saved: ' + !!t + ' | edge label: ' + label;`,
  ),
  step(
    'request-on-the-false-branch-by-its-port',
    `clickBackground(); await __t.sleep(300);
     const e = await add('HTTP request', 'http-request-2'); if (e) return e;
     if (!(await selectId('http-request-2'))) return 'NO INSPECTOR';
     if (!(await setUrl('http://127.0.0.1:4010/health?branch=false'))) return 'NO URL FIELD';
     if (!(await until(async () => (await fileText()).includes('branch=false'), 5000))) return 'URL NOT SAVED';
     const port = byId('condition').querySelector('[data-flow-port="out"][data-flow-when="false"]'); if (!port) return 'NO FALSE PORT';
     const target = byId('http-request-2').querySelector('rect');
     pointer(port, 'pointerdown', centre(port)); await __t.sleep(50);
     pointer(svg(), 'pointermove', centre(target)); await __t.sleep(50);
     pointer(svg(), 'pointerup', centre(target));
     const label = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-edge-when="condition>http-request-2"]')?.textContent, 6000);
     const t = await fileText();
     return 'edge label: ' + label + ' | yaml: ' + /branch=false[\\s\\S]*dependsOn: \\[ ?condition ?\\][\\s\\S]*when: false/.test(t);`,
  ),
  step(
    'for-each-over-three-rows',
    `clickBackground(); await __t.sleep(300);
     const e = await add('For each (loop)', 'for-each'); if (e) return e;
     if (!(await selectId('for-each'))) return 'NO INSPECTOR';
     if (!(await setUrl('http://127.0.0.1:4010/health?i={{$index}}'))) return 'NO URL FIELD';
     const t = await until(async () => { const x = await fileText(); return x.includes('health?i={{$index}}') ? x : null; }, 5000);
     if (!t) return 'URL NOT SAVED';
     const rows = vis('[data-step-inspector="for-each"] [data-inspector-repeat] select[aria-label="Repeat"]')[0];
     return 'rows: ' + (t.match(/- id: [123]/g) ?? []).length + ' | node: ' + byId('for-each').querySelector('[data-flow-loop]')?.textContent + ' | mode: ' + (rows ? rows.value : 'NO SELECT');`,
  ),
  step(
    'script-sets-a-variable-the-next-step-reads',
    `clickBackground(); await __t.sleep(300);
     let e = await add('Script', 'script'); if (e) return e;
     if (!(await selectId('script'))) return 'NO SCRIPT INSPECTOR';
     e = await add('Log', 'log-2'); if (e) return e;
     const label = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-edge-vars="script>log-2"]')?.textContent, 6000);
     const t = await fileText();
     return 'script: ' + t.includes("tp.variables.set('value', 42)") + ' | log reads it: ' + t.includes('Value: {{value}}') + ' | edge label: ' + label;`,
  ),
  step(
    'sub-flow-with-an-input',
    `clickBackground(); await __t.sleep(300);
     const e = await add('Sub-flow', 'sub-flow'); if (e) return e;
     if (!(await selectId('sub-flow'))) return 'NO INSPECTOR';
     const sel = await __t.waitFor(() => { const s = vis('[data-step-inspector="sub-flow"] select[aria-label="Flow file"]')[0]; return s && [...s.options].some((o) => o.value === 'child-flow.yaml') ? s : null; }, 5000);
     if (!sel) return 'NO FILE CHOICE';
     setInput(sel, 'child-flow.yaml');
     if (!(await until(async () => (await fileText()).includes('file: child-flow.yaml'), 5000))) return 'FILE NOT SAVED';
     const box = await __t.waitFor(() => vis('[data-step-inspector="sub-flow"] [data-inspector-inputs]')[0], 3000); if (!box) return 'NO INPUTS';
     const key = box.querySelector('input[aria-label="New variable"]'); if (!key) return 'NO KEY FIELD';
     setInput(key, 'who'); await __t.sleep(300);
     const value = await __t.waitFor(() => box.querySelector('input[aria-label="Value of who"]'), 2000); if (!value) return 'NO VALUE FIELD';
     setInput(value, 'Ada');
     const saved = await until(async () => /inputs:\\r?\\n\\s+who: Ada/.test(await fileText()), 6000);
     return 'inputs saved: ' + !!saved + ' | node: ' + (byId('sub-flow').textContent.includes('runs child-flow.yaml'));`,
  ),
  step(
    'flow-output',
    `clickBackground(); await __t.sleep(400);
     const box = await __t.waitFor(() => vis('[data-flow-inspector] [data-flow-output]')[0], 3000); if (!box) return 'NO OUTPUT EDITOR';
     const key = box.querySelector('input[aria-label="New name"]'); if (!key) return 'NO KEY FIELD';
     setInput(key, 'greeting'); await __t.sleep(300);
     const value = await __t.waitFor(() => box.querySelector('input[aria-label="Value of greeting"]'), 2000); if (!value) return 'NO VALUE FIELD';
     setInput(value, '{{greeting}}');
     const t = await until(async () => { const x = await fileText(); return /output:\\r?\\n\\s+greeting: "\\{\\{greeting\\}\\}"\\r?\\ntests:/.test(x) ? x : null; }, 6000);
     return 'output saved: ' + !!t;`,
  ),
  step(
    'run-the-flow',
    `if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     const ids = ['http-request', 'condition', 'log', 'http-request-2', 'for-each', 'script', 'log-2', 'sub-flow'];
     const done = await __t.waitFor(() => ids.every((id) => byId(id) && ['passed', 'failed', 'error', 'skipped'].includes(byId(id).dataset.status)) ? true : null, 60000);
     if (!done) return 'NOT ALL STATUSES: ' + nodes().map((n) => n.dataset.flowNode + '=' + n.dataset.status).join(',');
     await __t.sleep(1500);
     return ids.map((id) => id + '=' + byId(id).dataset.status).join(',') + ' | loop: ' + byId('for-each').querySelector('[data-flow-loop]')?.textContent;`,
  ),
  step(
    'yaml-in-the-editor',
    `document.querySelector('main [role=tab][data-tab-id="file:${FILE}"]')?.click(); await __t.sleep(1500);
     const t = editorText();
     return ['type: condition', 'if: status == 200', 'when: true', 'when: false', 'forEach:', 'health?i={{$index}}', 'type: script', 'type: flow', 'file: child-flow.yaml', 'output:'].map((s) => s + ': ' + t.includes(s)).join(' | ');`,
  ),
];

module.exports = withExpect(steps, {
  'open-an-empty-flow': /^url saved: true$/,
  'condition-after-the-request': /^condition: true \| after the request: true \| inspector: status == 200 \| two ports: 2$/,
  'log-on-the-true-branch': /^when true saved: true \| edge label: true$/,
  'request-on-the-false-branch-by-its-port': /^edge label: false \| yaml: true$/,
  'for-each-over-three-rows': /^rows: 3 \| node: × 3 \| mode: list$/,
  'script-sets-a-variable-the-next-step-reads': /^script: true \| log reads it: true \| edge label: \{\{value\}\}$/,
  'sub-flow-with-an-input': /^inputs saved: true \| node: true$/,
  'flow-output': /^output saved: true$/,
  'run-the-flow': /^http-request=passed,condition=passed,log=passed,http-request-2=skipped,for-each=passed,script=passed,log-2=passed,sub-flow=passed \| loop: × 3$/,
  'yaml-in-the-editor':
    /^type: condition: true \| if: status == 200: true \| when: true: true \| when: false: true \| forEach:: true \| health\?i=\{\{\$index\}\}: true \| type: script: true \| type: flow: true \| file: child-flow\.yaml: true \| output:: true$/,
});
