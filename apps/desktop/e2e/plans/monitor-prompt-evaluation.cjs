// A prompt evaluation as a monitor: in the monitor editor, "An evaluation" lists every saved evaluation; a prompt (or agent) one shows its
// own two fields (the first n cases, and "also fail when the pass rate falls") and none of the bot-with-sources ones (gates, judged
// share, budget); saving keeps the evaluation and the previous-run baseline, and the first run starts at once.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, setSelect, step } = require('../lib.cjs');

const steps = [
  step(
    'the-sample-evaluation-exists',
    `const r = await window.aps.invoke('ai.sample', { run: false });
     return 'sample: ' + (r.evaluation?.name ?? r.name ?? 'NONE');`,
  ),
  step(
    'a-prompt-evaluation-shows-its-own-fields',
    `await __t.view('Monitors'); await __t.sleep(900);
     const hb = [...document.querySelectorAll('[aria-label^="More actions for Monitors"]')].find((x) => x.offsetParent); if (!hb) return 'NO HEADER MENU';
     hb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(600);
     const add = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((x) => /^New monitor/.test(x.textContent.trim())), 3000); if (!add) return 'NO NEW MONITOR ITEM';
     add.click(); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="What the monitor runs"]')`, 'An evaluation (a prompt, an agent or a bot with sources)')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation"]')`, 'Sample: support intents')}
     await __t.sleep(800);
     const own = await __t.waitFor(() => document.querySelector('[data-monitor-prompt-fields]'), 5000); if (!own) return 'NO OWN FIELDS';
     return 'prompt fields: true | bot fields: ' + !!document.querySelector('[data-rag-monitor-fields]') + ' | gates field: ' + !!document.querySelector('input[aria-label="Gates"]');`,
  ),
  step(
    'saving-keeps-the-evaluation-and-the-baseline',
    `await __t.real.click('input[placeholder="e.g. API health"]'); await __t.real.type('Intents nightly');
     await __t.real.click('input[aria-label="Number of cases"]'); await __t.real.type('4'); await __t.sleep(200);
     await __t.real.click('input[aria-label="Fail on a drop in pass rate"]'); await __t.sleep(300);
     const save = [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Create monitor'); if (!save) return 'NO SAVE';
     await __t.real.click(save);
     const m = await __t.waitFor(async () => (await window.aps.invoke('monitor.list')).find((x) => x.name === 'Intents nightly'), 8000);
     const list = await window.aps.invoke('monitor.list'); const mon = list.find((x) => x.name === 'Intents nightly');
     return 'saved: ' + !!mon + ' | evaluation: ' + mon?.evaluation + ' | limit: ' + mon?.limit + ' | baseline: ' + mon?.baseline + ' | rag-only cleared: ' + (!mon?.gates && !mon?.judgeSample && !mon?.rotate);`,
  ),
];

module.exports = withExpect(steps, {
  'the-sample-evaluation-exists': /^sample: Sample: support intents$/,
  'a-prompt-evaluation-shows-its-own-fields': /^prompt fields: true \| bot fields: false \| gates field: false$/,
  'saving-keeps-the-evaluation-and-the-baseline': /^saved: true \| evaluation: ev-\S+ \| limit: 4 \| baseline: previous \| rag-only cleared: true$/,
});
