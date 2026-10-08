// An evaluation's dataset: records pasted one per line while JSON is selected are read as JSONL; the editor does not
// flag them as broken JSON ("End of file expected"), a note says so and switches the format in one click. JSON that
// is really broken is still marked.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const radio = (name) => `vis('main label').find((l) => l.textContent.trim() === '${name}')?.querySelector('input[type=radio]')`;
const EDITOR = `(window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)`;
const state = `(() => { const ed = ${EDITOR}; const m = ed?.getModel();
  return 'checked: ' + vis('main label').filter((l) => l.querySelector('input[type=radio]')?.checked).map((l) => l.textContent.trim()).join(',')
    + ' | note: ' + (vis('main [data-format-mismatch]').length ? 'shown' : 'none')
    + ' | editor errors: ' + (m ? window.__monaco.editor.getModelMarkers({ resource: m.uri }).filter((x) => x.severity === 8).length : 'NO EDITOR')
    + ' | preview: ' + (/Preview\\D*(\\d+) record/.exec(document.querySelector('main')?.innerText ?? '')?.[1] ?? '?'); })()`;

const steps = [
  step('jsonl-records', `await __t.view('Evaluations'); await __t.sleep(1200); return ${state};`),
  step('json-selected', `${radio('JSON')}?.click(); await __t.sleep(2000); return ${state};`),
  step(
    'broken-json-is-still-marked',
    `const m = ${EDITOR}.getModel(); const text = m.getValue();
     m.setValue('[{"input": "Cancel my appointment"'); await __t.sleep(2000);
     const r = ${state};
     m.setValue(text); await __t.sleep(1500);
     return r;`,
  ),
  step('switch-to-jsonl', `vis('main [data-format-mismatch] button')[0]?.click(); await __t.sleep(800); return ${state};`),
];
module.exports = withExpect(steps, {
  'jsonl-records': /^checked: JSONL \| note: none \| editor errors: 0 \| preview: 3$/,
  'json-selected': /^checked: JSON \| note: shown \| editor errors: 0 \| preview: 3$/,
  'broken-json-is-still-marked': /^checked: JSON \| note: none \| editor errors: [1-9]/,
  'switch-to-jsonl': /^checked: JSONL \| note: none \| editor errors: 0 \| preview: 3$/,
});
