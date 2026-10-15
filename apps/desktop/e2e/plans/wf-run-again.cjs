// WF-08 Run result ↔ source: Rerun last run (Ctrl+Shift+R, the palette) runs the latest run again as it ran and
// opens the new run; the Collection runner's requests open in their editor.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const items = [{ kind: 'http', id: 'again-1', name: 'E2E again health', request: { method: 'GET', url: 'http://127.0.0.1:4010/health?again=1', headers: [] } }];
  writeFileSync(
    join(ws, 'collections', 'e2e-again.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-again', name: 'E2E again', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

const steps = [
  step(
    'rerun-last',
    `// waitFor checks its function's answer as is: an async one is polled here
     const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(200)) { const v = await fn(); if (v) return v; } };
     const first = await window.aps.invoke('col.run', { collectionId: 'e2e-again' });
     await until(async () => (await window.aps.invoke('runs.list', { limit: 5 })).items.some((r) => r.id === first.runId), 10000);
     const before = (await window.aps.invoke('runs.list', { limit: 5 })).items.map((r) => r.id);
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', ctrlKey: true, shiftKey: true, bubbles: true }));
     const next = await until(async () => (await window.aps.invoke('runs.list', { limit: 5 })).items.find((r) => !before.includes(r.id)), 10000);
     await __t.sleep(800);
     return 'new run: ' + !!next + ' | same name: ' + (next?.name === 'E2E again') + ' | view: ' + localStorage.getItem('aps.view');`,
  ),
  step(
    'runner-row-opens-request',
    `await __t.requests();
     const r = await __t.menu('E2E again'); if (/NO /.test(r)) return r;
     [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Run collection')?.click(); await __t.sleep(1500);
     const link = await __t.waitFor(() => vis('main [data-ref-link="request"]').find((a) => a.textContent.trim() === 'E2E again health'), 5000);
     if (!link) return 'NO LINK';
     link.click();
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'rest', 5000);
     return 'view: ' + localStorage.getItem('aps.view');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'rerun-last': /^new run: true \| same name: true \| view: tests$/,
    'runner-row-opens-request': /^view: rest$/,
  },
  { prepare },
);
