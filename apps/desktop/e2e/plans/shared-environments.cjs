// Environments from another workspace (a sibling checkout or a git submodule): added in the Environments view's section
// menu (or `testpion workspace share`), they are listed after the workspace's own with a "shared" badge, and their editor
// says where they are changed, with Save off.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'another-workspace-next-to-this-one',
    `main:
      const { join } = require('node:path');
      const { mkdirSync, writeFileSync } = require('node:fs');
      const dir = join(home, 'platform-shared', 'environments');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'platform-staging.json'), JSON.stringify({ id: 'platform-staging', name: 'Platform staging', variables: [{ key: 'baseUrl', value: 'https://staging.example.com' }] }));
      return 'written';`,
    false,
  ],
  [
    'shared-from-the-dialog-api',
    `(async () => {
      const r = await window.aps.invoke('ws.shareAdd', { path: '../platform-shared' });
      return 'shared: ' + r.shared.map((s) => s.path + ' [' + s.kinds.join(',') + ']').join(' | ') + ' | gives: ' + r.environments.map((e) => e.name + ' from ' + e.from).join(', ');
    })()`,
  ],
  [
    'listed-with-a-badge-and-read-only',
    `(async () => {
      await __t.view('Environments'); await __t.sleep(900);
      const badge = await __t.waitFor(() => [...document.querySelectorAll('[data-env-shared]')].find((b) => b.offsetParent), 8000); if (!badge) return 'NO SHARED BADGE';
      const row = badge.closest('[data-tree-row]') ?? badge.parentElement; await __t.real.click(row); await __t.sleep(900);
      const note = await __t.waitFor(() => document.querySelector('[data-env-shared-note]'), 5000);
      const save = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Save');
      const after = await window.aps.invoke('ws.shareRemove', { path: '../platform-shared' });
      return 'badge: ' + badge.getAttribute('data-env-shared') + ' | note: ' + !!note + ' | save off: ' + !!save?.disabled + ' | why: ' + save?.title + ' | removed: ' + (after.shared.length === 0);
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'shared-from-the-dialog-api': /^shared: \.\.\/platform-shared \[environments\] \| gives: Platform staging from platform-shared$/,
  'listed-with-a-badge-and-read-only': /^badge: platform-shared \| note: true \| save off: true \| why: Shared from platform-shared: change it in that workspace \| removed: true$/,
});
