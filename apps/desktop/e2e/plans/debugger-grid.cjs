// The Debugger grid's power tools (0.57): header columns and the new built-in columns (FG-12), Group by domain / application /
// connection with collapsible groups (FG-17), Edit > Select matching and the command bar in the palette (FG-3), Resend several
// times with a result table (FG-2), Copy as PowerShell / fetch / HTTPie (Q7) and the running-program picker (FG-16).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const groups = () => vis('main [data-debugger-grid] [role=row][data-group]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const menuItem = (re) => vis('[role=menuitem]').find((m) => re.test(m.textContent.trim()));
  const button = (label) => vis('button').find((b) => b.textContent.trim() === label);
  const headers = () => vis('main [data-debugger-grid] [role=columnheader]').map((h) => h.textContent.trim());
  const closeMenu = async () => { await __t.real.key('Escape'); await __t.sleep(250); };
  const hover = (el) => { el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); };
  const sub = async (label) => { const it = menuItem(new RegExp('^' + label + '$')); if (!it) return false; it.focus(); hover(it); await __t.sleep(400); return true; };
  const rowMenu = async (r) => { await __t.real.rightClick(r); await __t.waitFor(() => menuItem(/^Bookmark$|^Remove the bookmark$/), 3000); };
  const columnsMenu = async () => { await __t.real.click(document.querySelector('main [data-debugger-grid] [aria-label=Columns]')); await __t.sleep(300); };
  const groupMenu = async () => { await __t.real.click(document.querySelector('main [data-debugger-grid] [aria-label="Group by"]')); await __t.sleep(300); };
  const palette = async (text) => { await __t.esc(); await __t.sleep(200); await __t.real.key('k', { ctrl: true }); await __t.waitFor(() => document.querySelector('[role=dialog] input[placeholder]'), 3000); await __t.real.type(text); await __t.sleep(400); };
`;
const step = stepOf(H);

const steps = [
  step(
    'traffic-on-two-domains',
    `await __t.view('Debugger'); await __t.sleep(600);
     if (!(await window.aps.invoke('debug.status')).running) { const arrow = [...document.querySelectorAll('main [data-capture-all] button')].find((b) => b.getAttribute('aria-label') === 'Other ways to start'); if (arrow) { arrow.click(); const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /Only a program I point at the proxy/.test(m.textContent)), 3000); if (it) it.click(); } await __t.sleep(800); }
     await window.aps.invoke('debug.clear').catch(() => undefined);
     for (const q of ['p=1', 'p=2']) await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?' + q });
     await window.aps.invoke('debug.selfTest', { url: 'http://localhost:4010/health?p=3' });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here' });
     await __t.waitFor(() => (rows().length >= 4 ? true : null), 6000);
     return 'rows: ' + rows().length;`,
  ),
  step(
    'new-built-in-columns-are-listed-and-hidden',
    `const before = headers().join(',');
     await columnsMenu();
     const items = vis('[role=menuitem]').map((m) => m.textContent.trim());
     const offered = ['Caching', 'Content-Encoding', 'Client port', 'Protocol', 'TLS'].every((l) => items.some((t) => t.endsWith(l)));
     await __t.real.click(menuItem(/Protocol$/)); await __t.sleep(400);
     const shown = headers().includes('Protocol');
     const cell = rows()[0]?.textContent.includes('http');
     return 'hidden by default: ' + !/Caching|TLS|Protocol/.test(before) + ' | offered: ' + offered + ' | protocol shown: ' + shown + ' | cell: ' + cell;`,
  ),
  step(
    'header-as-a-column',
    `await columnsMenu();
     await __t.real.click(menuItem(/^Add column from a header/)); await __t.waitFor(() => document.querySelector('[data-header-column-dialog]'), 3000);
     const add = () => vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Add column');
     const emptyBlocked = add()?.disabled;
     const input = document.querySelector('[data-header-column-dialog] input'); input.focus(); await __t.real.type('Content-Type'); await __t.sleep(200);
     await __t.real.click(add()); await __t.sleep(1500);
     const col = headers().find((h) => h === 'Content-Type (response)');
     const value = await __t.waitFor(() => (rows().some((r) => /application\\/json|text\\//.test(r.textContent)) ? true : null), 5000);
     const lean = (await window.aps.invoke('debug.columns')).columns.map((c) => c.side + ':' + c.name).join(',');
     return 'blocked while empty: ' + emptyBlocked + ' | header: ' + !!col + ' | values: ' + !!value + ' | backend: ' + lean;`,
  ),
  step(
    'header-column-is-removed-from-the-columns-menu',
    `await columnsMenu();
     await __t.real.click(menuItem(/Content-Type \\(response\\)/)); await __t.sleep(800);
     return 'header gone: ' + !headers().includes('Content-Type (response)') + ' | backend: ' + (await window.aps.invoke('debug.columns')).columns.length;`,
  ),
  step(
    'group-by-domain-with-collapsible-groups',
    `await groupMenu(); await __t.real.click(menuItem(/^Domain$/)); await __t.sleep(600);
     const g = groups().map((x) => x.textContent.trim().replace(/\\s+/g, ' '));
     const both = g.length === 2 && g.some((t) => /127\\.0\\.0\\.1:4010 3 requests/.test(t)) && g.some((t) => /localhost:4010 1 request/.test(t));
     const rowsBefore = rows().length;
     await __t.real.click(groups()[0]); await __t.sleep(400);
     const collapsed = rows().length < rowsBefore && groups()[0].getAttribute('aria-expanded') === 'false';
     await __t.real.click(groups()[0]); await __t.sleep(400);
     return 'groups: ' + both + ' | collapse hides its rows: ' + collapsed + ' | expand again: ' + (rows().length === rowsBefore);`,
  ),
  step(
    'group-by-application-and-none',
    `await groupMenu(); await __t.real.click(menuItem(/^Application$/)); await __t.sleep(500);
     const byApp = groups().length >= 1;
     await groupMenu(); await __t.real.click(menuItem(/^None$/)); await __t.sleep(500);
     return 'by application: ' + byApp + ' | none: ' + (groups().length === 0 && rows().length >= 4);`,
  ),
  step(
    'edit-select-matching',
    `await __t.real.click(button('Edit')); await __t.waitFor(() => menuItem(/^Select matching/), 3000);
     await __t.real.click(menuItem(/^Select matching/)); await __t.waitFor(() => document.querySelector('[data-select-dialog]'), 3000);
     const summary = () => document.querySelector('[data-select-summary]').textContent.replace(/\\s+/g, ' ');
     const firstNote = summary();
     const primary = () => vis('[role=dialog] button').find((b) => /^Select/.test(b.textContent.trim()) && b.dataset.variant === 'primary');
     const label = primary()?.textContent.trim();
     await __t.real.click(primary()); await __t.sleep(700);
     const selected = rows().filter((r) => r.getAttribute('aria-selected') === 'true' || /bg-accent-soft/.test(r.className));
     return 'default: ' + /status>=400/.test(firstNote) + ' | button: ' + label + ' | selected: ' + selected.length + ' | is the 404: ' + selected.every((r) => /nothing-here/.test(r.textContent));`,
  ),
  step(
    'select-matching-says-why-it-cannot',
    `await __t.real.click(button('Edit')); await __t.waitFor(() => menuItem(/^Select matching/), 3000);
     await __t.real.click(menuItem(/^Select matching/)); await __t.waitFor(() => document.querySelector('[data-select-dialog]'), 3000);
     const value = document.querySelector('[data-select-dialog] input'); value.focus(); value.select(); await __t.real.type('999'); await __t.sleep(300);
     const primary = vis('[role=dialog] button').find((b) => b.dataset.variant === 'primary');
     const out = 'disabled: ' + primary?.disabled + ' | reason: ' + (primary?.title || primary?.getAttribute('aria-label') || '') + ' | summary: ' + document.querySelector('[data-select-summary]').textContent.replace(/\\s+/g, ' ');
     await __t.real.click(vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Cancel')); await __t.sleep(300);
     return out;`,
  ),
  step(
    'command-bar-in-the-palette',
    `await palette('!=200');
     const opt = await __t.waitFor(() => document.querySelector('[role=dialog] [role=option]'), 3000);
     const said = opt?.textContent.trim();
     await __t.real.key('Enter'); await __t.sleep(700);
     const sel = rows().filter((r) => /bg-accent-soft/.test(r.className));
     return 'row: ' + said + ' | selected 200s: ' + sel.length + ' | all 200: ' + sel.every((r) => /\\b200\\b/.test(r.textContent));`,
  ),
  step(
    'command-bar-filter-and-help',
    `await palette('?p=2');
     await __t.real.key('Enter'); await __t.sleep(600);
     const filtered = rows().length;
     await __t.real.click(document.querySelector('main [data-clear-filters]')); await __t.sleep(400);
     await palette('!');
     const verbs = vis('[role=dialog] [role=option]').length;
     await __t.esc(); await __t.sleep(200);
     return 'filtered to: ' + filtered + ' | verbs listed: ' + verbs + ' | back: ' + (rows().length >= 4);`,
  ),
  step(
    'copy-as-powershell-fetch-httpie',
    `const r = row('p=1'); await __t.real.click(r); await rowMenu(r); await sub('Copy');
     const items = vis('[role=menuitem]').map((m) => m.textContent.trim()).filter((t) => /^As /.test(t)).join(',');
     await closeMenu(); await closeMenu();
     const id = r.getAttribute('data-exchange');
     const ps = (await window.aps.invoke('debug.snippet', { id, language: 'powershell' })).text;
     const f = (await window.aps.invoke('debug.snippet', { id, language: 'fetch' })).text;
     const h = (await window.aps.invoke('debug.snippet', { id, language: 'httpie' })).text;
     return 'items: ' + items + ' | ps: ' + /Invoke-RestMethod/.test(ps) + ' | fetch: ' + /await fetch\\(/.test(f) + ' | httpie: ' + /^http GET/.test(h);`,
  ),
  step(
    'resend-submenu-and-ten-times',
    `const r = row('p=1'); await __t.real.click(r); await rowMenu(r); await sub('Resend');
     const items = vis('[role=menuitem]').map((m) => m.textContent.trim()).filter((t) => /^(Once|Resend)/.test(t)).join(' | ');
     const inOrder = menuItem(/^Resend the selected, in order$/); const blocked = !!inOrder && (inOrder.hasAttribute('data-disabled') || inOrder.getAttribute('aria-disabled') === 'true');
     await __t.real.click(menuItem(/^Resend 10 times$/));
     const res = await __t.waitFor(() => document.querySelector('[data-replay-result]'), 20000);
     const sent = document.querySelector('[data-replay-sent]')?.textContent.trim();
     const lines = document.querySelectorAll('[data-replay-row]').length;
     return 'items: ' + items + ' | in order blocked for one row: ' + blocked + ' | ' + sent + ' | rows: ' + lines + ' | statuses: ' + !!res?.textContent.match(/200 × 10/);`,
  ),
  step(
    'resend-dialog-stops-at-the-first-failure',
    `await __t.real.click(vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Close')); await __t.sleep(400);
     const r = row('nothing-here'); await __t.real.click(r); await rowMenu(r); await sub('Resend');
     await __t.real.click(menuItem(/^Resend…$/)); await __t.waitFor(() => document.querySelector('[data-replay-dialog]'), 3000);
     const set = (label, v) => { const i = document.querySelector('[data-replay-dialog] input[aria-label="' + label + '"]'); i.focus(); i.select(); return __t.real.type(String(v)); };
     await set('Times', 5);
     const stop = document.querySelector('[data-replay-dialog] input[type=checkbox]'); await __t.real.click(stop);
     await __t.real.click(vis('[role=dialog] button').find((b) => b.dataset.variant === 'primary'));
     await __t.waitFor(() => document.querySelector('[data-replay-result]'), 15000);
     const text = document.querySelector('[data-replay-result]').textContent.replace(/\\s+/g, ' ');
     await __t.real.click(vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Close')); await __t.sleep(300);
     return 'sent: ' + /1 of 5 sent/.test(text) + ' | 404 once: ' + /404 × 1/.test(text) + ' | skipped: ' + /4 sends not started/.test(text);`,
  ),
  step(
    'program-picker-makes-a-capture-only-rule',
    `const capture = [...document.querySelectorAll('main button')].find((b) => /^Capture/.test(b.textContent.trim()) && b.querySelector('svg')); await __t.real.click(capture);
     await __t.waitFor(() => menuItem(/^A running program/), 3000); await __t.real.click(menuItem(/^A running program/));
     await __t.waitFor(() => document.querySelector('[data-program-picker]'), 4000);
     await __t.waitFor(() => (document.querySelector('[data-program-picker] [data-program]') || /No program/.test(document.querySelector('[data-program-picker]').textContent) ? true : null), 15000);
     const first = document.querySelector('[data-program-picker] [data-program]');
     const name = first?.getAttribute('data-program');
     if (!first) { await __t.real.click(vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Close')); return 'no programs listed (the system listed none)'; }
     await __t.real.click([...first.querySelectorAll('button')].find((b) => /Capture only/.test(b.textContent))); await __t.sleep(900);
     const rule = (await window.aps.invoke('debug.rules')).rules.find((x) => x.name === 'Capture only Application = ' + name);
     return 'listed: true | rule: ' + (rule?.kind) + ' on ' + (rule?.match?.application === name);`,
  ),
  step(
    'clean-up',
    `for (const r of (await window.aps.invoke('debug.rules')).rules) if (/^Capture only Application = /.test(r.name)) await window.aps.invoke('debug.deleteRule', { id: r.id });
     await window.aps.invoke('debug.columns', { columns: [] });
     await window.aps.invoke('debug.clear').catch(() => undefined);
     return 'left: ' + (await window.aps.invoke('debug.rules')).rules.filter((r) => /^Capture only Application = /.test(r.name)).length;`,
  ),
];

module.exports = withExpect(steps, {
  'traffic-on-two-domains': /^rows: 4$/,
  'new-built-in-columns-are-listed-and-hidden': /^hidden by default: true \| offered: true \| protocol shown: true \| cell: true$/,
  'header-as-a-column': /^blocked while empty: true \| header: true \| values: true \| backend: response:Content-Type$/,
  'header-column-is-removed-from-the-columns-menu': /^header gone: true \| backend: 0$/,
  'group-by-domain-with-collapsible-groups': /^groups: true \| collapse hides its rows: true \| expand again: true$/,
  'group-by-application-and-none': /^by application: true \| none: true$/,
  'edit-select-matching': /^default: true \| button: Select 1 row \| selected: 1 \| is the 404: true$/,
  'select-matching-says-why-it-cannot': /^disabled: true \| reason: No row matches yet \| summary: .*0 rows of 4 match$/,
  'command-bar-in-the-palette': /^row: Select status 200 \| selected 200s: 3 \| all 200: true$/,
  'command-bar-filter-and-help': /^filtered to: 1 \| verbs listed: 10 \| back: true$/,
  'copy-as-powershell-fetch-httpie': /^items: As cURL,As PowerShell,As fetch \(JavaScript\),As HTTPie \| ps: true \| fetch: true \| httpie: true$/,
  'resend-submenu-and-ten-times': /^items: Once \| Resend 10 times \| Resend the selected, in order \| Resend… \| in order blocked for one row: true \| 10 of 10 sent \| rows: 10 \| statuses: true$/,
  'resend-dialog-stops-at-the-first-failure': /^sent: true \| 404 once: true \| skipped: true$/,
  'program-picker-makes-a-capture-only-rule': /^(listed: true \| rule: only on true|no programs listed.*)$/,
  'clean-up': /^left: 0$/,
});
