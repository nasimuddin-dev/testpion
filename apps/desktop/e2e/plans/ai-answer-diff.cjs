// A-7 · What changed, in the answer: Try a prompt keeps the answer a tab got before and shows the next one as the lines added
// and removed against it ("Show what changed since the previous answer"); Compare shows the other models' answers as what
// differs from the first ("Differences from the first"). Both use the one diff view the app has (the same as Git's). The
// offline demo model answers by rules, so a changed input gives a changed answer and the same input the same answer.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const input = () => vis('main textarea').find((t) => t.closest('[data-prompt-inputs]')) ?? vis('main textarea').at(-1);
  const setText = async (el, text) => { await __t.real.click(el); if (document.activeElement !== el) { el.focus(); await __t.sleep(100); } await __t.real.key('a', { ctrl: true }); await __t.real.type(text); await __t.sleep(200); };
  const ran = () => __t.waitFor(() => /Latency/.test(document.querySelector('main')?.innerText ?? ''), 20000);
  const diffRows = () => [...document.querySelectorAll('main [aria-label="Diff"] div')].map((d) => d.textContent[0]).filter((c) => c === '+' || c === '-').join('');
`;

const steps = [
  step(
    'two-answers-then-the-difference',
    `${H} await __t.view('AI Lab'); await __t.sleep(800); tab('Try a prompt')?.click(); await __t.sleep(800);
     const i = input(); if (!i) return 'NO INPUT';
     await setText(i, 'Please book me for Tuesday');
     button('Run')?.click(); if (!(await ran())) return 'NO FIRST ANSWER'; await __t.sleep(600);
     const toggleBefore = !!document.querySelector('[data-play-diff]');
     await setText(input(), 'Please cancel my Tuesday visit');
     button('Run')?.click(); if (!(await ran())) return 'NO SECOND ANSWER'; await __t.sleep(600);
     const toggle = document.querySelector('[data-play-diff]'); if (!toggle) return 'NO TOGGLE';
     await __t.real.click(toggle); await __t.sleep(500);
     const rows = diffRows();
     await __t.real.click(document.querySelector('[data-play-diff]')); await __t.sleep(300);
     return 'toggle before a previous answer: ' + toggleBefore + ' | diff rows: ' + /[-]/.test(rows) + ' ' + /[+]/.test(rows) + ' | plain again: ' + !document.querySelector('main [aria-label="Diff"]');`,
  ),
  step(
    'compare-shows-what-differs-from-the-first',
    `${H} tab('Compare')?.click(); await __t.sleep(800);
     const add = button('Add model'); if (!add) return 'NO ADD MODEL';
     const before = vis('main [aria-label="Model"]').length;
     await __t.real.click(add); await __t.sleep(400);
     const run = vis('main button').find((b) => /^Run\\b/.test(b.textContent.trim()) && b.getAttribute('role') !== 'tab'); if (!run) return 'NO RUN';
     await __t.real.click(run);
     const done = await __t.waitFor(() => vis('main td pre').length >= 2, 30000); if (!done) return 'NO ANSWERS';
     const toggle = document.querySelector('[data-compare-diff]'); if (!toggle) return 'NO TOGGLE';
     await __t.real.click(toggle); await __t.sleep(500);
     const same = /The same answer as the first\\./.test(document.querySelector('main')?.innerText ?? '');
     const firstPlain = vis('main td pre').length >= 1;
     return 'models: ' + before + '→' + vis('main [aria-label="Model"]').length + ' | same model twice: ' + same + ' | the first stays plain: ' + firstPlain;`,
  ),
];

module.exports = withExpect(steps, {
  'two-answers-then-the-difference': /^toggle before a previous answer: false \| diff rows: true true \| plain again: true$/,
  'compare-shows-what-differs-from-the-first': /^models: \d+→\d+ \| same model twice: true \| the first stays plain: true$/,
});
