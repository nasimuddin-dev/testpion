// Custom RAG metrics, with real mouse and keys (__t.real): AI Lab ▸ RAG ▸ Metrics lists the workspace's metric files; New opens
// the editor (id, kind, the YAML with a live check), the examples run as the metric's tests and say whether they agree, Save writes
// metrics/<id>.yaml, and the metric is in the picker of a RAG evaluation like any other. The matrix views of a run (By tag, Charts,
// Compare, Runs × metrics, the export arrow) and "Score again…" are in the rag-evaluation plans. Offline: a rule metric needs no model.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const EDITOR_IN = (sel) => `(window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.closest(${JSON.stringify(sel)}))`;
const setSelect = (el, text) => `{ const sel = ${el}; const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(${JSON.stringify(text)})); if (!opt) return 'NO OPTION ${text}'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); }`;

const FILE = [
  'id: no-guarantee',
  'version: 1',
  'name: No guarantee',
  'description: The answer promises nothing',
  'kind: rule',
  'rules:',
  '  - { type: not-contains, expected: guarantee }',
  'combine: all',
  'threshold: 1',
  'examples:',
  '  - { name: plain, sample: { answer: "We open at 8am." }, expect: pass }',
  '  - { name: promise, sample: { answer: "We guarantee a cure." }, expect: fail }',
  '',
].join('\n');

const steps = [
  step(
    'the-metrics-side-lists-nothing-yet',
    `await __t.view('AI Lab'); await __t.sleep(600);
     const t = vis('main [role=tab]').find((x) => x.textContent.trim().startsWith('RAG')); if (!t) return 'NO TAB RAG';
     await __t.real.click(t); await __t.sleep(600);
     const m = vis('main button, main [role=radio]').find((b) => b.textContent.trim() === 'Metrics'); if (!m) return 'NO SWITCH Metrics';
     await __t.real.click(m);
     const list = await __t.waitFor(() => document.querySelector('[data-rag-metrics-list]'), 5000); if (!list) return 'NO LIST';
     return 'rows: ' + list.querySelectorAll('[data-rag-metric-row]').length + ' | new button: ' + !!document.querySelector('[data-rag-metric-new]');`,
  ),
  step(
    'new-metric-with-a-live-check',
    `await __t.real.click('[data-rag-metric-new]');
     const ed = await __t.waitFor(() => document.querySelector('[data-rag-metric-editor]'), 5000); if (!ed) return 'NO EDITOR';
     await __t.real.click('[data-rag-metric-id]'); await __t.real.type('no-guarantee');
     ${setSelect(`document.querySelector('[data-rag-metric-kind]')`, 'Rules')}
     const loaded = await __t.waitFor(() => ${EDITOR_IN('[data-rag-metric-yaml]')}?.getModel().getValue().includes('kind: rule'), 8000); if (!loaded) return 'NO TEMPLATE';
     ${EDITOR_IN('[data-rag-metric-yaml]')}.getModel().setValue(${JSON.stringify(FILE)}); await __t.sleep(900);
     return 'problems: ' + (document.querySelector('[data-rag-metric-problems]')?.querySelectorAll('li').length ?? 0) + ' | save enabled: ' + !document.querySelector('[data-rag-metric-save]').disabled;`,
  ),
  // unsaved edits are never dropped silently: Discard (and Esc and the X) ask first; Keep editing goes back
  step(
    'closing-an-edited-metric-asks-first',
    `const discard = vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Discard'); if (!discard) return 'NO BUTTON Discard';
     await __t.real.click(discard);
     const ask = await __t.waitFor(() => vis('[role=alertdialog], [role=dialog]').find((d) => /Discard your changes/.test(d.textContent)), 4000); if (!ask) return 'NO CONFIRM';
     const keep = [...ask.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Keep editing'); if (!keep) return 'NO BUTTON Keep editing';
     await __t.real.click(keep);
     await __t.sleep(400);
     return 'asked: true | editor still open: ' + !!document.querySelector('[data-rag-metric-editor]') + ' | cost line: ' + document.querySelector('[data-rag-metric-cost]')?.textContent.trim();`,
  ),
  step(
    'the-examples-agree',
    `await __t.real.click('[data-rag-metric-examples]');
     const a = await __t.waitFor(() => document.querySelector('[data-rag-metric-agree]'), 15000); if (!a) return 'NO RESULT';
     return 'agree: ' + a.textContent.trim() + ' | rows: ' + document.querySelectorAll('[data-rag-metric-example-results] tbody tr').length;`,
  ),
  step(
    'save-writes-the-file',
    `await __t.real.click('[data-rag-metric-save]'); await __t.sleep(800);
     const row = await __t.waitFor(() => document.querySelector('[data-rag-metric-row="no-guarantee"]'), 8000);
     return 'listed: ' + !!row + ' | delete offered: ' + !!document.querySelector('[data-rag-metric-delete]') + ' | save disabled: ' + document.querySelector('[data-rag-metric-save]').disabled;`,
  ),
  step(
    'the-metric-is-in-the-picker',
    `await __t.real.key('Escape'); await __t.sleep(400);
     await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'RAG')}
     await __t.sleep(500);
     const t = tab('Metrics'); if (!t) return 'NO TAB Metrics';
     await __t.real.click(t);
     const s = await __t.waitFor(() => document.querySelector('[data-rag-picker-search]'), 8000); if (!s) return 'NO PICKER';
     await __t.real.click(s); await __t.real.type('no-guarantee'); await __t.sleep(600);
     const shown = vis('[data-rag-metric]').map((r) => r.getAttribute('data-rag-metric'));
     return 'shown: ' + shown.join(',');`,
  ),
  // the picker's Edit link of a custom row opens the metric's editor, and Save as makes a copy under another id
  step(
    'the-pickers-edit-link-opens-the-editor',
    `const link = await __t.waitFor(() => document.querySelector('[data-rag-edit-metric="custom/no-guarantee"]'), 5000); if (!link) return 'NO EDIT LINK';
     await __t.real.click(link);
     const ed = await __t.waitFor(() => document.querySelector('[data-rag-metric-editor]'), 8000); if (!ed) return 'NO EDITOR';
     await __t.sleep(600);
     return 'editor open | delete offered: ' + !!document.querySelector('[data-rag-metric-delete]') + ' | save as offered: ' + !!document.querySelector('[data-rag-metric-saveas]');`,
  ),
  step(
    'save-as-makes-a-copy',
    `await __t.real.click('[data-rag-metric-saveas]');
     const box = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] input')].find((i) => i.value === 'no-guarantee-copy'), 5000); if (!box) return 'NO PROMPT';
     await __t.real.click(box); await __t.real.key('a', { ctrl: true }); await __t.real.type('no-guarantee-v2'); await __t.sleep(200);
     const ok = [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === 'Save a copy'); if (!ok) return 'NO BUTTON';
     await __t.real.click(ok); await __t.sleep(1200);
     const l = await window.aps.invoke('rag.customMetrics');
     return 'metrics: ' + l.metrics.map((m) => m.id).sort().join(',');`,
  ),
  // the dag kind: a Decision tree panel above the YAML; every change is written back into the file
  step(
    'a-decision-tree-metric-has-a-tree-editor',
    `await __t.view('AI Lab'); await __t.sleep(600);
     const rag = vis('main [role=tab]').find((x) => x.textContent.trim().startsWith('RAG')); if (!rag) return 'NO TAB RAG';
     await __t.real.click(rag); await __t.sleep(600);
     const sw = vis('main button, main [role=radio]').find((b) => b.textContent.trim() === 'Metrics'); if (!sw) return 'NO SWITCH Metrics';
     await __t.real.click(sw);
     await __t.waitFor(() => document.querySelector('[data-rag-metric-new]'), 5000);
     await __t.real.click('[data-rag-metric-new]');
     const ed = await __t.waitFor(() => document.querySelector('[data-rag-metric-editor]'), 5000); if (!ed) return 'NO EDITOR';
     await __t.real.click('[data-rag-metric-id]'); await __t.real.type('tone-tree');
     ${setSelect(`document.querySelector('[data-rag-metric-kind]')`, 'Decision tree')}
     const loaded = await __t.waitFor(() => ${EDITOR_IN('[data-rag-metric-yaml]')}?.getModel().getValue().includes('kind: dag'), 8000); if (!loaded) return 'NO TEMPLATE';
     const tree = await __t.waitFor(() => document.querySelector('[data-dag-editor]'), 5000); if (!tree) return 'NO TREE EDITOR';
     await __t.sleep(400);
     return 'nodes: ' + tree.querySelectorAll('[data-dag-node]').length + ' | first: ' + (tree.querySelector('[data-dag-root]')?.value) + ' | add buttons: ' + tree.querySelectorAll('[data-dag-add]').length + ' | cost line: ' + document.querySelector('[data-rag-metric-cost]')?.textContent.trim().replace(/\\d+ judge calls?/, 'N judge calls');`,
  ),
  step(
    'adding-a-rule-writes-it-into-the-yaml',
    `await __t.real.click('[data-dag-add="rule"]');
     const third = await __t.waitFor(() => document.querySelectorAll('[data-dag-node]').length === 3, 5000); if (!third) return 'NO THIRD NODE';
     await __t.sleep(500);
     const yaml = ${EDITOR_IN('[data-rag-metric-yaml]')}.getModel().getValue();
     return 'nodes: 3 | yaml has the rule: ' + /type: rule/.test(yaml) + ' | still kind dag: ' + /kind: dag/.test(yaml) + ' | not reached badge: ' + /not reached/.test(document.querySelector('[data-dag-node="n3"]')?.textContent ?? '');`,
  ),
  step(
    'a-branch-can-lead-to-the-new-node',
    `const sel = document.querySelector('[data-dag-node="answers"] select[aria-label="Where no leads"]'); if (!sel) return 'NO BRANCH SELECT';
     ${setSelect(`document.querySelector('[data-dag-node="answers"] select[aria-label="Where no leads"]')`, 'asks n3')}
     await __t.sleep(600);
     const yaml = ${EDITOR_IN('[data-rag-metric-yaml]')}.getModel().getValue();
     const reached = !/not reached/.test(document.querySelector('[data-dag-node="n3"]')?.textContent ?? '');
     return 'yaml has no: n3: ' + /no: n3/.test(yaml) + ' | n3 reached: ' + reached;`,
  ),
  step(
    'the-engine-checks-the-tree-and-save-lists-it',
    `await __t.sleep(700);
     const errors = [...(document.querySelector('[data-rag-metric-problems]')?.querySelectorAll('li') ?? [])].filter((li) => /^Error/.test(li.textContent)).length;
     if (!document.querySelector('[data-rag-metric-save]').disabled) { await __t.real.click('[data-rag-metric-save]'); await __t.sleep(900); }
     const row = await __t.waitFor(() => document.querySelector('[data-rag-metric-row="tone-tree"]'), 8000);
     return 'errors: ' + errors + ' | listed: ' + !!row + ' | kind badge: ' + /Decision tree/.test(row?.textContent ?? '');`,
  ),
];

module.exports = withExpect(steps, {
  'the-metrics-side-lists-nothing-yet': /^rows: 0 \| new button: true$/,
  'new-metric-with-a-live-check': /^problems: 0 \| save enabled: true$/,
  'closing-an-edited-metric-asks-first': /^asked: true \| editor still open: true \| cost line: Runs on this computer: free$/,
  'the-examples-agree': /^agree: agrees with 2\/2 examples \| rows: 2$/,
  'save-writes-the-file': /^listed: true \| delete offered: true \| save disabled: true$/,
  'the-metric-is-in-the-picker': /^shown: custom\/no-guarantee(,no-guarantee)?$/,
  'the-pickers-edit-link-opens-the-editor': /^editor open \| delete offered: true \| save as offered: true$/,
  'save-as-makes-a-copy': /^metrics: no-guarantee,no-guarantee-v2$/,
  'a-decision-tree-metric-has-a-tree-editor': /^nodes: 2 \| first: answers \| add buttons: 4 \| cost line: About N judge calls? or more: spends tokens$/,
  'adding-a-rule-writes-it-into-the-yaml': /^nodes: 3 \| yaml has the rule: true \| still kind dag: true \| not reached badge: true$/,
  'a-branch-can-lead-to-the-new-node': /^yaml has no: n3: true \| n3 reached: true$/,
  'the-engine-checks-the-tree-and-save-lists-it': /^errors: 0 \| listed: true \| kind badge: true$/,
});
