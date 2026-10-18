// The JSON tree's Expand all / Collapse all are one toggle: it offers Expand all until everything is open, then Collapse all.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const bar = () => [...document.querySelectorAll('[data-json-expand-all], [data-json-collapse-all]')].filter((b) => b.offsetParent);
  const state = () => bar().map((b) => b.hasAttribute('data-json-expand-all') ? 'expand' : 'collapse').join(',');
  const rows = () => document.querySelectorAll('main [role=treeitem], main [data-json-row]').length;
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-and-send',
    `await __t.esc(); await __t.requests(); await __t.open('GET with query parameters'); await __t.sleep(800); await __t.button('Send'); await __t.sleep(5000);
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
];

module.exports = withExpect(steps, {
  'open-and-send': /^buttons: 1 \((expand|collapse)\)$/,
  'one-button': /^one button$/,
  'flips-both-ways': /^(expand|collapse) → (?!\1)(expand|collapse) → \1$/,
});
