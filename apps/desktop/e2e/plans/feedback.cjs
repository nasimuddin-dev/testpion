// Send feedback: the dialog, masking, the recent error, saving the report, the command palette entry.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder } = require('../lib.cjs');
const setVal = `const setVal = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };`;
const dlg = `document.querySelector('[role=dialog]')`;
const steps = [
  ['throw-error', `(async () => { setTimeout(() => { throw new Error('feedback-test boom with token=supersecret123'); }, 0); await __t.sleep(1500); return 'thrown'; })()`],
  ['open-from-status-bar', `(async () => { const b = [...document.querySelectorAll('footer button')].find((x) => x.textContent.trim() === 'Feedback'); if (!b) return 'NO STATUS BUTTON'; b.click(); await __t.sleep(1200); const d = ${dlg}; return d ? d.innerText.slice(0, 400).replace(/\\n/g, ' · ') : 'NO DIALOG'; })()`],
  ['fill-problem', `(async () => { ${setVal} const d = ${dlg}; [...d.querySelectorAll('[role=radio]')].find((x) => x.textContent.includes('Problem')).click(); await __t.sleep(300);
    setVal(d.querySelector('input'), 'Feedback test: the view froze'); const tas = d.querySelectorAll('textarea'); setVal(tas[0], 'It froze after sending. My token=abc12345 should be hidden.'); setVal(tas[1], '1. Open\\n2. Send');
    const errToggle = [...d.querySelectorAll('label, button, [role=switch]')].find((x) => /recent errors/.test(x.textContent));
    await __t.sleep(300);
    [...d.querySelectorAll('button')].find((x) => /Show the report/.test(x.textContent))?.click(); await __t.sleep(800);
    return (d.querySelector('pre')?.textContent ?? 'NO PREVIEW').slice(0, 900); })()`],
  ['save-file', `(async () => { const d = ${dlg}; [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save as file').click(); await __t.sleep(1500); return [...document.querySelectorAll('li, [role=status], div')].filter((x) => x.children.length <= 2 && /Report/.test(x.textContent) && x.textContent.length < 200).map((x) => x.textContent.trim())[0] ?? 'NO TOAST'; })()`],
  ['palette-entry', `(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await __t.sleep(700); const i = document.querySelector('[role=dialog] input'); if (!i) return 'NO PALETTE'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'feedback'); i.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(500); return document.querySelector('[role=dialog]').innerText.slice(0, 200).replace(/\\n/g, ' · '); })()`],
];

module.exports = withExpect(steps, {
  'open-from-status-bar': /Send feedback · Problem · Idea · Design · Question/,
  'fill-problem': /\[Bug\] Feedback test: the view froze[\s\S]*token=\*\*\*/,
  'save-file': /Report saved to/,
  'palette-entry': /Send feedback or report a problem/,
}, { allowErrors: ['throw-error'], env: (out) => ({ E2E_STUB_SAVE: require('node:path').join(out, 'report.md') }) });
