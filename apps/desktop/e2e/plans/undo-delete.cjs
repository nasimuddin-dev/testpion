// Undo instead of "Are you sure?": deleting a request, a collection or an environment happens at once; the message
// has Undo (8 s) and Ctrl+Z outside text fields does the same; the item comes back with its id, in its place.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const req = (id, name) => ({ kind: 'http', id, name, request: { method: 'GET', url: `http://127.0.0.1:4010/health?${id}`, headers: [] } });
  writeFileSync(
    join(ws, 'collections', 'e2e-undo.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-undo',
        name: 'E2E undo',
        version: 1,
        updatedAt: new Date().toISOString(),
        variables: [],
        items: [req('u-1', 'Undo one'), req('u-2', 'Undo two'), req('u-3', 'Undo three')],
      },
      null,
      2,
    ),
  );
}

const H = `
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const toastButton = (re, label) => [...document.querySelectorAll('[data-sonner-toast]')].find((t) => re.test(t.textContent))?.querySelector('button[data-button]:not([data-cancel])') ?? [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === label);
  const items = async () => (await window.aps.invoke('col.get', { id: 'e2e-undo' })).items.map((i) => i.id).join(',');
  const dialogs = () => document.querySelectorAll('[role=dialog], [role=alertdialog]').length;
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'delete-request-key',
    `await __t.requests(); await __t.expand('E2E undo');
     const row = [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.textContent.trim().endsWith('Undo two')); if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.esc();
     row.focus(); await __t.real.key('Delete'); await __t.sleep(800);
     const msg = await __t.waitFor(() => toastText(/Deleted the request "Undo two"/), 3000);
     return 'dialogs: ' + dialogs() + ' | message: ' + !!msg + ' | items: ' + (await items());`,
  ),
  // the keyboard moves to the next row when the focused one is deleted (not to the window's body)
  s(
    'focus-after-delete',
    `const a = document.activeElement; return 'on a row: ' + (a?.hasAttribute('data-tree-row') === true) + ' | row: ' + a?.getAttribute('data-row-name');`,
  ),
  s(
    'ctrl-z-restores',
    `document.body.focus(); (document.activeElement)?.blur?.();
     await __t.real.key('z', { ctrl: true }); await __t.sleep(1500);
     const ok = await __t.waitFor(() => toastText(/Restored the request "Undo two"/), 3000);
     return 'restored: ' + !!ok + ' | items: ' + (await items());`,
  ),
  // Undo puts the keyboard on the restored row
  s(
    'focus-after-undo',
    `await __t.waitFor(() => document.activeElement?.getAttribute('data-row-name') === 'Undo two', 3000); return 'row: ' + document.activeElement?.getAttribute('data-row-name');`,
  ),
  s(
    'ctrl-z-in-a-field-is-text',
    `const row = [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.textContent.trim().endsWith('Undo three')); row.focus(); await __t.real.key('Delete'); await __t.sleep(800);
     const f = document.querySelector('aside input[placeholder^="Filter"]'); await __t.real.click(f); await __t.real.key('z', { ctrl: true }); await __t.sleep(800);
     const still = await items();
     const b = toastButton(/Deleted the request "Undo three"/, 'Undo'); if (!b) return 'NO UNDO BUTTON';
     await __t.real.click(b); await __t.sleep(1500);
     return 'after Ctrl+Z in the filter: ' + still + ' | after Undo: ' + (await items());`,
  ),
  s(
    'environment-undo',
    `await __t.view('Environments'); await __t.sleep(600);
     const before = (await window.aps.invoke('ws.current')).environments.map((e) => e.id).join(',');
     const env = (await window.aps.invoke('ws.current')).environments[0];
     const label = await __t.waitFor(() => [...document.querySelectorAll('main *')].find((x) => x.children.length === 0 && x.textContent.trim() === env.name && x.getClientRects().length), 3000);
     if (!label) return 'NO ENV ROW';
     await __t.real.rightClick(label);
     const del = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Delete…'), 2000);
     if (!del) return 'NO DELETE';
     del.click(); await __t.sleep(1200);
     const gone = (await window.aps.invoke('ws.current')).environments.map((e) => e.id).join(',');
     const b = await __t.waitFor(() => toastButton(/Deleted the environment/, 'Undo'), 3000); if (!b) return 'NO UNDO BUTTON | dialogs: ' + dialogs();
     b.click(); await __t.sleep(2000);
     const after = (await window.aps.invoke('ws.current')).environments.map((e) => e.id).join(',');
     return 'dialogs: ' + dialogs() + ' | gone: ' + !gone.split(',').includes(env.id) + ' | back with its id: ' + (after === before);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'delete-request-key': /^dialogs: 0 \| message: true \| items: u-1,u-3$/,
    'focus-after-delete': /^on a row: true \| row: Undo three$/,
    'focus-after-undo': /^row: Undo two$/,
    'ctrl-z-restores': /^restored: true \| items: u-1,u-2,u-3$/,
    'ctrl-z-in-a-field-is-text': /^after Ctrl\+Z in the filter: u-1,u-2 \| after Undo: u-1,u-2,u-3$/,
    'environment-undo': /^dialogs: 0 \| gone: true \| back with its id: true$/,
  },
  { prepare },
);
