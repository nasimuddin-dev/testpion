// The Debugger workbench (as in HTTP Debugger Pro): the tool rail opens the dock's panels; a row's right-click menu
// turns its values into Filter Out / Capture Only rules (with hits); the Highlight Rule editor colours by a condition;
// Timeline, Summary and Structure read the selection; Convert decodes; the grid has the dense columns and totals.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label);
  const rail = (label) => document.querySelector('[data-tool-rail] button[aria-label="' + label + '"]');
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const dock = () => document.querySelector('main [data-dock]');
  const menuItem = (re) => vis('[role=menuitem]').find((m) => re.test(m.textContent.trim()));
  const hover = (el) => { el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' })); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'traffic-in-the-grid',
    `await __t.view('Debugger'); await __t.sleep(600);
     if (!(await window.aps.invoke('debug.status')).running) { button('Start capturing')?.click(); await __t.sleep(800); }
     await window.aps.invoke('debug.clear').catch(() => undefined);
     for (const q of ['a=1', 'a=2', 'b=1']) await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?' + q });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here' });
     await __t.waitFor(() => (rows().length >= 4 ? true : null), 6000);
     const heads = vis('main [data-debugger-grid] [role=columnheader]').map((h) => h.textContent.trim()).join(',');
     const totals = document.querySelector('main [data-grid-totals]')?.textContent ?? '';
     return 'columns: ' + heads + ' | rows: ' + rows().length + ' | totals: ' + /4 requests/.test(totals);`,
  ),
  step(
    'rail-opens-summary-and-timeline',
    `row('a=1')?.click(); await __t.sleep(500);
     if (dock()?.getAttribute('data-dock') !== 'summary') rail('Summary')?.click();
     await __t.sleep(400);
     const summary = dock()?.getAttribute('data-dock') + ':' + [...(dock()?.querySelectorAll('[data-summary-group]') ?? [])].map((g) => g.textContent.trim()).join(',');
     rail('Timeline')?.click(); await __t.sleep(400);
     const phases = [...(dock()?.querySelectorAll('[data-phase]') ?? [])].map((p) => p.getAttribute('data-phase')).join(',');
     // several selected: one axis
     const r2 = row('a=2');
     r2?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await __t.sleep(400);
     const items = [...(dock()?.querySelectorAll('tr') ?? [])].find((t) => /Selected Items/.test(t.textContent));
     const multi = items ? [...items.querySelectorAll('td')].map((c) => c.textContent.trim()).join(' ') : 'NONE';
     return 'summary: ' + summary + ' | phases: ' + phases + ' | multi: ' + multi;`,
  ),
  step(
    'structure-by-domain',
    `rail('Structure')?.click(); await __t.sleep(400);
     const top = dock()?.querySelector('[data-structure]');
     const total = [...(dock()?.querySelectorAll('tr') ?? [])].find((t) => /^Total/.test(t.textContent.trim()));
     const totalText = total ? [...total.querySelectorAll('td')].map((c) => c.textContent.trim()).join(' ') : 'NONE';
     return 'domain: ' + top?.getAttribute('data-structure') + ' | ' + totalText;`,
  ),
  step(
    'row-menu-filters-out',
    `const r = row('b=1'); if (!r) return 'NO ROW';
     r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
     await __t.waitFor(() => menuItem(/^Filter out$/), 2000);
     const sub = menuItem(/^Filter out$/); sub?.focus(); hover(sub);
     const item = await __t.waitFor(() => menuItem(/^URL starts with .*\\/health$/), 2000);
     item?.click(); await __t.sleep(600);
     const dockName = dock()?.getAttribute('data-dock');
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?c=1' });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here?x=1' });
     await __t.sleep(1500);
     const listed = !!row('c=1');
     const other = !!row('nothing-here?x=1');
     const rules = await window.aps.invoke('debug.rules');
     const rule = rules.rules.find((x) => x.kind === 'ignore' && /health/.test(x.match.url ?? ''));
     const hits = rule ? rules.hits[rule.id] : -1;
     if (rule) await window.aps.invoke('debug.deleteRule', { id: rule.id });
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     return 'added: ' + !!rule + ' | dock: ' + dockName + ' | filtered: ' + !listed + ' | others listed: ' + other + ' | hits: ' + hits;`,
  ),
  step(
    'capture-only',
    `const st = await window.aps.invoke('debug.saveRule', { rule: { kind: 'only', name: 'Only nothing-here', enabled: true, match: { url: '*nothing-here*' } } });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?d=1' });
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here?y=1' });
     await __t.sleep(1500);
     const health = !!row('d=1');
     const only = !!row('nothing-here?y=1');
     await window.aps.invoke('debug.deleteRule', { id: st.rule.id });
     return 'outside hidden: ' + !health + ' | inside listed: ' + only;`,
  ),
  step(
    'highlight-rule-editor',
    `rail('Highlight')?.click(); await __t.sleep(400);
     vis('main [data-dock] button').find((b) => b.textContent.trim() === 'Add')?.click(); await __t.sleep(400);
     const ed = document.querySelector('main [data-highlight-editor]'); if (!ed) return 'NO EDITOR';
     const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
     set(ed.querySelector('input[aria-label="Rule name"]'), 'E2E not found');
     set(ed.querySelector('input[aria-label="Value"]'), '404'); set(ed.querySelector('input[aria-label="Upper value"]'), '404');
     [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save')?.click(); await __t.sleep(800);
     const back = dock()?.getAttribute('data-dock');
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/nothing-here?z=1' });
     const r = await __t.waitFor(() => row('nothing-here?z=1'), 4000);
     const statusCell = r ? [...r.children].find((c) => /^404/.test(c.textContent.trim())) : undefined;
     const coloured = !!statusCell?.querySelector('[style*="color"]');
     const bold = !!r?.className.includes('font-semibold');
     const rules = await window.aps.invoke('debug.rules');
     const rule = rules.rules.find((x) => x.name === 'E2E not found');
     if (rule) await window.aps.invoke('debug.deleteRule', { id: rule.id });
     return 'saved: ' + !!rule?.match.where + ' | back to: ' + back + ' | coloured: ' + coloured + ' | bold: ' + bold;`,
  ),
  step(
    'convert-and-incoming',
    `rail('Convert')?.click(); await __t.sleep(400);
     const area = dock()?.querySelector('textarea[aria-label="Text to convert"]'); if (!area) return 'NO CONVERT';
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'a%20b%26c'); area.dispatchEvent(new Event('input', { bubbles: true }));
     [...dock().querySelectorAll('button')].find((b) => b.textContent.trim() === 'URL Decode')?.click(); await __t.sleep(300);
     const out = dock().querySelector('[data-convert-result]')?.value;
     vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Incoming requests'))?.click(); await __t.sleep(400);
     const incoming = !!document.querySelector('main [data-incoming]') || vis('main *').some((x) => x.children.length === 0 && x.textContent.trim() === 'No incoming requests');
     vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Outgoing requests'))?.click(); await __t.sleep(300);
     rail('Convert')?.click(); await __t.sleep(200);
     return 'decoded: ' + out + ' | incoming tab: ' + incoming + ' | dock closed: ' + !dock();`,
  ),
];

module.exports = withExpect(steps, {
  'traffic-in-the-grid': /^columns: #,Offset,Duration,Method,Version,URL,Status,Type,Size,Speed,Application,Domain,IP Address,User \| rows: 4 \| totals: true$/,
  'rail-opens-summary-and-timeline': /^summary: summary:Main,Connection,Request Details,Response Details,Timing \| phases: sending,waiting,receiving \| multi: Selected Items 2$/,
  'structure-by-domain': /^domain: 127\.0\.0\.1:4010 \| Total 4 /,
  'row-menu-filters-out': /^added: true \| dock: filter \| filtered: true \| others listed: true \| hits: [1-9]\d*$/,
  'capture-only': /^outside hidden: true \| inside listed: true$/,
  'highlight-rule-editor': /^saved: true \| back to: highlight \| coloured: true \| bold: true$/,
  'convert-and-incoming': /^decoded: a b&c \| incoming tab: true \| dock closed: true$/,
});
