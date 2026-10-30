// A RAG test set from documents, with real mouse and keys (__t.real): AI Lab ▸ RAG ▸ Data offers "Generate a test set from
// documents…", the dialog lists the workspace's documents, shows the estimate (model and judge calls, cost) and "What will be
// sent" with the passages before anything is sent, Generate (a scripted offline model writes the questions and checks the
// references) opens the one proposal review with a row per question and its checks (an unanswerable question that the documents
// answer is unticked), "Add to dataset" writes the ticked rows to datasets/handbook.jsonl, and the Data list shows the file.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step, setSelect } = require('../lib.cjs');


const DOC = [
  'Happy Paws is a veterinary clinic. The clinic opens at 8am on weekdays and closes at 6pm. On Saturdays it opens at 9am and closes at noon.',
  'Puppies receive their first vaccine at 8 weeks. The booster follows at 12 weeks and costs 45 dollars.',
].join('\n\n');

// the slots alternate single-hop, unanswerable: the second "unanswerable" question is one the document answers
const SAMPLES = {
  samples: [
    { slot: 1, type: 'single-hop', question: 'When does Happy Paws open on weekdays?', reference: 'It opens at 8am on weekdays and closes at 6pm.', chunks: [], answerable: true },
    { slot: 2, type: 'unanswerable', question: 'Which surgeon performs hip replacements for horses?', reference: '', chunks: [], answerable: false },
    { slot: 3, type: 'single-hop', question: 'How much does the puppy booster cost at the clinic?', reference: 'The booster costs 45 dollars and follows at 12 weeks.', chunks: [], answerable: true },
    { slot: 4, type: 'unanswerable', question: 'When does the clinic open on Saturdays and close?', reference: '', chunks: [], answerable: false },
  ],
};
const VERDICT = { reasoning: 'checked', items: [{ text: 'claim', verdict: true, reason: '[docs-handbook#1] "opens at 8am"' }] };

function prepare(ws) {
  mkdirSync(join(ws, 'docs'), { recursive: true });
  writeFileSync(join(ws, 'docs', 'handbook.md'), DOC);
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([{ match: 'REFERENCE SUPPORT', response: JSON.stringify(VERDICT) }, { match: '"slots"', response: JSON.stringify(SAMPLES) }, ...JSON.parse(rules.value)]);
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const steps = [
  step(
    'the-data-tab-offers-generation',
    `await __t.view('Bots with sources'); await __t.sleep(600);
     const t = vis('[role=tablist][aria-label="Bots with sources"] [role=tab]').find((x) => x.textContent.trim() === 'Bots'); if (!t) return 'NO TAB Bots';
     await __t.real.click(t); await __t.sleep(600);
     const d = vis('[role=tablist][aria-label="Bots with sources"] [role=tab]').find((x) => x.textContent.trim() === 'Questions'); if (!d) return 'NO TAB Questions';
     await __t.real.click(d);
     const list = await __t.waitFor(() => document.querySelector('[data-rag-datasets-list]'), 5000); if (!list) return 'NO LIST';
     const act = await __t.waitFor(() => document.querySelector('[data-rag-data-actions] [data-ai-action]'), 5000);
     return 'datasets: ' + list.querySelectorAll('[data-rag-dataset-row]').length + ' | generate: ' + !!act + ' | capture: ' + !!document.querySelector('[data-rag-capture-open]');`,
  ),
  step(
    'the-dialog-estimates-before-anything-is-sent',
    `await __t.real.click(document.querySelector('[data-rag-data-actions] [data-ai-action]'));
     const dlg = await __t.waitFor(() => document.querySelector('[data-rag-testset-dialog]'), 5000); if (!dlg) return 'NO DIALOG';
     const box = await __t.waitFor(() => dlg.querySelector('input[aria-label="docs/handbook.md"]'), 5000); if (!box) return 'NO FILE docs/handbook.md';
     await __t.real.click(box);
     const count = dlg.querySelector('[data-rag-testset-count]'); count.focus(); count.select(); await __t.real.type('4');
     await __t.real.click(dlg.querySelector('[data-rag-testset-name]')); await __t.real.type('handbook');
     for (const id of ['multi-hop', 'abstract', 'adversarial']) { const c = dlg.querySelector('input[aria-label="' + id + '"]'); if (c?.checked) await __t.real.click(c); }
     const est = await __t.waitFor(() => /write-questions/.test(dlg.querySelector('[data-rag-testset-estimate]')?.textContent ?? '') && dlg.querySelector('[data-rag-testset-estimate]'), 15000); if (!est) return 'NO ESTIMATE';
     return 'estimate: ' + /reference-support/.test(est.textContent) + ' | passages: ' + /1 document, 1 passages/.test(est.textContent) + ' | file written: ' + (await window.aps.invoke('rag.testset.sources')).datasets.some((d) => d.name === 'handbook.jsonl');`,
  ),
  step(
    'voices-and-the-meaning-check-are-in-the-dialog',
    `const dlg = document.querySelector('[data-rag-testset-dialog]');
     const personas = dlg.querySelector('[data-rag-testset-personas]'); const styles = dlg.querySelectorAll('[data-rag-testset-styles] input[type=checkbox]');
     const sel = dlg.querySelector('[data-rag-testset-dedupe]'); if (!personas || !sel) return 'NO FIELDS';
     const before = !!dlg.querySelector('[data-rag-testset-embedder]');
     ${setSelect(`dlg.querySelector('[data-rag-testset-dedupe]')`, 'By their words and meaning')}
     const embedder = await __t.waitFor(() => dlg.querySelector('[data-rag-testset-embedder]'), 3000);
     const est = await __t.waitFor(() => /dedupe-embedding/.test(dlg.querySelector('[data-rag-testset-estimate]')?.textContent ?? '') && dlg.querySelector('[data-rag-testset-estimate]'), 15000);
     ${setSelect(`dlg.querySelector('[data-rag-testset-dedupe]')`, 'By their words')}
     await __t.sleep(400);
     return 'personas: true | styles: ' + styles.length + ' | embedder before: ' + before + ' | embedder shown: ' + !!embedder + ' | estimate line: ' + !!est + ' | embedder hidden again: ' + !dlg.querySelector('[data-rag-testset-embedder]');`,
  ),
  step(
    'what-will-be-sent-shows-the-passages',
    `const dlg = document.querySelector('[data-rag-testset-dialog]').closest('[role=dialog]');
     const b = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('What will be sent')); if (!b) return 'NO BUTTON';
     await __t.real.click(b);
     const text = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].map((d) => d.textContent).find((t) => /opens at 8am/.test(t) && /tokens/.test(t)), 8000); if (!text) return 'NO PREVIEW';
     await __t.real.key('Escape'); await __t.sleep(300);
     return 'passage shown: true | dialog still open: ' + !!document.querySelector('[data-rag-testset-dialog]');`,
  ),
  step(
    'generate-opens-the-review-with-checks',
    `await __t.real.click(document.querySelector('[data-rag-testset-generate]'));
     const rev = await __t.waitFor(() => document.querySelectorAll('[data-proposal-item]').length >= 4 && document.querySelector('[data-proposal]'), 30000); if (!rev) return 'NO REVIEW';
     await __t.sleep(300);
     const items = [...document.querySelectorAll('[data-proposal-item]')];
     const rows = items.map((i) => (i.querySelector('input[type=checkbox]')?.checked ? 'x' : '-'));
     const failing = [...document.querySelectorAll('[data-verification="fail"]')].map((b) => b.getAttribute('data-verifier')).join(',');
     return 'rows: ' + items.length + ' | ticked: ' + rows.join('') + ' | failing: ' + failing + ' | first: ' + items[0].textContent.includes('When does Happy Paws open');`,
  ),
  step(
    'add-to-dataset-writes-the-ticked-rows',
    `const acc = document.querySelector('[data-proposal-accept]'); if (!acc) return 'NO BUTTON Add to dataset';
     await __t.real.click(acc);
     const t = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent.trim()).find((s) => /Added \\d+ questions? to datasets\\/handbook\\.jsonl/.test(s)), 8000); if (!t) return 'NO TOAST';
     const row = await __t.waitFor(() => document.querySelector('[data-rag-dataset-row="handbook.jsonl"]'), 8000);
     return 'toast: ' + t.match(/Added \\d+ questions? to datasets\\/handbook\\.jsonl/)[0] + ' | listed: ' + !!row + ' | records: ' + row?.textContent.match(/(\\d+) records?/)?.[1];`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'voices-and-the-meaning-check-are-in-the-dialog': /^personas: true \| styles: 6 \| embedder before: false \| embedder shown: true \| estimate line: true \| embedder hidden again: true$/,
    'the-data-tab-offers-generation': /^datasets: \d+ \| generate: true \| capture: true$/,
    'the-dialog-estimates-before-anything-is-sent': /^estimate: true \| passages: true \| file written: false$/,
    'what-will-be-sent-shows-the-passages': /^passage shown: true \| dialog still open: true$/,
    'generate-opens-the-review-with-checks': /^rows: 4 \| ticked: xxx- \| failing: testset-answerable \| first: true$/,
    'add-to-dataset-writes-the-ticked-rows': /^toast: Added 3 questions to datasets\/handbook\.jsonl \| listed: true \| records: 3$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
