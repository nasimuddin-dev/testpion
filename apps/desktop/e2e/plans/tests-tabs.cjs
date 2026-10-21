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
  // the Runs tab is there once something opened it (the sidebar's Runs pane, a run), and closes like a file's tab
  step('runs-tab-opens-from-the-sidebar', `[...document.querySelectorAll('[role=tablist][aria-label="Sidebar"] [role=tab]')].find((x) => x.offsetParent && x.textContent.trim().startsWith('Runs'))?.click(); await __t.sleep(700); return state();`),
  step('runs-tab-closes', `const t = tabs().find((x) => x.textContent.trim().startsWith('Runs')); t.querySelector('[aria-label^="Close"]').click(); await __t.sleep(700); return state();`),
  // nothing open: the shared empty state, no tab strip
  step('close-the-rest', `for (const t of tabs()) { t.querySelector('[aria-label^="Close"]')?.click(); await __t.sleep(500); } return 'tabs: ' + tabs().length + ' | empty state: ' + /No open test files/.test(document.querySelector('main')?.innerText ?? '') + ' | strip: ' + !!document.querySelector('[role=tablist][aria-label="Open test files"]');`),
];

module.exports = withExpect(steps, {
  'open-three': /^HTTPhttpbin\.yaml \/ GQLcountries\.yaml \/ \*WSecho\.yaml$/,
  'badges-same-width': /^badges: true \| widths: \d+$/,
  'reopen-one': /^\*HTTPhttpbin\.yaml \/ GQLcountries\.yaml \/ WSecho\.yaml$/,
  'close-active': /^\*GQLcountries\.yaml \/ WSecho\.yaml$/,
  'runs-tab-opens-from-the-sidebar': /^GQLcountries\.yaml \/ WSecho\.yaml \/ \*Runs/,
  'runs-tab-closes': /^\*GQLcountries\.yaml \/ WSecho\.yaml$/,
  'close-the-rest': /^tabs: 0 \| empty state: true \| strip: false$/,
});
