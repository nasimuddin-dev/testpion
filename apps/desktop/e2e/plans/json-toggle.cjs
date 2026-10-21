// The JSON tree's Expand all / Collapse all are one toggle: it offers Expand all until everything is open, then Collapse all.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const bar = () => [...document.querySelectorAll('[data-expand-collapse]')].filter((b) => b.offsetParent && !b.closest('aside'));
  const side = () => [...document.querySelectorAll('aside [data-expand-collapse]')].filter((b) => b.offsetParent);
  const state = () => bar().map((b) => b.getAttribute('data-expand-collapse')).join(',');
  const rows = () => document.querySelectorAll('main [role=treeitem], main [data-json-row]').length;
`;
const step = stepOf(H);

const steps = [
  step(
    'open-and-send',
    `await __t.esc(); await __t.requests(); await __t.sleep(500);
     const f = document.querySelector('aside input[placeholder^="Filter"]');
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'GET with query parameters'); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(900);
     const row = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.getAttribute('aria-expanded') === null && b.textContent.trim().endsWith('GET with query parameters'));
     if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(1200); await __t.button('Send'); await __t.sleep(5000);
     return 'buttons: ' + bar().length + ' (' + state() + ')';`,
  ),
  // one button, never two
  step('one-button', `const b = bar(); return b.length === 1 ? 'one button' : 'buttons: ' + b.length;`),
  // each click flips it: what was offered is done, the other is offered (and back)
  step(
    'flips-both-ways',
    `const s0 = state(); bar()[0].click(); await __t.sleep(500);
     const s1 = state(); bar()[0].click(); await __t.sleep(500);
     return s0 + ' → ' + s1 + ' → ' + state();`,
  ),
  // the explorer has the same toggle (not a separate Collapse all): Collapse all first (a tree that is usually open), then the other after each press
  step(
    'explorer-same-toggle',
    `const s = side(); if (s.length !== 1) return 'buttons: ' + s.length;
     const first = s[0].getAttribute('data-expand-collapse'); s[0].click(); await __t.sleep(700);
     const second = side()[0]?.getAttribute('data-expand-collapse'); side()[0]?.click(); await __t.sleep(700);
     return first + ' → ' + second + ' → ' + side()[0]?.getAttribute('data-expand-collapse');`,
  ),
];

module.exports = withExpect(steps, {
  'open-and-send': /^buttons: 1 \((expand|collapse)\)$/,
  'one-button': /^one button$/,
  'explorer-same-toggle': /^collapse → expand → collapse$/,
  'flips-both-ways': /^(expand|collapse) → (?!\1)(expand|collapse) → \1$/,
});
