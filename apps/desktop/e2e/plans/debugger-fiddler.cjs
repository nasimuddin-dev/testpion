// The Debugger's one-click tools (0.55): the filter strip's Breakpoints split button (Off, Every request, Every response, Only POST,
// Only errors, Custom...) that keeps one managed "Auto breakpoint" rule; Pause / Resume listing in the header (the proxy keeps
// forwarding); Hide 304s; a row's note and colour mark with the Comments column, saved in the HAR comment; and the ready-made rules
// (Disable caching, User agent submenu, Require proxy sign-in) in Change this traffic.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const menuItem = (re) => vis('[role=menuitem]').find((m) => re.test(m.textContent.trim()));
  const split = () => document.querySelector('main [data-breakpoint-split]');
  const mode = async () => (await window.aps.invoke('debug.rules')).autoBreakpoint;
  const managed = async () => (await window.aps.invoke('debug.rules')).rules.filter((r) => r.name === 'Auto breakpoint').length;
  const closeMenu = async () => { await __t.real.key('Escape'); await __t.sleep(250); };
  const rowMenu = async (r) => { await __t.real.rightClick(r); await __t.waitFor(() => menuItem(/^Bookmark$|^Remove the bookmark$/), 3000); };
  const hover = (el) => { el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); };
  const sub = async (label) => { const it = menuItem(new RegExp('^' + label + '$')); if (!it) return false; it.focus(); hover(it); await __t.sleep(400); return true; };
`;
const step = stepOf(H);

const steps = [
  step(
    'traffic-in-the-grid',
    `await __t.view('Debugger'); await __t.sleep(600);
     if (!(await window.aps.invoke('debug.status')).running) { const arrow = [...document.querySelectorAll('main [data-capture-all] button')].find((b) => b.getAttribute('aria-label') === 'Other ways to start'); if (arrow) { arrow.click(); const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /Only a program I point at the proxy/.test(m.textContent)), 3000); if (it) it.click(); } await __t.sleep(800); }
     await window.aps.invoke('debug.clear').catch(() => undefined);
     for (const q of ['p=1', 'p=2']) await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?' + q });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here' });
     await __t.waitFor(() => (rows().length >= 3 ? true : null), 6000);
     return 'rows: ' + rows().length + ' | hide 304s: ' + vis('main [data-filter-bar] label').some((l) => l.textContent.trim() === 'Hide 304s') + ' | breakpoints: ' + split()?.textContent.trim();`,
  ),
  step(
    'breakpoint-main-button-toggles',
    `const main = split()?.querySelector('[data-breakpoint-main]'); if (!main) return 'NO BUTTON';
     await __t.real.click(main); await __t.sleep(700);
     const on = (await mode()) + ' | rules: ' + (await managed()) + ' | label: ' + main.textContent.trim();
     await __t.real.click(main); await __t.sleep(700);
     return on + ' | after the second click: ' + (await mode()) + ', ' + (await managed());`,
  ),
  step(
    'breakpoint-menu-chooses-what-to-hold',
    `await __t.real.click(split().querySelector('[data-breakpoint-menu]'));
     await __t.waitFor(() => menuItem(/Only POST/), 3000);
     const names = vis('[role=menuitem]').map((m) => m.textContent.trim().replace(/^✓\\s*/, '')).join(',');
     await __t.real.click(menuItem(/Only POST/)); await __t.sleep(700);
     const post = await mode();
     const inRules = (await window.aps.invoke('debug.rules')).rules.find((r) => r.name === 'Auto breakpoint');
     await __t.real.click(split().querySelector('[data-breakpoint-menu]'));
     await __t.waitFor(() => menuItem(/Only errors/), 3000); await __t.real.click(menuItem(/Only errors/)); await __t.sleep(700);
     return 'items: ' + names + ' | post: ' + post + ' (' + inRules?.summary + ') | errors: ' + (await mode()) + ' | one rule: ' + (await managed()) + ' | label: ' + split().textContent.trim();`,
  ),
  step(
    'custom-opens-the-rule-editor-and-off-removes-the-rule',
    `await __t.real.click(split().querySelector('[data-breakpoint-menu]'));
     await __t.waitFor(() => menuItem(/Custom/), 3000); await __t.real.click(menuItem(/Custom/)); await __t.sleep(600);
     const dlg = document.querySelector('[role=dialog]'); const opened = !!dlg && /reakpoint/.test(dlg.textContent);
     const cancel = vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Cancel'); if (cancel) { await __t.real.click(cancel); await __t.sleep(400); }
     await __t.real.click(split().querySelector('[data-breakpoint-menu]'));
     await __t.waitFor(() => menuItem(/^(✓\\s*)?Off$/), 3000); await __t.real.click(menuItem(/^(✓\\s*)?Off$/)); await __t.sleep(700);
     return 'editor: ' + opened + ' | off: ' + (await mode()) + ', rules: ' + (await managed()) + ' | label: ' + split().textContent.trim();`,
  ),
  step(
    'pause-lists-nothing-and-keeps-forwarding',
    `const pause = document.querySelector('main [data-pause-listing]'); if (!pause) return 'NO PAUSE BUTTON';
     const before = rows().length;
     await __t.real.click(pause); await __t.sleep(600);
     const st = await window.aps.invoke('debug.status');
     const sent = await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?paused=1' });
     await __t.sleep(1200);
     return 'paused: ' + st.paused + ' | label: ' + document.querySelector('main [data-pause-listing]').textContent.trim() + ' | banner: ' + !!document.querySelector('main [data-listing-paused]') + ' | forwarded: ' + sent.status + ' | listed: ' + !!row('paused=1') + ' | rows: ' + (rows().length === before);`,
  ),
  step(
    'resume-lists-again',
    `await __t.real.click(document.querySelector('main [data-pause-listing]')); await __t.sleep(600);
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?resumed=1' });
     const r = await __t.waitFor(() => row('resumed=1'), 5000);
     return 'paused: ' + (await window.aps.invoke('debug.status')).paused + ' | label: ' + document.querySelector('main [data-pause-listing]').textContent.trim() + ' | banner: ' + !!document.querySelector('main [data-listing-paused]') + ' | listed: ' + !!r;`,
  ),
  step(
    'note-from-the-row-menu-shows-in-comments',
    `const r = row('p=1'); if (!r) return 'NO ROW';
     await rowMenu(r);
     if (!menuItem(/^Add a note…$/)) return 'NO MENU ITEM';
     await __t.real.click(menuItem(/^Add a note…$/));
     const input = await __t.waitFor(() => document.querySelector('[role=dialog] input, [role=dialog] textarea'), 3000); if (!input) return 'NO PROMPT';
     await __t.real.click(input); await __t.real.type('login is slow');
     await __t.real.click(vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Save')); await __t.sleep(1000);
     const heads = vis('main [data-debugger-grid] [role=columnheader]').map((h) => h.textContent.trim());
     const cell = row('p=1')?.textContent.includes('login is slow');
     const ex = (await window.aps.invoke('debug.exchanges', { text: 'p=1' }));
     const stored = (Array.isArray(ex) ? ex : ex.rows ?? [])[0]?.note;
     return 'comments column: ' + heads.includes('Comments') + ' | in the row: ' + !!cell + ' | stored: ' + stored;`,
  ),
  step(
    'mark-from-the-row-menu-colours-the-row',
    `const r = row('p=1'); await rowMenu(r);
     await sub('Mark'); const red = await __t.waitFor(() => menuItem(/^Red$|^✓?\\s*Red$/), 2000); if (!red) return 'NO COLOURS';
     await __t.real.click(red); await __t.sleep(900);
     const coloured = /border-l-bad/.test(row('p=1').className);
     await rowMenu(row('p=1')); await sub('Mark');
     const removable = menuItem(/^Remove the mark$/); const enabled = removable && !removable.hasAttribute('data-disabled') && removable.getAttribute('aria-disabled') !== 'true';
     await closeMenu(); await closeMenu();
     return 'coloured: ' + coloured + ' | remove offered: ' + !!enabled;`,
  ),
  step(
    'note-and-mark-round-trip-through-the-har',
    `const har = await window.aps.invoke('debug.har');
     const entry = har.log.entries.find((e) => e.request.url.includes('p=1'));
     const inFile = entry?.comment + ' / ' + entry?._testpion?.mark;
     await window.aps.invoke('debug.openSession', { text: JSON.stringify(har) }); await __t.sleep(1200);
     const back = await __t.waitFor(() => row('p=1'), 5000);
     const again = (await window.aps.invoke('debug.exchanges', { text: 'p=1' }));
     const e = (Array.isArray(again) ? again : again.rows ?? [])[0];
     return 'har: ' + inFile + ' | reopened: ' + e?.note + ' / ' + e?.mark + ' | row coloured: ' + /border-l-bad/.test(back?.className ?? '');`,
  ),
  step(
    'ready-made-rules-in-change-this-traffic',
    `const r = row('p=2'); await rowMenu(r);
     await sub('Change this traffic');
     const names = vis('[role=menuitem]').map((m) => m.textContent.trim()).filter((t) => /caching|encodings|gzip|User agent|sign-in/.test(t)).join(' | ');
     await sub('User agent');
     const uas = vis('[role=menuitem]').map((m) => m.textContent.trim()).filter((t) => /^(Chrome|Firefox|Safari|iPhone|Android|Search bot)/.test(t)).join(',');
     await __t.real.click(menuItem(/^iPhone$/)); await __t.sleep(900);
     const rule = (await window.aps.invoke('debug.rules')).rules.find((x) => x.name === 'User agent: iPhone');
     return 'items: ' + names + ' | user agents: ' + uas + ' | rule: ' + rule?.requestHeaders?.[0]?.name + '=' + /iPhone/.test(rule?.requestHeaders?.[0]?.value ?? '') + ' on ' + rule?.match?.host;`,
  ),
  step(
    'clean-up',
    `for (const r of (await window.aps.invoke('debug.rules')).rules) if (/^User agent: |^Auto breakpoint$/.test(r.name)) await window.aps.invoke('debug.deleteRule', { id: r.id });
     await window.aps.invoke('debug.pause', { on: false });
     await window.aps.invoke('debug.clear').catch(() => undefined);
     return 'left: ' + (await window.aps.invoke('debug.rules')).rules.filter((r) => /^User agent: |^Auto breakpoint$/.test(r.name)).length;`,
  ),
];

module.exports = withExpect(steps, {
  'traffic-in-the-grid': /^rows: 3 \| hide 304s: true \| breakpoints: Breakpoints: Off$/,
  'breakpoint-main-button-toggles': /^request \| rules: 1 \| label: Breakpoints: Every request \| after the second click: off, 0$/,
  'breakpoint-menu-chooses-what-to-hold': /^items: Off,Every request,Every response,Only POST,Only errors,Custom… \| post: post \(Pause the request of POST\) \| errors: errors \| one rule: 1 \| label: Breakpoints: Only errors$/,
  'custom-opens-the-rule-editor-and-off-removes-the-rule': /^editor: true \| off: off, rules: 0 \| label: Breakpoints: Off$/,
  'pause-lists-nothing-and-keeps-forwarding': /^paused: true \| label: Resume \| banner: true \| forwarded: 200 \| listed: false \| rows: true$/,
  'resume-lists-again': /^paused: false \| label: Pause \| banner: false \| listed: true$/,
  'note-from-the-row-menu-shows-in-comments': /^comments column: true \| in the row: true \| stored: login is slow$/,
  'mark-from-the-row-menu-colours-the-row': /^coloured: true \| remove offered: true$/,
  'note-and-mark-round-trip-through-the-har': /^har: login is slow \/ red \| reopened: login is slow \/ red \| row coloured: true$/,
  'ready-made-rules-in-change-this-traffic': /^items: Disable caching \| Remove all encodings \| Ask for gzip \| User agent \| Require proxy sign-in \(plain HTTP\) \| user agents: Chrome \(Windows\),Firefox \(Windows\),Safari \(Mac\),iPhone,Android phone,Search bot \| rule: User-Agent=true on 127\.0\.0\.1:4010$/,
  'clean-up': /^left: 0$/,
});
