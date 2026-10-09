// Datasets in the Collections sidebar: the section lists datasets/ with a format badge and the row count; a dataset
// opens in a tab with a preview table (column types), the file in the editor (Save), "Use in a test" (copies the
// YAML) and "Run a collection with this dataset" (the Collection Runner with the file chosen); the section's menu
// makes a new CSV and a row's menu duplicates, renames and deletes (into Recently deleted).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepWith } = require('../lib.cjs');

const H = `
  const aside = () => document.querySelector('aside[aria-label="Collections explorer"]');
  const treeRows = () => [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])].filter((x) => x.getClientRects().length);
  const row = (txt) => treeRows().find((b) => b.getAttribute('aria-expanded') === null && b.closest('[data-tree-section="datasets"]') && b.textContent.includes(txt));
  const section = () => treeRows().find((b) => b.getAttribute('aria-expanded') !== null && b.textContent.trim().startsWith('Datasets'));
  const openSection = async () => { const s = section(); if (s && s.getAttribute('aria-expanded') === 'false') { s.click(); await __t.sleep(400); } s?.scrollIntoView(); await __t.sleep(200); return !!s; };
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const dialog = (re) => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find((d) => d.getClientRects().length && re.test(d.textContent));
  const menuItem = (label) => __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label), 2000);
  const toast = (re) => __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => re.test(t)), 5000);
  const editor = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
  const columnTypes = () => [...document.querySelectorAll('main [data-dataset-preview] th [data-column]')].map((b) => b.getAttribute('data-column') + ':' + b.getAttribute('data-column-type')).join(',');
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'sidebar-lists-the-datasets',
    `await __t.requests(); await openSection();
     const r = row('intents.jsonl');
     return 'section: ' + !!section() + ' | row: ' + short(r?.textContent, 60);`,
  ),
  step(
    'a-dataset-opens-in-a-tab',
    `row('intents.jsonl').click();
     const v = await __t.waitFor(() => document.querySelector('main [data-dataset-view="intents.jsonl"]'), 4000);
     if (!v) return 'NO VIEW';
     await __t.waitFor(() => document.querySelector('main [data-dataset-preview] tbody tr'), 4000);
     const counts = v.querySelector('[data-dataset-counts]')?.textContent.trim();
     const tabTitle = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')].map((t) => t.textContent.trim()).join('');
     const rows = document.querySelectorAll('main [data-dataset-preview] tbody tr').length;
     return 'counts: ' + counts + ' | columns: ' + columnTypes() + ' | shown: ' + rows + ' | tab: ' + short(tabTitle, 40);`,
  ),
  step(
    'use-in-a-test-copies-the-yaml',
    `button('Use in a test')?.click();
     const t = await toast(/Copied/);
     let text = '';
     try { text = await navigator.clipboard.readText(); } catch { text = '(unreadable)'; }
     return 'toast: ' + !!t + ' | yaml: ' + short(text, 60);`,
  ),
  step(
    'file-tab-edits-and-saves',
    `await __t.tab('File');
     const ed = await __t.waitFor(() => editor(), 4000);
     if (!ed) return 'NO EDITOR';
     const model = ed.getModel();
     const before = model.getValue();
     model.setValue(before.replace(/\\n?$/, '\\n') + '{"id":"e2e-1","message":"Where is my parcel?","expected":"tracking"}\\n');
     await __t.sleep(300);
     const save = button('Save');
     const enabled = !!save && !save.disabled;
     save?.click();
     const saved = await toast(/Saved datasets\\/intents\\.jsonl/);
     await __t.tab('Preview'); await __t.sleep(600);
     const counts = document.querySelector('main [data-dataset-counts]')?.textContent.trim();
     const side = await __t.waitFor(() => { const r = row('intents.jsonl'); return r && /8 rows/.test(r.textContent) ? r : null; }, 4000);
     // put the file back as it was (Ctrl+S this time)
     await __t.tab('File'); await __t.sleep(300);
     editor().getModel().setValue(before); await __t.sleep(200);
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
     const back = await toast(/Saved datasets\\/intents\\.jsonl/);
     await __t.tab('Preview'); await __t.sleep(600);
     const again = document.querySelector('main [data-dataset-counts]')?.textContent.trim();
     return 'save enabled: ' + enabled + ' | saved: ' + !!saved + ' | counts: ' + counts + ' | sidebar: ' + !!side + ' | ctrl+s: ' + !!back + ' | restored: ' + again;`,
  ),
  step(
    'run-a-collection-with-this-dataset',
    `button('Run a collection with this dataset')?.click();
     await __t.sleep(1200);
     // the Collections view: pick the first collection, the runner opens with the dataset as its data
     const first = await __t.waitFor(() => vis('main button').find((b) => /\\d+ requests/.test(b.textContent)), 4000);
     first?.click();
     const data = await __t.waitFor(() => vis('main *').find((x) => x.childElementCount === 0 && x.textContent.trim() === 'intents.jsonl'), 5000);
     const tabSel = vis('main [role=tab][aria-selected="true"]').map((t) => t.textContent.trim()).join(',');
     const rowsBadge = vis('main span').find((x) => /^7 rows$/.test(x.textContent.trim()));
     return 'tab: ' + tabSel + ' | data: ' + !!data + ' | rows: ' + !!rowsBadge;`,
  ),
  step(
    'new-csv-from-the-section-menu',
    `await __t.requests(); await openSection();
     const more = aside().querySelector('button[aria-label="More actions for Datasets"]');
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
     const newCsv = await menuItem('New CSV');
     const labels = [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).join(' | ');
     newCsv?.click();
     const d = await __t.waitFor(() => dialog(/New CSV dataset/), 3000);
     if (!d) return 'NO DIALOG: ' + labels;
     setInput(d.querySelector('input'), 'e2e-users');
     [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create')?.click();
     const r = await __t.waitFor(() => row('e2e-users.csv'), 4000);
     const v = await __t.waitFor(() => document.querySelector('main [data-dataset-view="e2e-users.csv"]'), 4000);
     const fileTab = vis('main [role=tab][aria-selected="true"]').some((t) => t.textContent.trim() === 'File');
     return 'menu: ' + labels + ' | row: ' + short(r?.textContent, 40) + ' | opened: ' + !!v + ' | file tab: ' + fileTab;`,
  ),
  step(
    'duplicate-rename-delete',
    `await __t.menu('e2e-users.csv');
     (await menuItem('Duplicate'))?.click();
     const copy = await __t.waitFor(() => row('e2e-users-copy.csv'), 4000);
     // rename in place (F2)
     const r = row('e2e-users-copy.csv'); r.focus(); key(r, 'F2'); await __t.sleep(400);
     const input = document.activeElement?.tagName === 'INPUT' ? document.activeElement : null;
     if (!input) return 'NO RENAME FIELD';
     setInput(input, 'e2e-people'); key(input, 'Enter');
     const renamed = await __t.waitFor(() => row('e2e-people.csv'), 4000);
     // delete: a confirmation, then the file is in Recently deleted
     await __t.menu('e2e-people.csv');
     (await menuItem('Delete'))?.click();
     const d = await __t.waitFor(() => dialog(/Delete datasets\\/e2e-people\\.csv/), 3000);
     [...(d?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Delete')?.click();
     const gone = await __t.waitFor(() => (row('e2e-people.csv') ? null : true), 4000);
     const trash = (await window.aps.invoke('trash.list')).filter((t) => t.kind === 'dataset').map((t) => t.name).join(',');
     await window.aps.invoke('datasets.delete', { name: 'e2e-users.csv' }); await __t.sleep(500);
     return 'copy: ' + !!copy + ' | renamed: ' + !!renamed + ' | gone: ' + !!gone + ' | trash: ' + trash;`,
  ),
];

module.exports = withExpect(steps, {
  'sidebar-lists-the-datasets': /^section: true \| row: JSONLintents\.jsonl7 rows$/,
  'a-dataset-opens-in-a-tab': /^counts: 7 rows · 3 columns \| columns: id:string,message:string,expected:string \| shown: 7 \| tab: .*intents\.jsonl/,
  'use-in-a-test-copies-the-yaml': /^toast: true \| yaml: (dataset: path: datasets\/intents\.jsonl|\(unreadable\))$/,
  'file-tab-edits-and-saves': /^save enabled: true \| saved: true \| counts: 8 rows · 3 columns \| sidebar: true \| ctrl\+s: true \| restored: 7 rows · 3 columns$/,
  'run-a-collection-with-this-dataset': /^tab: .*Run.* \| data: true \| rows: true$/,
  'new-csv-from-the-section-menu':
    /^menu: New CSV \| New JSONL \| Generate test data… \| (Collapse|Expand) \| row: CSVe2e-users\.csv0 rows \| opened: true \| file tab: true$/,
  'duplicate-rename-delete': /^copy: true \| renamed: true \| gone: true \| trash: e2e-people\.csv$/,
});
