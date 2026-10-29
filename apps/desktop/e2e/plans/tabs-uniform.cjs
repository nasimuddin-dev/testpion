// One tab bar everywhere: a test file tab and a monitor tab have the same right-click menu as a request tab
// (Rename, Close tab, Close other tabs, Close tabs to the right, Close all tabs), and the items do what they say. Every strip also has Reopen closed tab (WF-10).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const tabsOf = (label) => vis('[role=tablist][aria-label="' + label + '"] [role=tab]');
  const names = (label) => tabsOf(label).map((t) => (t.getAttribute('aria-selected') === 'true' ? '*' : '') + t.textContent.trim()).join(' / ');
  const menuOf = async (tab) => { await __t.esc(); tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 60 })); await __t.waitFor(() => document.querySelector('[role=menuitem]'), 2000); await __t.sleep(150); return vis('[role=menuitem]').map((m) => m.textContent.trim().replace(/(F2|Middle-click)$/, '') + (m.getAttribute('aria-disabled') === 'true' || m.hasAttribute('data-disabled') ? ' (off)' : '')).join(' | '); };
  const pick = async (label) => { vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith(label))?.click(); await __t.sleep(1000); };
  const openRow = async (name) => { const r = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().includes(name)); if (!r) return false; r.click(); await __t.sleep(900); return true; };
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  /** The request editor's own tab strip (the one with Params): its tabs drawn, hidden, cut, and its overflow button. */
  const strip = () => {
    const list = vis('main [role=tablist]').find((l) => [...l.querySelectorAll('[role=tab]')].some((t) => t.textContent.trim().startsWith('Params')));
    if (!list) return 'NO STRIP';
    const box = list.getBoundingClientRect();
    const all = [...list.querySelectorAll('[role=tab]')];
    const hidden = all.filter((t) => t.hasAttribute('data-overflow'));
    const shown = all.filter((t) => !t.hasAttribute('data-overflow'));
    const cut = shown.filter((t) => { const r = t.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }).map((t) => t.textContent.trim());
    const drawn = hidden.filter((t) => getComputedStyle(t).visibility !== 'hidden').map((t) => t.textContent.trim());
    const more = list.parentElement.querySelector('[data-tab-overflow]');
    return 'density ' + document.documentElement.dataset.density + ' | tabs ' + all.length + ' | shown ' + shown.length + ' | hidden ' + hidden.length + ' | cut: ' + (cut.join(',') || 'none') + ' | drawn though hidden: ' + (drawn.join(',') || 'none') + ' | button: ' + (more ? more.getAttribute('aria-label') + ' = ' + more.textContent.trim() : 'none');
  };
`;
const step = stepOf(H);

const steps = [
  step(
    'tests-open-three',
    `await __t.view('Tests'); await __t.sleep(1000); for (const f of ['httpbin.yaml', 'countries.yaml', 'echo.yaml']) if (!(await openRow(f))) return 'NO ROW ' + f; return names('Open test files');`,
  ),
  step('tests-tab-menu', `const t = tabsOf('Open test files').find((x) => x.textContent.includes('countries.yaml')); if (!t) return 'NO TAB'; return await menuOf(t);`),
  step('tests-close-others', `await pick('Close other tabs'); return names('Open test files');`),
  step(
    'tests-fixed-tabs-have-no-menu',
    `await __t.esc(); const runs = tabsOf('Open test files').find((x) => x.textContent.trim().startsWith('Flow')); runs.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 60 })); await __t.sleep(500); return 'menu: ' + !!document.querySelector('[role=menuitem]');`,
  ),
  step('tests-close-all', `const t = tabsOf('Open test files').find((x) => x.textContent.includes('countries.yaml')); await menuOf(t); await pick('Close all tabs'); return 'tabs: ' + tabsOf('Open test files').length + ' | ' + (/No open test files/.test(document.querySelector('main')?.innerText ?? '') ? 'No open test files' : 'NO EMPTY STATE');`),
  step(
    'monitors-tab-menu',
    `await __t.view('Monitors'); await __t.sleep(1000); if (!(await openRow('Public APIs health'))) return 'NO ROW'; const tabs = tabsOf('Open monitors'); if (!tabs.length) return 'NO MONITOR TABS'; return 'tabs: ' + tabs.length + ' | ' + (await menuOf(tabs[0]));`,
  ),
  step(
    'monitors-close-others-disabled',
    `const it = vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith('Close other tabs')); const off = it && (it.getAttribute('aria-disabled') === 'true' || it.hasAttribute('data-disabled')); await __t.esc(); return 'one tab, close others disabled: ' + off + ' | tabs: ' + tabsOf('Open monitors').length;`,
  ),
  step('monitors-close-all', `const t = tabsOf('Open monitors')[0]; await menuOf(t); await pick('Close all tabs'); return 'left: ' + tabsOf('Open monitors').length;`),
  // WF-19: environments, saved prompts and Debugger sessions are tabs of the same strip, with the same menu
  step(
    'environments-tab-menu',
    `await __t.view('Environments'); await __t.sleep(800); const tabs = tabsOf('Open environments'); if (!tabs.length) return 'NO ENVIRONMENT TABS'; return await menuOf(tabs[0]);`,
  ),
  step(
    'prompts-tab-menu',
    `await __t.esc(); await __t.view('AI Lab'); await __t.sleep(800); await __t.tab('Try a prompt'); await __t.sleep(600); const tabs = tabsOf('Open prompts'); if (!tabs.length) return 'NO PROMPT TABS'; return await menuOf(tabs[0]);`,
  ),
  step(
    'live-capture-tab-is-fixed',
    `await __t.esc(); await __t.view('Debugger'); await __t.sleep(800); const live = tabsOf('Open sessions').find((t) => /Live capture/.test(t.textContent)); if (!live) return 'NO LIVE TAB'; live.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 60 })); await __t.sleep(500); const m = !!document.querySelector('[role=menuitem]'); await __t.esc(); return 'menu: ' + m + ' | close button: ' + !!live.querySelector('[aria-label^="Close"]');`,
  ),
  step(
    'requests-menu-same',
    `await __t.requests(); await __t.sleep(500); if (!document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab]')) { await __t.find('Custom headers'); await __t.sleep(1200); } return await __t.tabMenu();`,
  ),
  // the request editor's strip (Params, Authorization, Headers, Body … Settings) in a pane too narrow for all of them:
  // a tab only partly in view is not drawn and is counted by the overflow button, so no cut-off name ("Exar…") stands
  // next to it; the same at compact density, where more tabs are partial
  step('editor-strip-compact', `await __t.esc(); document.documentElement.dataset.density = 'compact'; await painted(); await __t.sleep(400); return strip();`),
  step('editor-strip-comfortable', `document.documentElement.dataset.density = 'comfortable'; await painted(); await __t.sleep(400); return strip();`),
];

module.exports = withExpect(steps, {
  'tests-open-three': /^HTTPhttpbin\.yaml \/ GQLcountries\.yaml \/ \*WSecho\.yaml \/ Flow$/,
  'tests-tab-menu': /^Run \| Expose as MCP tool… \| Run with data… \| Run in several environments… \| Rename \| Close tab \| Close other tabs \| Close tabs to the right \| Close all tabs \| Reopen closed tab( \(off\))?$/,
  'tests-close-others': /^\*GQLcountries\.yaml \/ Flow$/,
  'tests-fixed-tabs-have-no-menu': /^menu: false$/,
  'tests-close-all': /^tabs: 0 \| No open test files$/,
  // key hints (F2, Middle-click, Ctrl+Shift+T) are drawn by CSS: a menu item's text is its label alone
  'monitors-tab-menu': /^tabs: 1 \| Run now \| Rename \| Close tab \| Close other tabs \(off\) \| Close tabs to the right \(off\) \| Close all tabs \| Reopen closed tab( \(off\))?$/,
  'monitors-close-others-disabled': /^one tab, close others disabled: true \| tabs: 1$/,
  'monitors-close-all': /^left: 0$/,
  'environments-tab-menu': /^Rename \(off\) \| Close tab \| Close other tabs \(off\) \| Close tabs to the right \(off\) \| Close all tabs \| Reopen closed tab( \(off\))?$/,
  'prompts-tab-menu': /^Rename \(off\) \| Close tab \| Close other tabs \(off\) \| Close tabs to the right \(off\) \| Close all tabs \| Reopen closed tab( \(off\))?$/,
  'live-capture-tab-is-fixed': /^menu: false \| close button: false$/,
  'requests-menu-same': /Rename \| Close tab \| Close other tabs \| Close tabs to the right \| Close all tabs \| Reopen closed tab( \(off\))?$/,
  'editor-strip-compact': noCutTab('compact'),
  'editor-strip-comfortable': noCutTab('comfortable'),
});

/** No tab drawn is cut, no hidden tab is drawn, and the button counts exactly the hidden ones (there are some: the editor is side by side with the response). */
function noCutTab(density) {
  return (r) => {
    const m = new RegExp(`^density ${density} \\| tabs (\\d+) \\| shown (\\d+) \\| hidden (\\d+) \\| cut: none \\| drawn though hidden: none \\| button: All tabs \\((\\d+) not shown\\) = (\\d+)$`).exec(r);
    if (!m) return 'a cut or drawn-though-hidden tab, or no overflow button: ' + r;
    const [, tabs, shown, hidden, counted, onButton] = m.map(Number);
    return hidden > 0 && shown + hidden === tabs && counted === hidden && onButton === hidden ? true : 'the counts disagree: ' + r;
  };
}
