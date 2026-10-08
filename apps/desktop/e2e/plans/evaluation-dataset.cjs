// An evaluation's dataset: records pasted one per line while JSON is selected are read as JSONL; the editor does not
// flag them as broken JSON ("End of file expected"), a note says so and switches the format in one click. JSON that
// is really broken is still marked. A run on a provider without its key says so with "Add the key", which opens
// AI Lab ▸ Providers on that provider with its key field focused.
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
  step(
    'every-format-is-coloured',
    `const ed = ${EDITOR}; const m = ed.getModel();
     const md = window.__monaco.editor.createModel('# x', 'markdown'); await __t.sleep(1200); md.dispose();
     const kinds = (lang) => [...new Set(window.__monaco.editor.tokenize(lang === 'csv' ? 'input,expected\\nCancel,"a, b"' : lang === 'markdown' ? '| input | expected |\\n|---|---|' : m.getValue(), lang).flat().map((t) => t.type))].filter((t) => /json|csv|\.md$|number|keyword/.test(t)).sort().join(' ');
     return 'language: ' + m.getLanguageId() + ' | jsonl: ' + kinds('jsonl') + ' | csv: ' + kinds('csv') + ' | markdown: ' + (kinds('markdown') ? 'coloured' : 'plain');`,
  ),
  step(
    'a-broken-line-is-marked-on-its-own',
    `const m = ${EDITOR}.getModel(); const text = m.getValue();
     m.setValue(text.trimEnd() + '\\n{"input": "Hello"'); await __t.sleep(1200);
     const marks = window.__monaco.editor.getModelMarkers({ resource: m.uri }).filter((x) => x.severity === 8).map((x) => 'line ' + x.startLineNumber);
     m.setValue(text); await __t.sleep(800);
     return 'lines: ' + m.getLineCount() + ' | marked: ' + marks.join(', ') + ' | after the fix: ' + window.__monaco.editor.getModelMarkers({ resource: m.uri }).filter((x) => x.severity === 8).length;`,
  ),
  step(
    'run-without-a-key',
    `const sel = vis('main label').find((l) => l.textContent.trim().startsWith('Provider'))?.parentElement?.querySelector('select') ?? vis('main select').find((x) => [...x.options].some((o) => o.textContent.trim() === 'OpenAI'));
     const opt = [...sel.options].find((o) => o.textContent.trim() === 'OpenAI');
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
     sel.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(400);
     vis('main button').find((b) => { const t = b.textContent.trim(); return t.startsWith('Run ') && /case/.test(t); })?.click();
     const alert = await __t.waitFor(() => vis('main [role=alert]').find((a) => /No API key for OpenAI/.test(a.textContent)), 20000);
     const add = alert && [...alert.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add the key');
     return 'error: ' + (alert ? 'No API key for OpenAI' : 'NONE') + ' | button: ' + (add ? 'Add the key' : 'NONE');`,
  ),
  step(
    'add-the-key-opens-the-provider',
    `const add = vis('main [role=alert] button').find((b) => b.textContent.trim() === 'Add the key'); add?.click();
     await __t.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'API key', 5000).catch(() => undefined);
     const f = document.activeElement;
     return 'view: ' + (vis('main [role=tab][aria-selected=true]').map((t) => t.textContent.trim()).join(',')) + ' | focused: ' + (f?.tagName === 'INPUT' ? f.getAttribute('aria-label') || 'an input without a name' : 'nothing') + ' | provider: ' + (/OpenAI/.test(document.querySelector('main')?.innerText ?? '') ? 'OpenAI' : '?');`,
  ),
];
module.exports = withExpect(steps, {
  'jsonl-records': /^checked: JSONL \| note: none \| editor errors: 0 \| preview: 3$/,
  'json-selected': /^checked: JSON \| note: shown \| editor errors: 0 \| preview: 3$/,
  'broken-json-is-still-marked': /^checked: JSON \| note: none \| editor errors: [1-9]/,
  'switch-to-jsonl': /^checked: JSONL \| note: none \| editor errors: 0 \| preview: 3$/,
  'every-format-is-coloured': /^language: jsonl \| jsonl: .*string\.key\.json.*string\.value\.json.* \| csv: csv\.column0\S* csv\.column1\S* .*\| markdown: coloured$/,
  'a-broken-line-is-marked-on-its-own': /^lines: 3 \| marked: line 4 \| after the fix: 0$/,
  'run-without-a-key': /^error: No API key for OpenAI \| button: Add the key$/,
  'add-the-key-opens-the-provider': /^view: Providers\d* \| focused: API key \| provider: OpenAI$/,
});
