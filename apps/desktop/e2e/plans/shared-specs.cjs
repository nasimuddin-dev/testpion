// API definitions from another workspace (a sibling checkout or a git submodule): shared with the same dialog as
// environments, listed under API definitions after the workspace's own as "shared from …", and opened read-only (Save
// says where it is changed).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'another-workspace-with-a-definition',
    `main:
      const { join } = require('node:path');
      const { mkdirSync, writeFileSync } = require('node:fs');
      const dir = join(home, 'platform-specs', 'specs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, 'platform-specs', 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'platform-specs', name: 'Platform specs' }));
      writeFileSync(join(dir, 'platform.yaml'), 'openapi: 3.0.3\\ninfo: { title: Platform API, version: "1" }\\npaths:\\n  /users:\\n    get:\\n      responses: { "200": { description: ok } }\\n');
      return 'written';`,
    false,
  ],
  [
    'shared-with-the-kinds-it-has',
    `(async () => {
      const r = await window.aps.invoke('ws.shareAdd', { path: '../platform-specs' });
      return 'kinds: ' + r.shared.map((s) => s.kinds.join(',')).join(' | ') + ' | specs: ' + r.specs.join(', ');
    })()`,
  ],
  [
    'listed-shared-and-opened-read-only',
    `(async () => {
      await __t.view('Collections'); await __t.sleep(900);
      const mark = await __t.waitFor(() => [...document.querySelectorAll('[data-shared]')].find((b) => b.offsetParent), 8000);
      if (!mark) { await window.aps.invoke('ws.shareRemove', { path: '../platform-specs' }); return 'NO SHARED ROW'; }
      const row = mark.closest('[data-tree-row]') ?? mark.parentElement; row.scrollIntoView({ block: 'center' }); await __t.sleep(300); await __t.real.click(row);
      const note = await __t.waitFor(() => document.querySelector('[data-shared-note]'), 6000);
      const save = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Save');
      const after = await window.aps.invoke('ws.shareRemove', { path: '../platform-specs' });
      return 'row: ' + mark.getAttribute('data-shared') + ' | note: ' + !!note + ' | save: ' + (save?.disabled ? 'disabled' : 'ENABLED') + ' | removed: ' + (after.specs.length === 0);
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'shared-with-the-kinds-it-has': /^kinds: specs \| specs: \.\.\/platform-specs\/specs\/platform\.yaml$/,
  'listed-shared-and-opened-read-only': /^row: platform-specs \| note: true \| save: disabled \| removed: true$/,
});
