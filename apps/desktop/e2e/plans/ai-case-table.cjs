// AU-10 · Test cases as a table: the default view of an evaluation's cases (one row per case, a column per field, the expected
// answer column marked), typing in a cell writes the cases back as text, "Paste cases…" takes cells copied from a spreadsheet
// (columns found, input and expected guessed and mapped, added to the table), a row is deleted, Enter in the last row adds one,
// and 5,000 cases cost what 50 do (only the visible rows are drawn). "Edit as text" shows the same cases.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const table = () => vis('[data-case-table]')[0];
  const count = () => Number(table()?.getAttribute('data-case-count') ?? -1);
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const seg = (label) => vis('main [role=radiogroup] button, main [role=tablist] button, main button').find((b) => b.textContent.trim() === label);
  const EDITOR = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
`;

const steps = [
  step(
    'table-is-the-default',
    `${H} await __t.view('Evaluations'); await __t.sleep(1200);
     const heads = vis('[data-case-table] [role=columnheader]').map((h) => h.textContent.trim().replace(/\\s+/g, ' ')).join(',');
     return 'cases: ' + count() + ' | columns: ' + heads + ' | rows drawn: ' + vis('[data-case-row]').length;`,
  ),
  step(
    'type-in-a-cell',
    `${H} const cell = vis('[data-case="1"] [data-case-cell=input]')[0];
     setValue(cell, 'Please cancel my visit'); await __t.sleep(400);
     await __t.real.click(seg('Edit as text')); await __t.sleep(1000);
     const text = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)?.getModel().getValue();
     return 'text has the edit: ' + /Please cancel my visit/.test(text) + ' | lines: ' + text.split('\\n').length;`,
  ),
  step(
    'back-to-the-table',
    `${H} await __t.real.click(seg('Table')); await __t.sleep(800);
     return 'cases: ' + count() + ' | first input: ' + vis('[data-case="1"] [data-case-cell=input]')[0]?.value;`,
  ),
  step(
    'paste-cases-from-a-spreadsheet',
    `${H} await __t.real.click(vis('main [data-cases-paste]')[0]);
     const dlg = await __t.waitFor(() => vis('[data-paste-dialog]')[0], 4000); if (!dlg) return 'NO DIALOG';
     setValue(dlg.querySelector('[data-paste-text]'), 'message\\tanswer\\nI want to cancel\\tcancellation\\nWhen are you open?\\tother'); await __t.sleep(500);
     const found = dlg.querySelector('[data-paste-found]')?.textContent.trim();
     const selects = [...dlg.querySelectorAll('select')].map((s) => s.options[s.selectedIndex]?.textContent.trim()).join('/');
     await __t.real.click(vis('[data-paste-add]')[0]); await __t.sleep(800);
     const added = vis('[data-case-cell=input]').map((i) => i.value).filter((v) => /^(I want to cancel|When are you open)/.test(v)).length;
     return 'found: ' + found + ' | mapped: ' + selects + ' | cases: ' + count() + ' | pasted rows seen: ' + added;`,
  ),
  step(
    'delete-and-add-a-row',
    `${H} const before = count();
     await __t.real.click(vis('main button[aria-label="Delete case 1"]')[0]); await __t.sleep(400);
     const afterDelete = count();
     await __t.real.click(vis('[data-case-add]')[0]); await __t.sleep(400);
     return 'before: ' + before + ' | after delete: ' + afterDelete + ' | after add: ' + count();`,
  ),
  step(
    'thousands-of-cases-stay-quick',
    `${H} try { await __t.real.click(seg('Edit as text')); await __t.sleep(600);
     const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
     ed.getModel().setValue(Array.from({ length: 5000 }, (_, i) => JSON.stringify({ input: 'case ' + i, expected: 'x' + i })).join('\\n')); await __t.sleep(800);
     const t0 = performance.now();
     await __t.real.click(seg('Table')); await painted(); await painted();
     const ms = Math.round(performance.now() - t0);
     await __t.sleep(300);
     return 'cases: ' + count() + ' | drawn: ' + (vis('[data-case-row]').length < 80 ? 'few' : vis('[data-case-row]').length) + ' | ms: ' + (ms < 1500 ? 'quick' : ms); } catch (e) { return 'NO STEP: ' + (e && e.message); }`,
  ),
  step(
    'empty-table-says-what-to-do',
    `${H} await __t.real.click(seg('Edit as text')); await __t.sleep(500);
     (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent).getModel().setValue(''); await __t.sleep(500);
     await __t.real.click(seg('Table')); await __t.sleep(600);
     const empty = vis('main').map((m) => m.innerText).join(' ');
     return 'says: ' + /No test cases yet/.test(empty) + ' | buttons: ' + ['Add a case', 'Paste cases…', 'Use the example cases'].filter((l) => vis('main button').some((b) => b.textContent.trim() === l)).join(' | ');`,
  ),
];
module.exports = withExpect(steps, {
  'table-is-the-default': /^cases: 3 \| columns: input,expected \| rows drawn: 3$/,
  'type-in-a-cell': /^text has the edit: true \| lines: 3$/,
  'back-to-the-table': /^cases: 3 \| first input: Please cancel my visit$/,
  'paste-cases-from-a-spreadsheet': /^found: Found 2 cases with 2 columns: message, answer\. \| mapped: message\/answer \| cases: 5 \| pasted rows seen: 2$/,
  'delete-and-add-a-row': /^before: 5 \| after delete: 4 \| after add: 5$/,
  'thousands-of-cases-stay-quick': /^cases: 5000 \| drawn: few \| ms: quick$/,
  'empty-table-says-what-to-do': /^says: true \| buttons: Add a case \| Paste cases… \| Use the example cases$/,
});
