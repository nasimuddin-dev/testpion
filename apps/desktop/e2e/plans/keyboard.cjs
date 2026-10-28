// The keyboard in every tree and list: arrows, Home / End, left / right on folders.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.offsetParent);
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const at = () => (document.activeElement?.textContent ?? '').trim().slice(0, 28);
  const walk = async (container, keys) => { const first = vis(container + ' [data-tree-row]')[0]; first.focus(); const out = [at()]; for (const k of keys) { key(k); await __t.sleep(200); out.push(k + '→' + at()); } return out.join(' | '); };
`;
const step = stepOf(H);
const steps = [
  step('explorer', `await __t.requests(); await __t.sleep(600); return await walk('aside', ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'End', 'Home']);`),
  step('ailab-list', `await __t.view('AI Lab'); await __t.tab('Playground'); await __t.sleep(800); return await walk('main', ['ArrowDown', 'ArrowDown', 'End', 'ArrowUp', 'Home']);`),
  step('tests-tree', `await __t.view('Tests'); await __t.sleep(800); return await walk('main', ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowDown', 'End']);`),
  step('environments', `await __t.view('Environments'); await __t.sleep(800); return await walk('main', ['ArrowDown', 'End', 'Home']);`),
];

module.exports = withExpect(steps, {
  explorer: /ArrowRight→HTTP basics.*ArrowDown→HTTPREST17/,
  // General (the folder of the loose prompt) comes first: Down reaches it, then its prompt; End is the last prompt of the last folder
  'ailab-list': /ArrowDown→General.*ArrowDown→Haiku.*End→Refuses a prompt injection.*ArrowUp→Summarise a text.*Home→Saved prompts/,
  // the header is a row of the tree too (TreeRowShell): ↓ from it reaches the first folder
  'tests-tree': /^Tests \| ArrowDown→\w.*ArrowLeft→ai \| ArrowDown→graphql/,
  environments: /Public APIs/,
});
