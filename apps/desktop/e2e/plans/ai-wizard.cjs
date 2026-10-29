// AU-12 · The wizard for "Answers are correct": the Start page's first card opens a 3-step dialog (what are you testing, your cases,
// what is a good answer) with the cost under every step. Step 1 needs a name and a prompt (Next says why when it cannot go on) and
// lists the prompt's {{variables}}; step 2 is the one case table (paste cells from a spreadsheet: the column that fills the
// prompt's variable is found); step 3 is the good-answer picker; Run saves the SAME evaluation file the full editor makes (no
// extra fields) and runs it on the offline demo model. From the card to a running evaluation on pasted cases takes 6 clicks.
// "Open the full editor" hands the draft to the normal editor at any step.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const wiz = () => vis('[data-wizard]')[0];
  const stepId = () => wiz()?.getAttribute('data-wizard-step');
`;
const PROMPT = 'Classify the customer message as cancellation, refill, booking or other. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\\n\\nCustomer: {{message}}';

const steps = [
  step(
    'the-first-card-opens-the-wizard',
    `${H} window.__clicks = 0;
     await __t.view('AI Lab'); await __t.sleep(1000);
     await __t.real.click(vis('[data-start-go=correct]')[0]); window.__clicks++;
     const w = await __t.waitFor(() => wiz(), 8000); if (!w) return 'NO WIZARD';
     await __t.sleep(800);
     const title = vis('[data-wizard-title]')[0]?.textContent.replace(/\\s+/g, ' ').trim();
     return 'title: ' + title + ' | step: ' + stepId() + ' | name: ' + vis('[data-wizard-name]')[0]?.value + ' | vars: ' + vis('[data-wizard-vars] span').map((b) => b.textContent.trim()).join(',') + ' | cost line: ' + !!vis('[data-wizard-cost] [data-eval-cost]')[0];`,
  ),
  step(
    'next-says-why-it-cannot-go-on',
    `${H} setValue(vis('[data-wizard-name]')[0], ''); await __t.sleep(300);
     const next = vis('[data-wizard-next]')[0];
     const why = next?.disabled ? next.getAttribute('title') : 'ENABLED';
     setValue(vis('[data-wizard-name]')[0], 'Wizard intents'); await __t.sleep(300);
     return 'disabled with: ' + why + ' | enabled again: ' + !vis('[data-wizard-next]')[0]?.disabled;`,
  ),
  step(
    'the-prompt-and-its-variables',
    `${H} setValue(vis('[data-wizard-prompt]')[0], '${PROMPT}'); await __t.sleep(500);
     const vars = vis('[data-wizard-vars] span').map((b) => b.textContent.trim()).filter((t) => /^[\\w-]+$/.test(t)).join(',');
     return 'variables: ' + vars + ' | run button on step 1: ' + !!vis('[data-wizard-run]')[0];`,
  ),
  step(
    'step-two-is-the-case-table',
    `${H} await __t.real.click(vis('[data-wizard-next]')[0]); window.__clicks++;
     await __t.waitFor(() => stepId() === 'cases' && wiz().querySelector('[data-case-table]'), 6000);
     const warn = vis('[data-wizard-cases]')[0]?.innerText.includes('no such column');
     return 'step: ' + stepId() + ' | table: ' + !!wiz().querySelector('[data-case-table]') + ' | generate with AI: ' + !!wiz().querySelector('[data-cases-generate]') + ' | says the column is missing: ' + warn + ' | run now on: ' + !!vis('[data-wizard-run]')[0];`,
  ),
  step(
    'paste-your-cases',
    `${H} await __t.real.click(wiz().querySelector('[data-cases-paste]')); window.__clicks++;
     const dlg = await __t.waitFor(() => vis('[data-paste-dialog]')[0], 4000); if (!dlg) return 'NO PASTE DIALOG';
     setValue(dlg.querySelector('[data-paste-text]'), 'message\\texpected\\nI want to cancel my visit\\tcancellation\\nNeed a refill please\\trefill\\nBook me in for Monday\\tbooking'); await __t.sleep(500);
     await __t.real.click(vis('[data-paste-replace]')[0]); window.__clicks++; await __t.sleep(800);
     return 'cases: ' + wiz().querySelector('[data-case-table]')?.getAttribute('data-case-count') + ' | warning gone: ' + !wiz().innerText.includes('no such column') + ' | run label: ' + vis('[data-wizard-run]')[0]?.textContent.trim().replace(/\\s+/g, ' ');`,
  ),
  step(
    'step-three-is-the-good-answer-picker',
    `${H} await __t.real.click(vis('[data-wizard-next]')[0]); window.__clicks++;
     await __t.waitFor(() => stepId() === 'good' && wiz().querySelector('[data-pick]'), 6000);
     const picks = wiz().querySelectorAll('[data-pick]').length;
     const ticked = [...wiz().querySelectorAll('[data-picked=true]')].map((p) => p.getAttribute('data-pick')).join(',');
     const sentences = [...wiz().querySelectorAll('[data-pick] [data-pick-what]')].filter((e) => e.textContent.trim()).length;
     await __t.real.click(wiz().querySelector('[data-pick=contains] [data-pick-try]'));
     const r = await __t.waitFor(() => wiz().querySelector('[data-pick-result]'), 15000);
     return 'picks: ' + picks + ' | ticked: ' + ticked + ' | sentences: ' + sentences + ' | try on case 1: ' + r?.getAttribute('data-pick-result') + ' | cost: ' + vis('[data-wizard-cost] [data-eval-cost]')[0]?.getAttribute('data-eval-cost');`,
  ),
  step(
    'run-saves-the-same-evaluation-and-runs-it',
    `${H} const label = vis('[data-wizard-run]')[0]?.textContent.trim().replace(/\\s+/g, ' ');
     await __t.real.click(vis('[data-wizard-run]')[0]); window.__clicks++;
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 40000);
     const item = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.name === 'Wizard intents');
     const keys = Object.keys(item?.data ?? {}).sort();
     const known = ['name', 'type', 'provider', 'model', 'temperature', 'system', 'prompt', 'format', 'datasetFormat', 'dataset', 'expectedField', 'evaluators', 'concurrency', 'limit', 'retries'];
     return 'clicks from the card to the run: ' + window.__clicks + ' | run label: ' + label + ' | headline: ' + (head ? head.textContent.trim() : 'NONE') + ' | saved: ' + !!item + ' | cases saved: ' + (item?.data.dataset ?? '').split('\\n').length + ' | extra fields: ' + (keys.filter((k) => !known.includes(k)).join(',') || 'none') + ' | wizard closed: ' + !wiz() + ' | open in the editor: ' + vis('main input[aria-label="Evaluation name"]')[0]?.value + ' | saved as is: ' + !/unsaved changes/.test(vis('main')[0]?.innerText ?? '');`,
  ),
  step(
    'the-full-editor-takes-the-draft-at-any-step',
    `${H} await __t.view('AI Lab'); await __t.sleep(800);
     await __t.real.click(vis('[data-start-go=correct]')[0]);
     await __t.waitFor(() => wiz(), 6000); await __t.sleep(800);
     await __t.real.click(vis('[data-wizard-editor]')[0]); await __t.sleep(1000);
     return 'wizard closed: ' + !wiz() + ' | editor name: ' + vis('main input[aria-label="Evaluation name"]')[0]?.value + ' | view: ' + (document.querySelector('nav[aria-label="Main navigation"] [aria-current=page]')?.getAttribute('aria-label') ?? '?');`,
  ),
];
module.exports = withExpect(steps, {
  'the-first-card-opens-the-wizard': /^title: Answers are correct\s*Step 1 of 3 \| step: what \| name: New evaluation \| vars: input \| cost line: true$/,
  'next-says-why-it-cannot-go-on': /^disabled with: Give the evaluation a name \| enabled again: true$/,
  'the-prompt-and-its-variables': /^variables: message \| run button on step 1: false$/,
  'step-two-is-the-case-table': /^step: cases \| table: true \| generate with AI: true \| says the column is missing: true \| run now on: true$/,
  'paste-your-cases': /^cases: 3 \| warning gone: true \| run label: Run 3 cases/,
  'step-three-is-the-good-answer-picker': /^picks: 6 \| ticked: contains \| sentences: 6 \| try on case 1: passed \| cost: \w+$/,
  'run-saves-the-same-evaluation-and-runs-it': /^clicks from the card to the run: 6 \| run label: Run 3 cases.* \| headline: 3 of 3 passed \| saved: true \| cases saved: 3 \| extra fields: none \| wizard closed: true \| open in the editor: Wizard intents \| saved as is: true$/,
  'the-full-editor-takes-the-draft-at-any-step': /^wizard closed: true \| editor name: New evaluation/,
});
