// Rename saved examples in place; F2 on a test file opens its path dialog.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
/** Two saved examples on "Custom headers" (the examples workspace has none). */
const addExamples = (ws) => {
  const p = join(ws, 'collections', 'httpbin.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const walk = (n) => n.forEach((x) => (x.kind === 'folder' ? walk(x.items) : x.name === 'Custom headers' && (x.examples = [{ id: 'ex-1', name: 'OK response', status: 200, headers: [], body: '{"ok":true}' }, { id: 'ex-2', name: 'Server error', status: 500, headers: [], body: '{}' }])));
  walk(c.items);
  writeFileSync(p, JSON.stringify(c, null, 2));
};
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.offsetParent);
`;
const step = stepOf(H);
const steps = [
  // F2 on a test file renames it in place (its name, in its folder); the tab's Rename takes a path in a dialog
  step('tests-f2-in-place', `await __t.view('Tests'); await __t.sleep(800); const r = vis('[data-tree-row]').find((b) => b.textContent.trim().endsWith('httpbin.yaml')); r.focus(); key(r, 'F2'); await __t.sleep(700); const i = document.activeElement; const field = i?.tagName === 'INPUT' && i.getAttribute('aria-label') === 'File name'; const v = i?.value; const dialog = !!document.querySelector('[role=dialog]'); key(i, 'Escape'); await __t.sleep(500); return 'in place: ' + field + ' value=' + v + ' | dialog: ' + dialog + ' | still there: ' + vis('[data-tree-row]').some((b) => b.textContent.trim().endsWith('httpbin.yaml'));`),
  step('open-examples', `await __t.requests(); await __t.sleep(500); for (const t of ['HTTP basics', 'REST17', 'Requests & responses10']) { await __t.expand(t); await __t.sleep(250); } const r = vis('aside button[data-tree-row]').find((b) => b.textContent.includes('Custom headers')); r.click(); await __t.sleep(1500); await __t.tab('Examples'); await __t.sleep(700); return vis('[role=listbox][aria-label="Examples"] [role=option]').map((o) => o.textContent.trim()).join(' | ');`),
  step('pencil-rename', `vis('button[aria-label="Rename example (F2)"]')[0].click(); await __t.sleep(500); const i = document.activeElement; if (i?.getAttribute('aria-label') !== 'Example name') return 'NO INPUT: ' + i?.tagName; setVal(i, 'OK (renamed)'); key(i, 'Enter'); await __t.sleep(1000); return vis('[role=listbox][aria-label="Examples"] [role=option]').map((o) => o.textContent.trim()).join(' | ');`),
  step('f2-in-list', `const o = vis('[role=listbox][aria-label="Examples"] [role=option]').find((x) => x.textContent.includes('Server error')); o.focus(); key(o, 'F2'); await __t.sleep(500); const i = document.activeElement; if (i?.getAttribute('aria-label') !== 'Example name') return 'NO INPUT'; setVal(i, 'Error 500'); key(i, 'Enter'); await __t.sleep(1000); return vis('[role=listbox][aria-label="Examples"] [role=option]').map((x) => x.textContent.trim()).join(' | ') + ' | focus: ' + document.activeElement?.textContent?.trim();`),
];

module.exports = withExpect(steps, {
  'tests-f2-in-place': /^in place: true value=httpbin\.yaml \| dialog: false \| still there: true$/,
  'open-examples': /OK response \| 500Server error/,
  'pencil-rename': /OK \(renamed\)/,
  'f2-in-list': /500Error 500.*focus: 500Error 500/,
}, { prepare: addExamples });
