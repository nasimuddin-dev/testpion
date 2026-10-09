// Multi-line fields grow with their text (up to 16 lines, then they scroll), so nothing typed or pasted is hidden:
// here the AI Lab Playground's input variable, the case that was cut off.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const LONG =
  'TestPion is a desktop app and CLI for testing REST, GraphQL, gRPC, WebSocket and MCP APIs and AI applications, with collections, environments, scripts, test suites, evaluations, load tests and traces. '.repeat(
    3,
  );
const type = (el, text) =>
  `{ const t = ${el}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); }`;
const measure = (el) => `(() => { const t = ${el}; return { h: Math.round(t.getBoundingClientRect().height), hidden: t.scrollHeight - t.clientHeight > 2 }; })()`;

const steps = [
  step(
    'playground-input-grows',
    `await __t.view('AI Lab'); await __t.sleep(800);
     tab('Playground')?.click(); await __t.sleep(600);
     vis('main *').find((x) => x.children.length === 0 && x.textContent.trim() === 'Summarise a text')?.click(); await __t.sleep(1000);
     const field = () => vis('main label, main [data-field]').map((f) => f.querySelector('textarea')).find(Boolean) ?? vis('main textarea')[0];
     if (!field()) return 'NO FIELD';
     ${type('field()', 'short')} await __t.sleep(200);
     const before = ${measure('field()')};
     ${type('field()', LONG)} await __t.sleep(300);
     const after = ${measure('field()')};
     return 'grew: ' + (after.h > before.h + 30) + ' | text hidden: ' + after.hidden;`,
  ),
];

module.exports = withExpect(steps, { 'playground-input-grows': /^grew: true \| text hidden: false$/ });
