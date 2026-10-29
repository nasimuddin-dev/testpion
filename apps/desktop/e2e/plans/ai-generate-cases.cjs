// AU-13 · Generate test cases with AI, with real mouse and keys (__t.real): the Test cases tab of the sample evaluation offers
// "Generate with AI…"; the dialog says where the cases come from (the prompt, an API definition, saved requests, documents, real
// calls in History), shows the estimate and "What will be sent" (the prompt) before anything is sent; Generate (the offline demo
// model writes six new support messages) opens the one proposal review with a row per case and its checks: a case that repeats
// one already there is unticked with its reason; Add to test cases puts the ticked ones in the table (Undo takes them back).
// Offline: the demo model only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const table = () => vis('[data-case-table]')[0];
  const count = () => Number(table()?.getAttribute('data-case-count') ?? -1);
  const dlg = () => vis('[data-gen-cases-dialog]')[0];
`;

const steps = [
  step(
    'open-the-sample-and-its-cases',
    `${H} await window.aps.invoke('ai.sample', { run: false });
     await __t.view('Home'); await __t.view('Evaluations'); await __t.sleep(1000);
     const row = await __t.waitFor(() => vis('aside *, [data-sidebar] *, main *').find((e) => e.children.length === 0 && e.textContent.trim() === 'Sample: support intents'), 6000);
     if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(1000);
     await __t.real.click(tab('Test cases')); await __t.sleep(600);
     return 'cases: ' + count() + ' | generate button: ' + vis('[data-cases-generate]')[0]?.textContent.trim();`,
  ),
  step(
    'make-one-case-the-same-as-a-generated-one',
    `${H} setValue(vis('[data-case="1"] [data-case-cell=input]')[0], 'Please cancel my visit for tomorrow morning'); await __t.sleep(500);
     return 'first case: ' + vis('[data-case="1"] [data-case-cell=input]')[0]?.value;`,
  ),
  step(
    'the-dialog-says-what-it-is-made-from-and-what-it-costs',
    `${H} await __t.real.click(vis('[data-cases-generate]')[0]);
     const d = await __t.waitFor(() => dlg(), 6000); if (!d) return 'NO DIALOG';
     const est = await __t.waitFor(() => /tokens in/.test(d.querySelector('[data-gen-cases-estimate]')?.textContent ?? '') && d.querySelector('[data-gen-cases-estimate]'), 15000);
     const options = [...d.querySelectorAll('[data-gen-cases-source] option')].map((o) => o.textContent.trim()).join(' / ');
     return 'sources: ' + options + ' | estimate: ' + (est ? est.textContent.trim().replace(/\\s+/g, ' ') : 'NONE');`,
  ),
  step(
    'what-will-be-sent-shows-the-prompt',
    `${H} await __t.real.click(vis('[data-ai-preview-open]')[0]);
     const text = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].map((x) => x.textContent).find((t) => /Classify the customer message/.test(t) && /tokens/.test(t)), 10000);
     await __t.real.key('Escape'); await __t.sleep(400);
     return 'prompt shown: ' + !!text + ' | cases dialog still open: ' + !!dlg();`,
  ),
  step(
    'the-other-sources-ask-for-what-they-need',
    `${H} const sel = dlg().querySelector('[data-gen-cases-source]');
     const set = (v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })); };
     set('documents'); await __t.sleep(600);
     const go = vis('[data-gen-cases-go]')[0];
     const docs = 'documents: ' + (go?.disabled ? go.getAttribute('title') : 'ENABLED');
     set('spec'); await __t.sleep(600);
     const spec = !!dlg().querySelector('[data-gen-cases-spec]');
     set('history'); await __t.sleep(400);
     set('prompt'); await __t.sleep(600);
     return docs + ' | spec picker: ' + spec + ' | back on the prompt, Generate enabled: ' + !vis('[data-gen-cases-go]')[0]?.disabled;`,
  ),
  step(
    'generate-opens-the-review-with-checks',
    `${H} await __t.real.click(vis('[data-gen-cases-go]')[0]);
     const rev = await __t.waitFor(() => document.querySelectorAll('[data-proposal-item]').length >= 6 && document.querySelector('[data-proposal]'), 40000); if (!rev) return 'NO REVIEW';
     await __t.sleep(400);
     const items = [...document.querySelectorAll('[data-proposal-item]')];
     const ticks = items.map((i) => (i.querySelector('input[type=checkbox]')?.checked ? 'x' : '-')).join('');
     const dup = items[0].querySelector('[data-verifier=eval-case-duplicate]')?.getAttribute('data-verification');
     const shape = items[1].querySelector('[data-verifier=eval-case-shape]')?.getAttribute('data-verification');
     return 'rows: ' + items.length + ' | ticks: ' + ticks + ' | first is a repeat: ' + dup + ' | second fills the variable: ' + shape + ' | accept button: ' + document.querySelector('[data-proposal-accept]')?.textContent.trim();`,
  ),
  step(
    'accept-adds-the-ticked-cases-and-undo-takes-them-back',
    `${H} await __t.real.click(document.querySelector('[data-proposal-accept]')); await __t.sleep(1200);
     const after = count();
     const names = vis('[data-case-cell=input]').map((i) => i.value).filter((v) => /Do you have a phone number|very short|^ok$/.test(v) || v === 'ok').length;
     const undo = [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Undo');
     if (undo) { await __t.real.click(undo); await __t.sleep(800); }
     return 'after add: ' + after + ' | new inputs seen: ' + (names > 0) + ' | undo offered: ' + !!undo + ' | after undo: ' + count();`,
  ),
];
module.exports = withExpect(
  steps,
  {
  'open-the-sample-and-its-cases': /^cases: 10 \| generate button: Generate with AI…$/,
  'the-dialog-says-what-it-is-made-from-and-what-it-costs': /^sources: The prompt \/ An API definition \/ Saved requests \/ Documents \/ Real calls in history \| estimate: .*tokens in/,
  'what-will-be-sent-shows-the-prompt': /^prompt shown: true \| cases dialog still open: true$/,
  'the-other-sources-ask-for-what-they-need': /^documents: Tick at least one document or folder\. \| spec picker: true \| back on the prompt, Generate enabled: true$/,
  'generate-opens-the-review-with-checks': /^rows: 6 \| ticks: -xxxxx \| first is a repeat: fail \| second fills the variable: pass \| accept button: Add to test cases \(5\)$/,
  'accept-adds-the-ticked-cases-and-undo-takes-them-back': /^after add: 15 \| new inputs seen: true \| undo offered: true \| after undo: 10$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' } },
);
