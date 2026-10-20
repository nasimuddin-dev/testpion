// Export and import of every kind (B-22, planning/export-import.md): the section headers and items have Export… and
// Import…; one dialog exports (what it holds, the secrets it replaces, "everything it uses"), one dialog imports
// (preview: New / Already here / Conflict, a choice per item, Undo in the message). Driven with real input only
// (__t.real: right-click, clicks, selects by key). The save and open dialogs are answered by E2E_STUB_SAVE and
// E2E_STUB_OPEN (the same file): the dataset section is exported, the file holds no secret, the dataset is deleted,
// imported back (New), imported again (Already here), changed (Conflict, Keep both), and Undo takes the import back.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

// built from fragments so no file in the repository holds a string a secret scanner takes for a live key; none is real
const alnum = (n) => 'Ab3'.repeat(Math.ceil(n / 3)).slice(0, n);
const PASSWORD = 'Pw' + alnum(14) + '9';
const MCP_TOKEN = 'Bearer ' + alnum(14) + '7=' + alnum(10);
const OUT_NAME = 'e2e-bundle.testpion.json';

function prepare(ws) {
  mkdirSync(join(ws, 'datasets'), { recursive: true });
  writeFileSync(join(ws, 'datasets', 'e2e-people.csv'), `name,password\nann,${PASSWORD}\nbob,${PASSWORD}2\n`);
  const servers = JSON.parse(readFileSync(join(ws, 'mcp-servers.json'), 'utf8'));
  servers.servers.push({
    id: 'e2e-bundle-mcp',
    name: 'E2E bundle server',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:4010/mcp',
    headers: [{ key: 'Authorization', value: MCP_TOKEN, enabled: true }],
  });
  writeFileSync(join(ws, 'mcp-servers.json'), JSON.stringify(servers, null, 2));
}

const H = `
  const node = (id) => [...document.querySelectorAll('[data-node-id]')].find((n) => n.getAttribute('data-node-id') === id && n.getClientRects().length);
  const menuOpen = () => document.querySelector('[role=menu]');
  const items = () => [...(menuOpen()?.querySelectorAll('[role=menuitem]') ?? [])].map((m) => m.textContent.trim());
  const close = async () => { if (!menuOpen()) return; await __t.real.key('Escape'); await __t.waitFor(() => !menuOpen(), 1500); };
  const menuOf = async (row) => { await close(); row.scrollIntoView({ block: 'center' }); await __t.real.rightClick(row); return await __t.waitFor(menuOpen, 2000); };
  const pick = async (label) => { const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label), 1500); if (!it) return false; await __t.real.click(it); await __t.waitFor(() => !menuOpen(), 1500); return true; };
  const dialog = (id) => document.querySelector('[data-testid="' + id + '"]');
  const footer = (label) => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim().startsWith(label) && b.getClientRects().length);
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const unfold = async (row) => { const b = row?.querySelector('[data-tree-row][aria-expanded="false"]'); if (b) { b.scrollIntoView({ block: 'center' }); await __t.real.click(b); await __t.waitFor(() => b.getAttribute('aria-expanded') === 'true', 1500); } };
`;
const s = (name, body, shot = true) => step(name, body, shot, { extra: H, short: 600 });

const steps = [
  s(
    'section-menu',
    `await __t.requests();
     const row = await __t.waitFor(() => node('section:datasets'), 4000); if (!row) return 'NO ROW section:datasets';
     await unfold(row);
     if (!(await menuOf(row))) return 'NO MENU';
     const list = items(); await close();
     const item = await __t.waitFor(() => node('datasets:e2e-people.csv'), 3000); if (!item) return 'NO ROW e2e-people.csv';
     if (!(await menuOf(item))) return 'NO MENU (item)';
     const own = items(); await close();
     return 'section: ' + list.filter((l) => /^(Import|Export)/.test(l)).join(' / ') + ' | item: ' + own.filter((l) => /^Export/.test(l)).join(' / ');`,
  ),
  s(
    'export-dialog-shows-what-it-holds',
    `const row = node('section:datasets'); if (!(await menuOf(row))) return 'NO MENU';
     if (!(await pick('Export…'))) return 'NO ITEM Export…';
     const d = await __t.waitFor(() => dialog('export-bundle'), 3000); if (!d) return 'NO DIALOG';
     const sum = await __t.waitFor(() => dialog('export-bundle-summary'), 6000); if (!sum) return 'NO SUMMARY';
     const t = sum.textContent.replace(/\\s+/g, ' ');
     return [
       'title: ' + document.querySelector('[role=dialog] h2, [role=dialog] [class*=Title]')?.textContent.trim(),
       'items: ' + (/(\\d+) items? ·/.exec(t)?.[1] ?? 'NO'),
       'has dataset: ' + t.includes('e2e-people.csv'),
       'secrets replaced: ' + /(\\d+) secrets? will be replaced by variables/.test(t),
       'uses switch: ' + !!d.querySelector('[role=switch]'),
     ].join(' | ');`,
  ),
  s(
    'export-saves-the-file',
    `const b = footer('Export'); if (!b) return 'NO BUTTON Export';
     await __t.real.click(b);
     const t = await __t.waitFor(() => toastText(/^Bundle saved to/), 15000); if (!t) return 'NO TOAST';
     const gone = await __t.waitFor(() => !dialog('export-bundle'), 3000);
     return 'saved: ' + t.includes(${JSON.stringify(OUT_NAME)}) + ' | dialog closed: ' + !!gone;`,
  ),
  [
    'the-file-is-a-bundle-without-secrets',
    `main: const { readFileSync } = require('node:fs');
     const text = readFileSync(process.env.E2E_STUB_SAVE, 'utf8');
     const b = JSON.parse(text);
     const leaked = ${JSON.stringify([PASSWORD, PASSWORD + '2'])}.filter((v) => text.includes(v));
     const ds = b.items.filter((i) => i.kind === 'dataset').map((i) => i.id);
     return [
       'format: ' + b.format + ' v' + b.formatVersion,
       'datasets: ' + ds.join(','),
       'leaked: ' + (leaked.join(',') || 'none'),
       'variable: ' + /\\{\\{password\\}\\}/.test(Object.values(b.entries).map((e) => e.content).join('')),
       'requires: ' + (b.requires?.secrets?.length ?? 0),
     ].join(' | ');`,
    false,
  ],
  s(
    'collection-export-with-everything-it-uses',
    `const row = await __t.waitFor(() => node('httpbin'), 3000); if (!row) return 'NO ROW httpbin';
     if (!(await menuOf(row))) return 'NO MENU';
     const sub = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Export')); if (!sub) return 'NO ITEM Export';
     await __t.real.click(sub);
     if (!(await pick('Export with everything it uses…'))) return 'NO ITEM Export with everything it uses…';
     const d = await __t.waitFor(() => dialog('export-bundle'), 3000); if (!d) return 'NO DIALOG';
     const sum = await __t.waitFor(() => dialog('export-bundle-summary'), 8000); if (!sum) return 'NO SUMMARY';
     const t = sum.textContent.replace(/\\s+/g, ' ');
     const on = d.querySelector('[role=switch]')?.getAttribute('aria-checked');
     return 'switch on: ' + on + ' | holds the collection: ' + /1 Collection/.test(t) + ' | more than it: ' + (Number(/(\\d+) items? ·/.exec(t)?.[1]) > 1);`,
  ),
  s(
    'the-switch-narrows-it-to-the-collection',
    `const d = dialog('export-bundle'); const sw = d?.querySelector('[role=switch]'); if (!sw) return 'NO SWITCH';
     await __t.real.click(sw);
     await __t.waitFor(() => /(\\d+) items? ·/.exec(dialog('export-bundle-summary')?.textContent ?? '')?.[1] === '1', 6000);
     const t = dialog('export-bundle-summary')?.textContent.replace(/\\s+/g, ' ') ?? 'NO SUMMARY';
     const cancel = footer('Cancel'); if (cancel) await __t.real.click(cancel);
     return 'items now: ' + (/(\\d+) items? ·/.exec(t)?.[1] ?? 'NO');`,
  ),
  s(
    'delete-the-dataset',
    `await window.aps.invoke('item.remove', { ref: 'dataset:e2e-people.csv' });
     const gone = await __t.waitFor(() => !node('datasets:e2e-people.csv'), 4000);
     return 'dataset gone: ' + !!gone;`,
  ),
  s(
    'import-previews-and-applies',
    `const row = node('section:datasets'); if (!(await menuOf(row))) return 'NO MENU';
     if (!(await pick('Import…'))) return 'NO ITEM Import…';
     const d = await __t.waitFor(() => dialog('import-bundle') && dialog('import-bundle').querySelector('[role=row]'), 6000); if (!d) return 'NO PREVIEW';
     const rows = [...dialog('import-bundle').querySelectorAll('[role=row]')].filter((r) => r.getAttribute('data-action'));
     const mine = rows.find((r) => r.textContent.includes('e2e-people.csv'));
     const b = footer('Import'); if (!b) return 'NO BUTTON Import';
     const label = b.textContent.trim();
     await __t.real.click(b);
     const t = await __t.waitFor(() => toastText(/^Imported/), 10000); if (!t) return 'NO TOAST';
     const back = await __t.waitFor(() => node('datasets:e2e-people.csv'), 5000);
     return 'row action: ' + mine?.getAttribute('data-action') + ' | button: ' + label + ' | toast: ' + t.slice(0, 40) + ' | dataset back: ' + !!back;`,
  ),
  s(
    'undo-takes-the-import-back',
    `const undo = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Undo'), 4000); if (!undo) return 'NO BUTTON Undo';
     await __t.real.click(undo);
     const gone = await __t.waitFor(() => !node('datasets:e2e-people.csv'), 6000);
     return 'dataset gone again: ' + !!gone + ' | said: ' + !!(await __t.waitFor(() => toastText(/^Undid the import/), 4000));`,
  ),
  s(
    'import-again-then-already-here',
    `const row = node('section:datasets'); if (!(await menuOf(row))) return 'NO MENU';
     if (!(await pick('Import…'))) return 'NO ITEM Import…';
     if (!(await __t.waitFor(() => dialog('import-bundle')?.querySelector('[role=row]'), 6000))) return 'NO PREVIEW';
     await __t.real.click(footer('Import'));
     await __t.waitFor(() => node('datasets:e2e-people.csv'), 8000);
     // a second time: the same bundle is identical
     const row2 = node('section:datasets'); if (!(await menuOf(row2))) return 'NO MENU';
     if (!(await pick('Import…'))) return 'NO ITEM Import…';
     if (!(await __t.waitFor(() => dialog('import-bundle')?.querySelector('[role=row]'), 6000))) return 'NO PREVIEW';
     const r = [...dialog('import-bundle').querySelectorAll('[role=row]')].find((x) => x.textContent.includes('e2e-people.csv'));
     const label = footer('Nothing to import') ? 'Nothing to import' : footer('Import')?.textContent.trim();
     const cancel = footer('Cancel'); if (cancel) await __t.real.click(cancel);
     return 'second preview: ' + r?.getAttribute('data-action') + ' | button: ' + label;`,
  ),
  s(
    'a-changed-dataset-is-a-conflict-and-keep-both-names-it',
    `await window.aps.invoke('datasets.write', { name: 'e2e-people.csv', text: 'name,password\\nzed,changed\\n' });
     await __t.waitFor(() => node('datasets:e2e-people.csv'), 3000);
     const row = node('section:datasets'); if (!(await menuOf(row))) return 'NO MENU';
     if (!(await pick('Import…'))) return 'NO ITEM Import…';
     if (!(await __t.waitFor(() => dialog('import-bundle')?.querySelector('[role=row]'), 6000))) return 'NO PREVIEW';
     const r = [...dialog('import-bundle').querySelectorAll('[role=row]')].find((x) => x.textContent.includes('e2e-people.csv'));
     const action = r?.getAttribute('data-action');
     const shown = r?.textContent.replace(/\\s+/g, ' ');
     await __t.real.click(footer('Import'));
     const t = await __t.waitFor(() => toastText(/^Imported/), 10000); if (!t) return 'NO TOAST';
     const copy = await __t.waitFor(() => node('datasets:e2e-people-2.csv'), 5000);
     return 'action: ' + action + ' | proposed: ' + /e2e-people-2\\.csv/.test(shown) + ' | both kept: ' + !!(copy && node('datasets:e2e-people.csv'));`,
  ),
  s(
    'file-menu-and-palette-have-the-bundle-commands',
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
     const input = await __t.waitFor(() => document.querySelector('[role=dialog] input, input[placeholder*="ommand"]'), 3000); if (!input) return 'NO INPUT';
     await __t.real.type('TestPion Bundle');
     const t = await __t.waitFor(() => document.body.textContent.includes('Import a TestPion Bundle'), 3000);
     const both = document.body.textContent.includes('Export a TestPion Bundle');
     await __t.real.key('Escape');
     return 'import command: ' + !!t + ' | export command: ' + both;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'section-menu': /^section: Import… \/ Export… \| item: Export…$/,
    'export-dialog-shows-what-it-holds': /^title: Export datasets \| items: \d+ \| has dataset: true \| secrets replaced: true \| uses switch: true$/,
    'export-saves-the-file': /^saved: true \| dialog closed: true$/,
    'the-file-is-a-bundle-without-secrets': /^format: testpion-bundle v1 \| datasets: [^|]*datasets\/e2e-people\.csv[^|]* \| leaked: none \| variable: true \| requires: [1-9]\d*$/,
    'collection-export-with-everything-it-uses': /^switch on: true \| holds the collection: true \| more than it: (true|false)$/,
    'the-switch-narrows-it-to-the-collection': /^items now: 1$/,
    'delete-the-dataset': /^dataset gone: true$/,
    'import-previews-and-applies': /^row action: create \| button: Import \d+ items? \| toast: Imported \d+ items? from[^|]*\| dataset back: true$/,
    'undo-takes-the-import-back': /^dataset gone again: true \| said: true$/,
    'import-again-then-already-here': /^second preview: identical \| button: Nothing to import$/,
    'a-changed-dataset-is-a-conflict-and-keep-both-names-it': /^action: conflict \| proposed: true \| both kept: true$/,
    'file-menu-and-palette-have-the-bundle-commands': /^import command: true \| export command: true$/,
  },
  { prepare, env: (out) => ({ E2E_STUB_SAVE: join(out, OUT_NAME), E2E_STUB_OPEN: join(out, OUT_NAME) }) },
);
