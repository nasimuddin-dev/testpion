// The flow designer's third-release blocks: on a flow that starts a job on the demo server (POST /jobs, which says
// "running" twice and then "done"), a Wait until polling GET /jobs/{{jobId}} every 200 ms, a Set variable (global
// scope), an Assert on the job's response, a Parallel group of two requests (drawn in a frame), and a Finally clean-up
// (drawn in the Finally lane). Run flow: every step passes, the poll shows its tries, and the Editor tab shows the YAML
// the canvas wrote.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const FILE = 'rest/blocks2-flow.yaml';
const START = [
  'name: Blocks 2',
  'tests:',
  '  - id: start',
  '    name: Start a job',
  '    type: http',
  '    method: POST',
  '    url: http://127.0.0.1:4010/jobs',
  '    extract:',
  '      jobId: $.id',
  '    assertions:',
  '      - type: status',
  '        expected: 201',
  '',
].join('\n');
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const pointer = (el, type, at) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
  const editorText = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)?.getValue() ?? 'NO EDITOR';
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const fileText = () => window.aps.invoke('tests.read', { path: ${JSON.stringify(FILE)} });
  const clickBackground = () => { const s = svg(); const r = s.getBoundingClientRect(); const at = { clientX: r.left + 6, clientY: r.top + 6 }; pointer(s, 'pointerdown', at); pointer(s, 'pointerup', at); };
  const selectId = async (id) => { const n = byId(id); if (!n) return null; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return __t.waitFor(() => document.querySelector('[data-step-inspector="' + id + '"]'), 3000); };
  const add = async (label, id) => {
    const b = vis('[data-flow-add]')[0]; if (!b) return 'NO ADD BUTTON'; b.click();
    const item = await __t.waitFor(() => vis('[data-palette="blocks"] [role=option]').find((m) => m.querySelector('[data-command-label]')?.textContent.trim() === label), 2000); if (!item) return 'NO MENU ITEM ' + label;
    item.click();
    if (!(await __t.waitFor(() => byId(id), 6000))) return 'NO NODE ' + id + ': ' + nodes().map((n) => n.dataset.flowNode).join(',');
    return '';
  };
  const setUrl = async (id, url) => {
    if (!(await selectId(id))) return false;
    const u = vis('[data-step-inspector="' + id + '"] input[aria-label="URL"]')[0]; if (!u) return false;
    u.focus(); setInput(u, url); enter(u);
    return !!(await until(async () => (await fileText()).includes(url), 5000));
  };
`;
const step = stepOf(H);

const steps = [
  step(
    'open-the-flow',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: ${JSON.stringify(START)} });
     await __t.view('Tests'); await __t.sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('blocks2-flow.yaml')), 4000);
     if (!r) return 'NO ROW'; r.click(); await __t.sleep(1200);
     await __t.tab('Flow');
     if (!(await __t.waitFor(() => document.querySelector('[data-flow-designer]'), 5000))) return 'NO DESIGNER';
     return 'start node: ' + !!(await __t.waitFor(() => byId('start'), 5000));`,
  ),
  step(
    'wait-until-polls-the-job',
    `if (!(await selectId('start'))) return 'NO INSPECTOR';
     const e = await add('Wait until (poll)', 'wait-until'); if (e) return e;
     if (!(await setUrl('wait-until', 'http://127.0.0.1:4010/jobs/{{jobId}}'))) return 'URL NOT SAVED';
     const every = await __t.waitFor(() => vis('[data-step-inspector="wait-until"] [data-inspector-until] input[aria-label="Every"]')[0], 3000); if (!every) return 'NO EVERY FIELD';
     every.focus(); setInput(every, '200ms'); enter(every);
     const t = await until(async () => { const x = await fileText(); return /every: 200ms/.test(x) ? x : null; }, 5000);
     if (!t) return 'EVERY NOT SAVED';
     return 'until: ' + /until:[\\s\\S]*if: "?\\$\\.status == 'done'/.test(t) + ' | after start: ' + /id: wait-until[\\s\\S]*dependsOn: \\[ ?start ?\\]/.test(t) + ' | node: ' + (byId('wait-until').querySelector('[data-flow-until]')?.getAttribute('data-flow-until') ?? 'NO UNTIL LINE');`,
  ),
  step(
    'set-variable',
    `if (!(await selectId('wait-until'))) return 'NO INSPECTOR';
     const e = await add('Set variable', 'set-variable'); if (e) return e;
     if (!(await selectId('set-variable'))) return 'NO SET INSPECTOR';
     const box = await __t.waitFor(() => vis('[data-step-inspector="set-variable"] [data-inspector-set]')[0], 3000); if (!box) return 'NO SET FIELDS';
     const value = box.querySelector('input[aria-label="Value of value"]'); if (!value) return 'NO VALUE FIELD';
     setInput(value, '{{jobId}}');
     if (!(await until(async () => /set:\\r?\\n\\s+value: "\\{\\{jobId\\}\\}"/.test(await fileText()), 6000))) return 'VALUE NOT SAVED';
     const scope = vis('[data-step-inspector="set-variable"] select[aria-label="Scope"]')[0]; if (!scope) return 'NO SCOPE';
     setInput(scope, 'global');
     const t = await until(async () => { const x = await fileText(); return /scope: global/.test(x) ? x : null; }, 5000);
     return 'scope saved: ' + !!t + ' | node: ' + !!(await until(() => byId('set-variable')?.textContent.includes('set value → global'), 4000));`,
  ),
  step(
    'assert-on-the-response',
    `if (!(await selectId('wait-until'))) return 'NO INSPECTOR';
     const e = await add('Assert', 'assert'); if (e) return e;
     if (!(await selectId('assert'))) return 'NO ASSERT INSPECTOR';
     const subject = vis('[data-step-inspector="assert"] select[aria-label="Subject"]')[0];
     const checks = vis('[data-step-inspector="assert"] [data-inspector-assertions]')[0];
     const t = await fileText();
     return 'subject: ' + (subject ? subject.value : 'NO SUBJECT') + ' | checks editor: ' + !!checks + ' | yaml: ' + /type: assert[\\s\\S]*dependsOn: \\[ ?wait-until ?\\]/.test(t) + ' | node: ' + byId('assert').textContent.includes('1 check on the response');`,
  ),
  step(
    'parallel-group-of-two-requests',
    `if (!(await selectId('wait-until'))) return 'NO INSPECTOR';
     const e = await add('Parallel group', 'request-1'); if (e) return e;
     if (!(await __t.waitFor(() => byId('request-2'), 5000))) return 'NO SECOND REQUEST';
     if (!(await setUrl('request-1', 'http://127.0.0.1:4010/health?p=1'))) return 'URL 1 NOT SAVED';
     if (!(await setUrl('request-2', 'http://127.0.0.1:4010/health?p=2'))) return 'URL 2 NOT SAVED';
     const frame = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-group="parallel:group-1"]'), 4000);
     const t = await fileText();
     return 'yaml: ' + ((t.match(/parallel: group-1/g) ?? []).length) + ' | frame: ' + (frame ? frame.textContent.includes('parallel · group-1') : 'NO FRAME');`,
  ),
  step(
    'finally-clean-up',
    `clickBackground(); await __t.sleep(300);
     const e = await add('Finally (clean-up)', 'clean-up'); if (e) return e;
     if (!(await setUrl('clean-up', 'http://127.0.0.1:4010/health?cleanup=1'))) return 'URL NOT SAVED';
     const frame = await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-group="finally:finally"]'), 4000);
     const toggle = vis('[data-step-inspector="clean-up"] [data-inspector-finally] [role=switch]')[0];
     const t = await fileText();
     return 'yaml: ' + /id: clean-up[\\s\\S]*finally: true/.test(t) + ' | lane: ' + !!frame + ' | toggle: ' + (toggle ? toggle.getAttribute('aria-checked') : 'NO TOGGLE');`,
  ),
  step(
    'run-the-flow',
    `if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     const ids = ['start', 'wait-until', 'set-variable', 'assert', 'request-1', 'request-2', 'clean-up'];
     const done = await __t.waitFor(() => ids.every((id) => byId(id) && ['passed', 'failed', 'error', 'skipped'].includes(byId(id).dataset.status)) ? true : null, 60000);
     if (!done) return 'NOT ALL STATUSES: ' + nodes().map((n) => n.dataset.flowNode + '=' + n.dataset.status).join(',');
     await __t.sleep(1500);
     return ids.map((id) => id + '=' + byId(id).dataset.status).join(',') + ' | poll: ' + (byId('wait-until').querySelector('[data-flow-until]')?.getAttribute('data-flow-until') ?? 'NO UNTIL LINE');`,
  ),
  step(
    'yaml-in-the-editor',
    `document.querySelector('main [role=tab][data-tab-id="file:${FILE}"]')?.click(); await __t.sleep(1500);
     const t = editorText();
     return ['until:', 'every: 200ms', 'type: set', 'scope: global', 'type: assert', 'parallel: group-1', 'finally: true'].map((s) => s + ': ' + t.includes(s)).join(' | ');`,
  ),
];

module.exports = withExpect(steps, {
  'open-the-flow': /^start node: true$/,
  'wait-until-polls-the-job': /^until: true \| after start: true \| node: until \$\.status == 'done'$/,
  'set-variable': /^scope saved: true \| node: true$/,
  'assert-on-the-response': /^subject: response \| checks editor: true \| yaml: true \| node: true$/,
  'parallel-group-of-two-requests': /^yaml: 2 \| frame: true$/,
  'finally-clean-up': /^yaml: true \| lane: true \| toggle: true$/,
  'run-the-flow': /^start=passed,wait-until=passed,set-variable=passed,assert=passed,request-1=passed,request-2=passed,clean-up=passed \| poll: until \$\.status == 'done' · 3 tries$/,
  'yaml-in-the-editor': /^until:: true \| every: 200ms: true \| type: set: true \| scope: global: true \| type: assert: true \| parallel: group-1: true \| finally: true: true$/,
});
