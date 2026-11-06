// Datasets from another workspace (a sibling checkout or a git submodule): shared with the same dialog as environments,
// listed under Datasets after the workspace's own with the shared badge, and opened read-only (Save says where it is changed).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'another-workspace-with-a-dataset',
    `main:
      const { join } = require('node:path');
      const { mkdirSync, writeFileSync } = require('node:fs');
      const dir = join(home, 'platform-data', 'datasets');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, 'platform-data', 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'platform-data', name: 'Platform data' }));
      writeFileSync(join(dir, 'people.csv'), 'id,name\\n1,Ana\\n2,Bo\\n');
      return 'written';`,
    false,
  ],
  [
    'shared-with-the-kinds-it-has',
    `(async () => {
      const r = await window.aps.invoke('ws.shareAdd', { path: '../platform-data' });
      return 'kinds: ' + r.shared.map((s) => s.kinds.join(',')).join(' | ') + ' | datasets: ' + r.datasets.join(', ');
    })()`,
  ],
  [
    'listed-shared-and-opened-read-only',
    `(async () => {
      await __t.view('Collections'); await __t.sleep(900);
      const mark = await __t.waitFor(() => [...document.querySelectorAll('[data-shared="platform-data"]')].find((b) => b.offsetParent), 8000);
      if (!mark) { await window.aps.invoke('ws.shareRemove', { path: '../platform-data' }); return 'NO SHARED ROW'; }
      const row = mark.closest('[data-tree-row]') ?? mark.parentElement; row.scrollIntoView({ block: 'center' }); await __t.sleep(300); await __t.real.click(row);
      const note = await __t.waitFor(() => document.querySelector('[data-dataset-view] [data-shared-note]') ?? document.querySelector('[data-shared-note="platform-data"]'), 6000);
      const counts = await __t.waitFor(() => document.querySelector('[data-dataset-counts]')?.textContent.trim(), 6000);
      const fileTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === 'File');
      fileTab?.click(); await __t.sleep(300);
      const save = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Save');
      const after = await window.aps.invoke('ws.shareRemove', { path: '../platform-data' });
      return 'row: ' + mark.getAttribute('data-shared') + ' | note: ' + !!note + ' | counts: ' + counts + ' | save: ' + (save?.disabled ? 'disabled' : 'ENABLED') + ' | removed: ' + (after.datasets.length === 0);
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'shared-with-the-kinds-it-has': /^kinds: datasets \| datasets: \.\.\/platform-data\/datasets\/people\.csv$/,
  'listed-shared-and-opened-read-only': /^row: platform-data \| note: true \| counts: 2 rows · 2 columns \| save: disabled \| removed: true$/,
});
