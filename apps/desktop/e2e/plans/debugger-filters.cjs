// The HTTP Debugger's filters: Hide tunnels (a CONNECT row goes and comes back), the quick-filter chips (two Capture only chips keep
// the rows of either, the chip's name says what clicking does, the rule stays), Clear filters (next to the filters; Save session and
// Clear stay apart, behind a divider), and the filtered empty state's Show all.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf, curl } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const menuItem = (re) => vis('[role=menuitem]').find((m) => re.test(m.textContent.trim()));
  const hover = (el) => { el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); };
  const chips = () => vis('main [data-quick-filter]');
  const hideBox = () => [...document.querySelectorAll('main label')].find((l) => l.textContent.trim() === 'Hide tunnels')?.querySelector('input');
  const clearFilters = () => document.querySelector('main [data-clear-filters]');
  /** The row's menu ▸ the submenu ▸ the item whose text matches. */
  const quick = async (rowText, sub, item) => {
    const r = row(rowText); if (!r) return 'NO ROW ' + rowText;
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    await __t.waitFor(() => menuItem(sub), 2000);
    const s = menuItem(sub); s?.focus(); hover(s);
    const it = await __t.waitFor(() => menuItem(item), 2000); if (!it) return 'NO ITEM ' + item;
    it.click(); await __t.sleep(600);
    return 'ok';
  };
`;
const step = stepOf(H);
const PROXY = 'http://127.0.0.1:8899';

const steps = [
  step(
    'start-and-send',
    `await __t.view('Debugger'); await __t.sleep(600);
     if (!(await window.aps.invoke('debug.status')).running) { await (async () => { const arrow = [...document.querySelectorAll('main [data-capture-all] button')].find((b) => b.getAttribute('aria-label') === 'Other ways to start'); if (!arrow) return; arrow.click(); const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /Only a program I point at the proxy/.test(m.textContent)), 3000); if (it) it.click(); })(); await __t.sleep(800); }
     await window.aps.invoke('debug.clear').catch(() => undefined);
     for (const q of ['a=1', 'a=2']) await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?' + q });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here?x=1' });
     await __t.waitFor(() => (rows().length >= 3 ? true : null), 6000);
     return 'http rows: ' + rows().length;`,
  ),
  // a program that asks for a tunnel (HTTPS through the proxy): a CONNECT row, listed as a tunnel
  ['a-tunnel-through-the-proxy', `main: return 'curl: ' + ${curl(['-s', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', '-x', PROXY, 'https://127.0.0.1:4010/tunnel-test'])};`, false],
  step(
    'hide-tunnels-effect',
    `await __t.waitFor(() => (rows().length >= 4 ? true : null), 6000);
     const all = rows().length; const tunnels = rows().filter((r) => /CONNECT/.test(r.textContent)).length;
     const box = hideBox(); if (!box) return 'NO CHECKBOX';
     await __t.real.click(box); await __t.sleep(400);
     const hidden = rows().length; const left = rows().filter((r) => /CONNECT/.test(r.textContent)).length; const clearShown = !!clearFilters();
     await __t.real.click(hideBox()); await __t.sleep(400);
     return 'rows ' + all + ' (tunnels ' + tunnels + ') | hidden: ' + hidden + ' (tunnels ' + left + ') | clear filters shown while on: ' + clearShown + ' | back: ' + rows().length + ' | clear filters gone: ' + !clearFilters();`,
  ),
  step(
    'two-capture-only-chips-keep-either',
    `let r = await quick('a=1', /^Capture only$/, /^URL starts with .*\\/health$/); if (r !== 'ok') return r;
     // (the first chip hides the nothing-here row; the second, Method = GET, brings it back: the union, as the rules list)
     r = await quick('a=1', /^Capture only$/, /^Method = GET$/); if (r !== 'ok') return r;
     await __t.sleep(400);
     const c = chips(); const shown = rows().filter((x) => !/CONNECT/.test(x.textContent)).length; const tunnelsLeft = rows().filter((x) => /CONNECT/.test(x.textContent)).length;
     return 'chips: ' + c.length + ' | texts: ' + c.map((x) => x.textContent.trim().replace(/\\s+/g, ' ')).join(' ; ') + ' | http rows: ' + shown + ' | tunnels: ' + tunnelsLeft;`,
  ),
  step(
    'chip-label-and-x-keep-the-rule',
    `const c = chips()[0]; if (!c) return 'NO CHIP';
     const aria = c.getAttribute('aria-label'); const title = c.getAttribute('title');
     await __t.real.click(c); await __t.sleep(400);
     const left = chips().length;
     const rules = await window.aps.invoke('debug.rules');
     const mine = rules.rules.filter((x) => x.kind === 'only' && /^Capture only /.test(x.name));
     return 'aria: ' + /^Show the rows hidden by URL starts with /.test(aria) + ' | title says the rule stays: ' + /The rule stays in Rules/.test(title) + ' | chips left: ' + left + ' | rules still there: ' + mine.length + ' | names without !=: ' + mine.every((x) => !x.name.includes('!='));`,
  ),
  step(
    'clear-filters-next-to-the-filters',
    `const box = hideBox(); await __t.real.click(box); await __t.sleep(300);
     const btn = clearFilters(); if (!btn) return 'NO CLEAR FILTERS';
     const actions = document.querySelector('main [data-session-actions]');
     const apart = !!actions && !actions.contains(btn) && !!(btn.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING);
     const sessionLabels = actions ? [...actions.querySelectorAll('button')].map((b) => b.textContent.trim()).join(',') : 'NONE';
     await __t.real.click(btn); await __t.sleep(500);
     return 'apart from Save session / Clear: ' + apart + ' (' + sessionLabels + ') | chips: ' + chips().length + ' | hide tunnels: ' + !!hideBox()?.checked + ' | gone: ' + !clearFilters() + ' | rows: ' + rows().length;`,
  ),
  step(
    'filtered-empty-state-shows-all',
    `const input = document.querySelector('main input[aria-label="Filter exchanges"]'); if (!input) return 'NO FILTER BOX';
     const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
     setter.call(input, 'zzz-nothing-matches'); input.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(600);
     const empty = [...document.querySelectorAll('main *')].find((x) => x.children.length === 0 && x.textContent.trim() === 'No exchange matches the filters');
     const all = vis('main button').find((b) => b.textContent.trim() === 'Show all'); if (!all) return 'NO SHOW ALL (' + !!empty + ')';
     await __t.real.click(all); await __t.sleep(500);
     return 'empty state: ' + !!empty + ' | after Show all rows: ' + rows().length + ' | filter text: ' + JSON.stringify(document.querySelector('main input[aria-label="Filter exchanges"]')?.value);`,
  ),
  step(
    'clean-up-the-rules',
    `const rules = await window.aps.invoke('debug.rules');
     for (const r of rules.rules.filter((x) => /^Capture only /.test(x.name))) await window.aps.invoke('debug.deleteRule', { id: r.id });
     const after = await window.aps.invoke('debug.rules');
     return 'left: ' + after.rules.filter((x) => /^Capture only /.test(x.name)).length;`,
  ),
];

module.exports = withExpect(steps, {
  'start-and-send': /^http rows: [3-9]$/,
  'hide-tunnels-effect': /^rows \d+ \(tunnels [1-9]\d*\) \| hidden: \d+ \(tunnels 0\) \| clear filters shown while on: true \| back: \d+ \| clear filters gone: true$/,
  'two-capture-only-chips-keep-either': /^chips: 2 \| texts: URL starts with .*\/health ; Method = GET \| http rows: 3 \| tunnels: 0$/,
  'chip-label-and-x-keep-the-rule': /^aria: true \| title says the rule stays: true \| chips left: 1 \| rules still there: 2 \| names without !=: true$/,
  'clear-filters-next-to-the-filters': /^apart from Save session \/ Clear: true \(Save session,Clear\) \| chips: 0 \| hide tunnels: false \| gone: true \| rows: \d+$/,
  'filtered-empty-state-shows-all': /^empty state: true \| after Show all rows: [3-9]\d* \| filter text: ""$/,
  'clean-up-the-rules': /^left: 0$/,
});
