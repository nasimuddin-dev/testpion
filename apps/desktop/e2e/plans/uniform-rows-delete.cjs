// UI audit 2026-10-21 (A, F, I): one row, one delete, one empty state. The Traces list and a trace's spans are the
// shared row (↑ ↓, Enter, Shift+F10 opens the same menu as right-click); a history entry asks before it goes (it cannot be
// put back); the open collection, monitor and test file have their item's ⋯ menu in the editor with Delete… and Undo, the
// same as their rows; a Debugger rule goes with Undo; closing the last tab of Monitors or Environments shows the shared
// "No open …" page with its New button; the Debugger's empty statistics offer their first step. Real input throughout.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  writeFileSync(
    join(ws, 'collections', 'e2e-rows.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-rows',
        name: 'E2E rows',
        version: 1,
        updatedAt: new Date().toISOString(),
        variables: [],
        items: [{ kind: 'http', id: 'rows-1', name: 'Rows one', request: { method: 'GET', url: 'http://127.0.0.1:4010/health?rows', headers: [] } }],
      },
      null,
      2,
    ),
  );
}

const H = `
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')];
  const toastText = (re) => toasts().map((t) => t.textContent.trim()).find((t) => re.test(t));
  const toastButton = (re, label) => toasts().find((t) => re.test(t.textContent))?.querySelector('button[data-button]:not([data-cancel])') ?? toasts().flatMap((t) => [...t.querySelectorAll('button')]).find((b) => b.textContent.trim() === label);
  const dialogs = () => document.querySelectorAll('[role=dialog], [role=alertdialog]').length;
  const menuItems = async () => (await __t.waitFor(() => { const m = [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()); return m.length ? m : null; }, 2500)) ?? [];
  const menuItem = (label) => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label);
  const exists = (rpc, params) => window.aps.invoke(rpc, params).then(() => true, () => false);
  const closeAll = async (strip) => { for (let i = 0; i < 12; i++) { const c = vis('[role=tablist][aria-label="' + strip + '"] [aria-label^="Close"]')[0]; if (!c) break; c.click(); await __t.sleep(400); } };
`;
const s = (name, body) => step(name, body, true, { extra: H, short: 400 });

const steps = [
  s(
    'traces-rows-keyboard-and-menu',
    `for (let i = 0; i < 2; i++) await window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:4010/health?trace=' + i, headers: [] } });
     await __t.view('Traces');
     const rows = await __t.waitFor(() => { const r = vis('main [role=tree][aria-label="Traces"] [data-tree-row]'); return r.length >= 2 ? r : null; }, 8000);
     if (!rows) return 'NO ROWS';
     rows[0].focus(); await __t.real.key('ArrowDown');
     const moved = document.activeElement?.getAttribute('data-rename-id') === rows[1].getAttribute('data-rename-id');
     await __t.real.key('Enter');
     const shown = !!(await __t.waitFor(() => document.querySelector('main [data-trace-view]'), 6000));
     const selected = vis('main [role=tree][aria-label="Traces"] [data-tree-row][aria-selected=true]').length;
     vis('main [role=tree][aria-label="Traces"] [data-tree-row]')[1]?.focus();
     await __t.real.key('F10', { shift: true });
     const items = await menuItems(); await __t.esc();
     return 'arrow: ' + moved + ' | enter: ' + shown + ' | selected: ' + selected + ' | menu: ' + items.join(', ');`,
  ),
  s(
    'trace-spans-are-rows',
    `const rows = vis('main [role=tree][aria-label="Spans"] [data-tree-row]');
     return 'spans: ' + (rows.length > 0) + ' | one selected: ' + (rows.filter((r) => r.getAttribute('aria-selected') === 'true').length === 1) + ' | level: ' + rows[0]?.getAttribute('aria-level');`,
  ),
  s(
    'history-delete-asks-first',
    `await __t.view('History');
     const before = (await window.aps.invoke('history.list', { limit: 1 })).total;
     const row = await __t.waitFor(() => vis('main [role=tree][aria-label="History"] [data-tree-row]')[0], 6000); if (!row) return 'NO ROW';
     row.focus(); await __t.real.key('Delete');
     const ask = await __t.waitFor(() => document.querySelector('[role=alertdialog], [role=dialog]'), 3000);
     const asked = /cannot be undone/.test(document.body.innerText);
     const yes = vis('[role=alertdialog] button, [role=dialog] button').find((b) => b.textContent.trim() === 'Delete'); if (!yes) return 'NO DELETE BUTTON | dialog: ' + !!ask;
     await __t.real.click(yes); await __t.sleep(1200);
     const after = (await window.aps.invoke('history.list', { limit: 1 })).total;
     return 'asked: ' + asked + ' | deleted: ' + (after === before - 1) + ' | message: ' + !!toastText(/^Deleted the history entry/);`,
  ),
  s(
    'collection-editor-menu',
    `await __t.requests(); await __t.sleep(500);
     const row = [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.offsetParent && r.textContent.trim().endsWith('E2E rows')); if (!row) return 'NO ROW';
     await __t.real.rightClick(row);
     const settings = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Settings, runner')), 2500); if (!settings) return 'NO SETTINGS ITEM';
     await __t.real.click(settings);
     const more = await __t.waitFor(() => vis('main button[aria-label="More collection actions"]')[0], 6000); if (!more) return 'NO ⋯';
     await __t.real.click(more);
     const items = await menuItems();
     return 'menu: ' + items.join(', ') + ' | red delete button: ' + vis('main button.text-bad').length;`,
  ),
  s(
    'collection-delete-undo',
    `const del = menuItem('Delete…'); if (!del) return 'NO DELETE';
     await __t.real.click(del); await __t.sleep(1200);
     const gone = !(await exists('col.get', { id: 'e2e-rows' }));
     const b = await __t.waitFor(() => toastButton(/Deleted the collection "E2E rows"/, 'Undo'), 3000); if (!b) return 'NO UNDO | dialogs: ' + dialogs();
     await __t.real.clickSettled(b); await __t.sleep(2000);
     return 'dialogs: ' + dialogs() + ' | gone: ' + gone + ' | back: ' + (await exists('col.get', { id: 'e2e-rows' }));`,
  ),
  s(
    'monitor-editor-menu-delete-undo',
    `await __t.view('Monitors'); await __t.sleep(800);
     const ids = async () => (await window.aps.invoke('monitor.list')).map((m) => m.id).sort().join(',');
     const before = await ids();
     const row = vis('[data-tree-row]').find((r) => r.textContent.includes('Public APIs health')); if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(800);
     const more = await __t.waitFor(() => vis('main nav[data-item-breadcrumb] button[aria-label^="More actions for"]')[0], 4000); if (!more) return 'NO ⋯';
     await __t.real.click(more);
     const items = await menuItems();
     const del = menuItem('Delete…'); if (!del) return 'NO DELETE in ' + items.join(', ');
     await __t.real.click(del); await __t.sleep(1200);
     const gone = (await ids()) !== before;
     const b = await __t.waitFor(() => toastButton(/Deleted the monitor "Public APIs health"/, 'Undo'), 3000); if (!b) return 'NO UNDO';
     await __t.real.clickSettled(b); await __t.sleep(1800);
     return 'menu: ' + items.join(', ') + ' | old item: ' + items.includes('Delete monitor') + ' | dialogs: ' + dialogs() + ' | gone: ' + gone + ' | back: ' + ((await ids()) === before);`,
  ),
  s(
    'monitors-last-tab-closed',
    `await __t.view('Monitors'); await __t.sleep(600);
     await closeAll('Open monitors');
     const main = document.querySelector('main')?.innerText ?? '';
     return 'empty: ' + /No open monitors/.test(main) + ' | new: ' + !!button('New monitor');`,
  ),
  s(
    'test-file-editor-delete-undo',
    `await window.aps.invoke('tests.write', { path: 'e2e-rows.yaml', content: 'name: E2E rows\\nsteps: []\\n' });
     await __t.view('Tests'); await __t.sleep(800);
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((r) => r.textContent.trim().endsWith('e2e-rows.yaml')), 5000); if (!row) return 'NO ROW';
     row.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(row); await __t.sleep(900);
     const more = await __t.waitFor(() => vis('main nav[data-item-breadcrumb] button[aria-label="More actions for e2e-rows.yaml"]')[0], 4000); if (!more) return 'NO ⋯';
     await __t.real.click(more);
     const del = await __t.waitFor(() => menuItem('Delete…'), 2500); if (!del) return 'NO DELETE';
     await __t.real.click(del); await __t.sleep(1200);
     const gone = !(await exists('tests.read', { path: 'e2e-rows.yaml' }));
     const b = await __t.waitFor(() => toastButton(/Deleted the test file "e2e-rows.yaml"/, 'Undo'), 3000); if (!b) return 'NO UNDO | dialogs: ' + dialogs();
     await __t.real.clickSettled(b); await __t.sleep(1500);
     return 'old button: ' + vis('main button[aria-label="Delete file"]').length + ' | dialogs: ' + dialogs() + ' | gone: ' + gone + ' | back: ' + (await exists('tests.read', { path: 'e2e-rows.yaml' }));`,
  ),
  s(
    'debugger-rule-undo',
    `const made = await window.aps.invoke('debug.saveRule', { rule: { kind: 'highlight', name: 'E2E rule', enabled: true, match: {}, color: 'blue' } });
     const id = made.rule.id;
     const has = async () => (await window.aps.invoke('debug.rules')).rules.some((r) => r.id === id);
     await __t.view('Debugger'); await __t.sleep(800);
     tab('Rules')?.click(); await __t.sleep(800);
     const bin = await __t.waitFor(() => vis('main tr[data-rule="' + id + '"] button[aria-label="Remove the rule"]')[0], 4000); if (!bin) return 'NO BIN';
     await __t.real.click(bin); await __t.sleep(1000);
     const gone = !(await has());
     const b = await __t.waitFor(() => toastButton(/Deleted the rule "E2E rule"/, 'Undo'), 3000); if (!b) return 'NO UNDO | dialogs: ' + dialogs();
     await __t.real.clickSettled(b); await __t.sleep(1500);
     const back = await has();
     await window.aps.invoke('debug.deleteRule', { id });
     return 'dialogs: ' + dialogs() + ' | gone: ' + gone + ' | back: ' + back;`,
  ),
  s(
    'debugger-empty-statistics-offer-a-step',
    `await window.aps.invoke('debug.clear');
     tab('Statistics')?.click(); await __t.sleep(800);
     const main = document.querySelector('main')?.innerText ?? '';
     return 'empty: ' + /Nothing captured yet/.test(main) + ' | record: ' + !!button('Record a flow…');`,
  ),
  s(
    'environments-last-tab-closed',
    `await __t.view('Environments'); await __t.sleep(800);
     await closeAll('Open environments');
     const main = document.querySelector('main')?.innerText ?? '';
     return 'empty: ' + /No open environments/.test(main) + ' | new: ' + !!button('New environment');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'traces-rows-keyboard-and-menu': /^arrow: true \| enter: true \| selected: 1 \| menu: Open, .*Copy link/,
    'trace-spans-are-rows': /^spans: true \| one selected: true \| level: 1$/,
    'history-delete-asks-first': /^asked: true \| deleted: true \| message: true$/,
    'collection-editor-menu': /^menu: .*Run collection.*Delete… \| red delete button: 0$/,
    'collection-delete-undo': /^dialogs: 0 \| gone: true \| back: true$/,
    'monitor-editor-menu-delete-undo': /^menu: .*Run now.*Delete… \| old item: false \| dialogs: 0 \| gone: true \| back: true$/,
    'monitors-last-tab-closed': /^empty: true \| new: true$/,
    'test-file-editor-delete-undo': /^old button: 0 \| dialogs: 0 \| gone: true \| back: true$/,
    'debugger-rule-undo': /^dialogs: 0 \| gone: true \| back: true$/,
    'debugger-empty-statistics-offer-a-step': /^empty: true \| record: true$/,
    'environments-last-tab-closed': /^empty: true \| new: true$/,
  },
  { prepare },
);
