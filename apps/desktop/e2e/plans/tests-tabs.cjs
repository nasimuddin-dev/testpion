// Test files open in their own tabs, like requests: opening an open file shows its tab, closing one shows the next.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const tabs = () => [...document.querySelectorAll('main [role=tab][data-tab-id^="file:"], main [role=tab][data-tab-id="run"]')].filter((t) => t.offsetParent);
  const state = () => tabs().map((t) => (t.getAttribute('aria-selected') === 'true' ? '*' : '') + t.textContent.trim()).join(' / ');
  const openRow = async (name) => { const r = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)); if (!r) return false; r.click(); await __t.sleep(900); return true; };
`;
const step = stepOf(H);

const steps = [
  step('open-three', `await __t.view('Tests'); await __t.sleep(1000); for (const f of ['httpbin.yaml', 'countries.yaml', 'echo.yaml']) if (!(await openRow(f))) return 'NO ROW ' + f; return state();`),
  // THE badge (TreeBadge): every badge of the Tests tree is one pill of one width, whatever it says (HTTP, GQL, WS, AI, SUITE …)
  step('badges-same-width', `const w = [...new Set([...document.querySelectorAll('[data-node-id^="tests:"] .method-badge')].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().width)))]; const n = document.querySelectorAll('[data-node-id^="tests:"] .method-badge').length; return 'badges: ' + (n > 3) + ' | widths: ' + w.join(',');`),
  step('reopen-one', `await openRow('httpbin.yaml'); return state();`),
  step('close-active', `const t = tabs().find((x) => x.getAttribute('aria-selected') === 'true'); t.querySelector('[aria-label^="Close"]').click(); await __t.sleep(700); return state();`),
  step('runs-tab-stays', `return 'runs tab: ' + tabs().some((t) => t.textContent.trim().startsWith('Runs'));`),
];

module.exports = withExpect(steps, {
  'open-three': /^HTTPhttpbin\.yaml \/ GQLcountries\.yaml \/ \*WSecho\.yaml \/ Runs/,
  'badges-same-width': /^badges: true \| widths: \d+$/,
  'reopen-one': /^\*HTTPhttpbin\.yaml \/ GQLcountries\.yaml \/ WSecho\.yaml \/ Runs/,
  'close-active': /^\*GQLcountries\.yaml \/ WSecho\.yaml \/ Runs/,
  'runs-tab-stays': /^runs tab: true$/,
});
