// AU-16 · Compare mode: the sample evaluation and a variant on another model run on the same cases. Compare (beside Run) opens
// "Compare two versions"; Add a variant (a name, another model) puts the chips A: Current and B: ... in the bar; Run shows the total
// cost first and runs both; the table says Passed / Cost / Average time per variant with the winner of each row and one sentence
// ("B passes 7 cases fewer ..."), and the matrix below lists every case with its result in each variant. Model comparison (AI Lab)
// opens the same Compare with its prompt and input as the first case and one variant per model.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

/** A second offline model that answers every message with "other": it gets the three "other" cases right and nothing else. */
function prepare(ws) {
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  c.providers.push({
    id: 'demo-b',
    name: 'Demo B',
    kind: 'mock',
    baseUrl: 'mock://',
    defaultModel: 'demo-b',
    headers: [{ key: 'x-mock-rules', value: JSON.stringify([{ match: '.', response: '{"intent":"other"}' }]) }],
  });
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const panel = () => vis('[data-variants-panel]')[0];
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'open-compare-on-the-sample',
    `await window.aps.invoke('ai.sample', { run: false });
     await __t.view('Home'); await __t.view('Evaluations'); await __t.sleep(1000);
     const row = await __t.waitFor(() => vis('aside *, [data-sidebar] *, main *').find((e) => e.children.length === 0 && e.textContent.trim() === 'Sample: support intents'), 6000);
     if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(1000);
     await __t.real.click(vis('[data-eval-compare-open]')[0]); await __t.sleep(600);
     return 'empty state: ' + /Compare two versions/.test(vis('main')[0]?.innerText ?? '') + ' | compare switch: ' + vis('[role=radio]').some((b) => b.textContent.trim() === 'Compare');`,
  ),
  step(
    'add-a-variant',
    `const add = vis('main button').find((b) => b.textContent.trim() === 'Add a variant'); if (!add) return 'NO ADD BUTTON';
     await __t.real.click(add);
     const dlg = await __t.waitFor(() => vis('[data-variant-dialog]')[0], 4000); if (!dlg) return 'NO DIALOG';
     const save = vis('[data-variant-save]')[0];
     const blocked = save.disabled + ': ' + (save.getAttribute('title') ?? 'NO REASON');
     setValue(dlg.querySelector('[data-variant-name]'), 'Other model');
     const sel = dlg.querySelector('select[aria-label="Variant provider"]');
     setSelect(sel, 'demo-b'); await __t.sleep(300);
     await __t.real.click(vis('[data-variant-save]')[0]); await __t.sleep(800);
     return 'save blocked first: ' + blocked + ' | chips: ' + vis('[data-variant-chip]').map((c) => c.textContent.trim().replace(/\\s+/g, ' ')).join(' ; ');`,
  ),
  step(
    'run-shows-the-cost-first',
    `const b = await __t.waitFor(() => vis('[data-variants-run]').find((x) => /variants on 10 cases/.test(x.textContent)), 10000); if (!b) return 'NO RUN BUTTON: ' + short(vis('[data-variants-run]')[0]?.textContent);
     return 'button: ' + short(b.textContent);`,
  ),
  step(
    'run-and-read-the-table',
    `await __t.real.click(vis('[data-variants-run]')[0]);
     const s = await __t.waitFor(() => vis('[data-variants-summary]')[0], 60000); if (!s) return 'NO SUMMARY: ' + short(vis('[data-variants-waiting]')[0]?.textContent);
     const rows = [...s.querySelectorAll('[data-variants-row]')].map((r) => r.getAttribute('data-variants-row') + '=' + short([...r.querySelectorAll('td')].map((t) => t.textContent.trim()).join(' | '), 80));
     return 'rows: ' + rows.join(' ;; ') + ' | conclusion: ' + short(s.querySelector('[data-variants-conclusion]')?.textContent, 200);`,
  ),
  step(
    'the-matrix-lists-the-cases',
    `const m = await __t.waitFor(() => vis('[data-eval-matrix]')[0], 15000); if (!m) return 'NO MATRIX';
     await __t.sleep(1200);
     return 'columns: ' + vis('[data-matrix-column]').length + ' | cases: ' + m.getAttribute('data-cases') + ' | baseline set: ' + (m.getAttribute('data-baseline') !== '') + ' | regressed chip: ' + short(vis('[data-eval-matrix] [role=radio]').find((b) => b.textContent.trim().startsWith('Regressed'))?.textContent);`,
  ),
  step(
    'model-comparison-opens-it',
    `await __t.view('AI Lab'); await __t.sleep(600);
     const t = vis('main [role=tab]').find((x) => x.textContent.trim() === 'Model comparison'); if (!t) return 'NO TAB';
     await __t.real.click(t); await __t.sleep(800);
     const b = vis('[data-compare-many]')[0]; if (!b) return 'NO BUTTON';
     await __t.real.click(b);
     const p = await __t.waitFor(() => panel(), 8000); if (!p) return 'NO COMPARE: ' + short(vis('main')[0]?.innerText, 100);
     const name = vis('main input[aria-label="Evaluation name"]')[0]?.value;
     return 'view: ' + (document.querySelector('nav[aria-label="Main navigation"] [aria-current=page]')?.getAttribute('aria-label')) + ' | name: ' + name + ' | chips: ' + vis('[data-variant-chip]').length;`,
  ),
];
module.exports = withExpect(
  steps,
  {
    'open-compare-on-the-sample': /^empty state: true \| compare switch: true$/,
    'add-a-variant': /^save blocked first: true: Give the variant a name \| chips: A: Current ; B: Other model/,
    'run-shows-the-cost-first': /^button: Run 2 variants on 10 cases · free · /,
    'run-and-read-the-table': /^rows: passed=Passed \| 10 of 10 \| 3 of 10 \| A \(\+7\) ;; cost=.*free \| free \| free ;; time=.* \| conclusion: .*B .*passes 7 cases fewer.*7 cases got worse and 0 got better: look at them\.$/,
    'the-matrix-lists-the-cases': /^columns: 2 \| cases: 10 \| baseline set: true \| regressed chip: Regressed 7$/,
    'model-comparison-opens-it': /^view: Evaluations \| name: Model comparison \| chips: [2-9]$/,
  },
  { prepare },
);
