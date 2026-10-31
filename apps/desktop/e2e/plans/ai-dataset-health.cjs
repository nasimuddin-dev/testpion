// Dataset health: under the toolbar of an evaluation's Test cases tab, what is off about the cases is said in words (a repeated input,
// cases without the expected answer, one answer most cases expect). Nothing is shown when the cases look healthy.
// Offline: the sample evaluation and the demo model only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'healthy-cases-say-nothing',
    `const r = await window.aps.invoke('ai.sample', { run: false });
     await __t.view('AI Lab'); await __t.sleep(1000);
     await __t.tab('Checks'); await __t.sleep(600);
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside *, main *')].find((e) => e.children.length === 0 && e.offsetParent && e.textContent.trim() === 'Sample: support intents'), 8000); if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(900);
     const casesTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.offsetParent && /^Test cases/.test(t.textContent.trim())); if (!casesTab) return 'NO TAB';
     await __t.real.click(casesTab); await __t.sleep(600);
     return 'notes: ' + !!document.querySelector('[data-dataset-health]');`,
  ),
  step(
    'a-repeat-is-named',
    `// the same input pasted again (the Paste cases… dialog adds it to the table)
     await __t.real.click([...document.querySelectorAll('button')].find((b) => b.offsetParent && /^Paste cases/.test(b.textContent.trim())));
     const ta = await __t.waitFor(() => document.querySelector('[data-paste-dialog] textarea'), 5000); if (!ta) return 'NO DIALOG';
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'input' + String.fromCharCode(9) + 'expected' + String.fromCharCode(10) + 'cancel my appointment ' + String.fromCharCode(9) + 'cancellation');
     ta.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(400);
     await __t.real.click(document.querySelector('[data-paste-add]')); await __t.sleep(800);
     const box = await __t.waitFor(() => document.querySelector('[data-dataset-health]'), 8000); if (!box) return 'NO NOTES';
     const text = box.textContent.replace(/\\s+/g, ' ').trim();
     return 'cases: ' + ([...document.querySelectorAll('[role=tab]')].find((t) => t.offsetParent && /^Test cases/.test(t.textContent.trim()))?.textContent.replace(/\\D+/g, '')) + ' | repeat: ' + /1 case repeats an input already in the list/.test(text) + ' | names the case: ' + /case 11/.test(text);`,
  ),
];

module.exports = withExpect(steps, {
  'healthy-cases-say-nothing': /^notes: false$/,
  'a-repeat-is-named': /^cases: 11 \| repeat: true \| names the case: true$/,
});
