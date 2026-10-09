// One tab bar everywhere: a test file tab and a monitor tab have the same right-click menu as a request tab
// (Rename, Close tab, Close other tabs, Close tabs to the right, Close all tabs), and the items do what they say.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const tabsOf = (label) => vis('[role=tablist][aria-label="' + label + '"] [role=tab]');
  const names = (label) => tabsOf(label).map((t) => (t.getAttribute('aria-selected') === 'true' ? '*' : '') + t.textContent.trim()).join(' / ');
  const menuOf = async (tab) => { await __t.esc(); tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 60 })); await __t.waitFor(() => document.querySelector('[role=menuitem]'), 2000); await __t.sleep(150); return vis('[role=menuitem]').map((m) => m.textContent.trim().replace(/(F2|Middle-click)$/, '') + (m.getAttribute('aria-disabled') === 'true' || m.hasAttribute('data-disabled') ? ' (off)' : '')).join(' | '); };
  const pick = async (label) => { vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith(label))?.click(); await __t.sleep(1000); };
  const openRow = async (name) => { const r = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().includes(name)); if (!r) return false; r.click(); await __t.sleep(900); return true; };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'tests-open-three',
    `await __t.view('Tests'); await __t.sleep(1000); for (const f of ['httpbin.yaml', 'countries.yaml', 'echo.yaml']) if (!(await openRow(f))) return 'NO ROW ' + f; return names('Open test files');`,
  ),
  step('tests-tab-menu', `const t = tabsOf('Open test files').find((x) => x.textContent.includes('countries.yaml')); if (!t) return 'NO TAB'; return await menuOf(t);`),
  step('tests-close-others', `await pick('Close other tabs'); return names('Open test files');`),
  step(
    'tests-fixed-tabs-have-no-menu',
    `await __t.esc(); const runs = tabsOf('Open test files').find((x) => x.textContent.trim().startsWith('Runs')); runs.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 60 })); await __t.sleep(500); return 'menu: ' + !!document.querySelector('[role=menuitem]');`,
  ),
  step('tests-close-all', `const t = tabsOf('Open test files').find((x) => x.textContent.includes('countries.yaml')); await menuOf(t); await pick('Close all tabs'); return names('Open test files');`),
  step(
    'monitors-tab-menu',
    `await __t.view('Monitors'); await __t.sleep(1000); if (!(await openRow('Public APIs health'))) return 'NO ROW'; const tabs = tabsOf('Open monitors'); if (!tabs.length) return 'NO MONITOR TABS'; return 'tabs: ' + tabs.length + ' | ' + (await menuOf(tabs[0]));`,
  ),
  step(
    'monitors-close-others-disabled',
    `const it = vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith('Close other tabs')); const off = it && (it.getAttribute('aria-disabled') === 'true' || it.hasAttribute('data-disabled')); await __t.esc(); return 'one tab, close others disabled: ' + off + ' | tabs: ' + tabsOf('Open monitors').length;`,
  ),
  step('monitors-close-all', `const t = tabsOf('Open monitors')[0]; await menuOf(t); await pick('Close all tabs'); return 'left: ' + tabsOf('Open monitors').length;`),
  step(
    'requests-menu-same',
    `await __t.requests(); await __t.sleep(500); if (!document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab]')) { await __t.find('Custom headers'); await __t.sleep(1200); } return await __t.tabMenu();`,
  ),
];

module.exports = withExpect(steps, {
  'tests-open-three': /^HTTPhttpbin\.yaml \/ GQLcountries\.yaml \/ \*WSecho\.yaml \/ Flow \/ Runs/,
  'tests-tab-menu': /^Run \| Expose as MCP tool… \| Rename \| Close tab \| Close other tabs \| Close tabs to the right \| Close all tabs$/,
  'tests-close-others': /^\*GQLcountries\.yaml \/ Flow \/ Runs/,
  'tests-fixed-tabs-have-no-menu': /^menu: false$/,
  'tests-close-all': /^\*Editor \/ Runs/,
  'monitors-tab-menu': /^tabs: 1 \| Run now \| Rename \| Close tab \| Close other tabs \(off\) \| Close tabs to the right \(off\) \| Close all tabs$/,
  'monitors-close-others-disabled': /^one tab, close others disabled: true \| tabs: 1$/,
  'monitors-close-all': /^left: 0$/,
  'requests-menu-same': /RenameF2 \| Close tabMiddle-click \| Close other tabs \| Close tabs to the right \| Close all tabs$/,
});
