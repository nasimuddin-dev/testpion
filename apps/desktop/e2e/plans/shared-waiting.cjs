// A `shared` entry of workspace.json changed by a pull (here: more kinds) waits: the Environments list says so with
// "Allow on this computer", nothing of that folder's new kinds is read until then, and Allow reads it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'another-workspace-and-an-entry-added-here',
    `main:
      const { join } = require('node:path');
      const { mkdirSync, writeFileSync } = require('node:fs');
      const base = join(home, 'platform-waits');
      mkdirSync(join(base, 'environments'), { recursive: true });
      mkdirSync(join(base, 'specs'), { recursive: true });
      writeFileSync(join(base, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'platform-waits', name: 'Platform waits' }));
      writeFileSync(join(base, 'environments', 'pw.json'), JSON.stringify({ id: 'pw', name: 'Waits staging', variables: [] }));
      writeFileSync(join(base, 'specs', 'pw.yaml'), 'openapi: 3.0.3\\ninfo: { title: W, version: "1" }\\npaths: {}\\n');
      return 'written';`,
    false,
  ],
  [
    'added-in-the-app-is-read',
    `(async () => {
      const r = await window.aps.invoke('ws.shareAdd', { path: '../platform-waits', kinds: ['environments'] });
      return 'waiting: ' + r.waiting.length + ' | environments: ' + r.environments.map((e) => e.name).join(', ');
    })()`,
  ],
  [
    'a-pull-adds-a-kind',
    `main:
      const { join } = require('node:path');
      const { readdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
      let changed = 0;
      for (const d of readdirSync(home)) {
        const f = join(home, d, 'workspace.json');
        if (!existsSync(f)) continue;
        const ws = JSON.parse(readFileSync(f, 'utf8'));
        const e = (ws.shared || []).find((s) => s.path === '../platform-waits');
        if (!e) continue;
        e.kinds = ['environments', 'specs'];
        writeFileSync(f, JSON.stringify(ws, null, 2));
        changed++;
      }
      return 'changed ' + changed;`,
    false,
  ],
  [
    'the-list-says-it-waits-and-allow-reads-it',
    `(async () => {
      await __t.view('Environments');
      const notice = await __t.waitFor(() => [...document.querySelectorAll('[data-shared-waiting]')].find((n) => n.offsetParent), 10000);
      if (!notice) { await window.aps.invoke('ws.shareRemove', { path: '../platform-waits' }); return 'NO NOTICE | waiting: ' + (await window.aps.invoke('ws.shareWaiting')).length; }
      const specsBefore = (await window.aps.invoke('openapi.specs', {})).filter((s) => s.includes('platform-waits')).length;
      const allow = [...notice.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow on this computer');
      allow.click();
      const gone = await __t.waitFor(() => ![...document.querySelectorAll('[data-shared-waiting]')].some((n) => n.offsetParent), 6000);
      const specsAfter = (await window.aps.invoke('openapi.specs', {})).filter((s) => s.includes('platform-waits')).length;
      await window.aps.invoke('ws.shareRemove', { path: '../platform-waits' });
      return 'notice: ' + /from \\.\\.\\/platform-waits/.test(notice.textContent) + ' | specs before: ' + specsBefore + ' | gone: ' + !!gone + ' | specs after: ' + specsAfter;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'added-in-the-app-is-read': /^waiting: 0 \| environments: Waits staging$/,
  'the-list-says-it-waits-and-allow-reads-it': /^notice: true \| specs before: 0 \| gone: true \| specs after: 1$/,
});
