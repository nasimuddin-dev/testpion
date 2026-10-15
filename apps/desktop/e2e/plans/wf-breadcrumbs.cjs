// WF-11 A breadcrumb and Reveal in sidebar in every item view: a request's folder segment shows the folder in the
// tree; switching tabs makes the tree follow; a tab's right-click has Reveal in sidebar; monitors, datasets and API
// definitions have the same breadcrumb line.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const req = (id, name) => ({ kind: 'http', id, name, request: { method: 'GET', url: `http://127.0.0.1:4010/health?${id}`, headers: [] } });
  const items = [
    { kind: 'folder', id: 'bc-f1', name: 'E2E crumbs folder', items: [{ kind: 'folder', id: 'bc-f2', name: 'E2E crumbs inner', items: [req('bc-1', 'E2E crumbs deep')] }] },
    req('bc-2', 'E2E crumbs top'),
  ];
  writeFileSync(
    join(ws, 'collections', 'e2e-crumbs.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-crumbs', name: 'E2E crumbs', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

const H = `
  const crumbs = (label) => [...(document.querySelector('main nav[aria-label="' + label + '"]')?.querySelectorAll('button, span[data-crumb-item]') ?? [])].map((b) => b.textContent.trim()).filter(Boolean);
  const row = (t) => [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.querySelector('.truncate')?.textContent.trim() === t);
  const fold = (t) => { const r = row(t); if (r && r.getAttribute('aria-expanded') === 'true') r.click(); };
  const reqTab = (t) => [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].find((x) => x.textContent.includes(t));
`;

const steps = [
  step(
    'request-crumbs',
    `${H}
     await __t.requests(); await __t.expand('E2E crumbs'); await __t.expand('E2E crumbs folder'); await __t.expand('E2E crumbs inner');
     const r = await __t.open('E2E crumbs deep'); if (r !== 'ok') return r;
     return crumbs('Where this request is saved').join(' › ');`,
  ),
  step(
    'folder-segment-reveals',
    `${H}
     fold('E2E crumbs inner'); fold('E2E crumbs folder'); fold('E2E crumbs'); await __t.sleep(400);
     const hidden = !row('E2E crumbs deep');
     const seg = [...document.querySelectorAll('main nav[aria-label="Where this request is saved"] button')].find((b) => b.textContent.trim() === 'E2E crumbs inner');
     if (!seg) return 'NO SEGMENT';
     seg.click();
     await __t.waitFor(() => row('E2E crumbs inner'), 3000);
     return 'hidden first: ' + hidden + ' | folder shown: ' + !!row('E2E crumbs inner') + ' | still on the request: ' + /E2E crumbs deep/.test(crumbs('Where this request is saved').join(' '));`,
  ),
  step(
    'tab-switch-follows',
    `${H}
     await __t.expand('E2E crumbs'); const r = await __t.open('E2E crumbs top'); if (r !== 'ok') return r;
     fold('E2E crumbs inner'); fold('E2E crumbs folder'); fold('E2E crumbs'); await __t.sleep(400);
     const deep = reqTab('E2E crumbs deep'); if (!deep) return 'NO TAB';
     deep.click();
     await __t.waitFor(() => row('E2E crumbs deep'), 3000);
     return 'tree shows the tab: ' + !!row('E2E crumbs deep');`,
  ),
  step('tab-menu-reveal', `const menu = await __t.tabMenu(); return /Reveal in sidebar/.test(menu) ? 'has Reveal in sidebar' : menu;`),
  step(
    'monitor-crumbs',
    `${H}
     await __t.view('Monitors'); await __t.sleep(800);
     const first = document.querySelector('main [data-tree-row], main [role=listitem] button, aside [data-tree-row]');
     const nav = await __t.waitFor(() => document.querySelector('main nav[aria-label="Where this monitor is"]'), 1500);
     if (!nav) { first?.click(); await __t.sleep(800); }
     const n = document.querySelector('main nav[aria-label="Where this monitor is"]');
     return n ? 'monitor: ' + crumbs('Where this monitor is')[0] : 'NO MONITOR CRUMB';`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'request-crumbs': /^E2E crumbs › E2E crumbs folder › E2E crumbs inner › E2E crumbs deep$/,
    'folder-segment-reveals': /^hidden first: true \| folder shown: true \| still on the request: true$/,
    'tab-switch-follows': /^tree shows the tab: true$/,
    'tab-menu-reveal': /^has Reveal in sidebar$/,
    'monitor-crumbs': /^monitor: Monitors$/,
  },
  { prepare },
);
