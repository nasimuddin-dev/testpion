// WF-09 Run → CI in one click: a run's ⋯ (the Collection runner's header) copies the CLI command that runs it again
// and opens Run in CI preselected with its collection and environment; the copied command matches the run.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const items = [
    { kind: 'http', id: 'ci-1', name: 'E2E ci health', request: { method: 'GET', url: 'http://127.0.0.1:4010/health?ci=1', headers: [] } },
    { kind: 'http', id: 'ci-2', name: 'E2E ci other', request: { method: 'GET', url: 'http://127.0.0.1:4010/health?ci=2', headers: [] } },
  ];
  writeFileSync(
    join(ws, 'collections', 'e2e-ci.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-ci', name: 'E2E ci', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
  // a production environment: the dialog offers --allow-production for any target (a collection here)
  writeFileSync(join(ws, 'environments', 'e2e-ci-prod.json'), JSON.stringify({ id: 'e2e-ci-prod', name: 'E2E CI Prod', isProduction: true, variables: [] }, null, 2));
}

const H = `
  const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(200)) { const v = await fn(); if (v) return v; } };
  const press = (b) => { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); };
  const item = (label) => __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label), 3000);
  const more = () => document.querySelector('main button[aria-label="Run actions"]');
`;

const steps = [
  step(
    'copy-cli-command',
    `${H}
     const r = await window.aps.invoke('col.run', { collectionId: 'e2e-ci', selection: ['ci-2'], environment: 'Public APIs' });
     await until(async () => (await window.aps.invoke('runs.list', { limit: 5 })).items.some((x) => x.id === r.runId), 15000);
     await __t.requests();
     const m = await __t.menu('E2E ci'); if (/NO /.test(m)) return m;
     (await item('Run collection'))?.click();
     const pick = await __t.waitFor(() => { const s = document.querySelector('main select[aria-label="Previous runs"]'); return s && [...s.options].some((o) => o.value === r.runId) ? s : undefined; }, 8000);
     if (!pick) return 'NO RUN IN THE LIST';
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(pick, r.runId); pick.dispatchEvent(new Event('change', { bubbles: true }));
     const b = await __t.waitFor(more, 4000); if (!b) return 'NO MENU BUTTON';
     press(b); (await item('Copy CLI command'))?.click(); await __t.sleep(600);
     let text = ''; try { text = await navigator.clipboard.readText(); } catch { text = '(unreadable)'; }
     return text.replace(/-w \\S+|-w "[^"]+"/, '-w <ws>');`,
  ),
  step(
    'run-in-ci',
    `${H}
     press(more()); (await item('Run in CI…'))?.click();
     const dlg = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /Run in CI/.test(d.textContent)), 4000); if (!dlg) return 'NO DIALOG';
     const local = await __t.waitFor(() => [...dlg.querySelectorAll('pre, code')].map((x) => x.textContent).find((t) => /run-collection/.test(t)), 5000);
     await __t.esc();
     return 'pipeline runs: ' + (local ?? 'NONE').replace(/-w \\S+|-w "[^"]+"/, '-w <ws>').trim();`,
  ),
  // a production environment: the dialog offers --allow-production for any target (a collection here), not only a flow
  step(
    'allow-production-any-target',
    `${H}
     press(more()); (await item('Run in CI…'))?.click();
     const dlg = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /Run in CI/.test(d.textContent)), 4000); if (!dlg) return 'NO DIALOG';
     const before = !!dlg.querySelector('[data-ci-allow-production]');
     const env = [...dlg.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'E2E CI Prod')); if (!env) return 'NO ENV SELECT';
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(env, 'E2E CI Prod'); env.dispatchEvent(new Event('change', { bubbles: true }));
     const box = await __t.waitFor(() => dlg.querySelector('[data-ci-allow-production]'), 3000); if (!box) return 'NO CHECKBOX for a collection';
     box.click();
     const local = await __t.waitFor(() => [...dlg.querySelectorAll('pre, code')].map((x) => x.textContent).find((t) => /run-collection.*--allow-production/.test(t)), 5000);
     await __t.esc();
     return 'box before: ' + before + ' | ' + (local ? 'run line has --allow-production' : 'NOT ON THE RUN LINE');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'copy-cli-command': /^testpion run-collection e2e-ci -w <ws> -e "Public APIs" --folder ci-2 -r console junit html -o test-results$/,
    'run-in-ci': /^pipeline runs: testpion run-collection e2e-ci -w <ws> -e "Public APIs" --folder ci-2 /,
    'allow-production-any-target': /^box before: false \| run line has --allow-production$/,
  },
  { prepare },
);
