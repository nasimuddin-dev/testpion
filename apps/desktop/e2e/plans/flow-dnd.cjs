// Build a flow by drag and drop, with real input (Chromium's own drag: dragstart in the page, the drag carried and
// dropped through the DevTools protocol): a saved request from the explorer onto the empty canvas, a second one onto the
// first (it then waits for it), a Delay block from the palette onto the connection between them (inserted), a folder
// (its requests chained in order), one Undo for the whole folder; then the CLI runs the drag-built file as CI would.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const FILE = 'rest/dnd-flow.yaml';
const API = 'http://127.0.0.1:4010';
const http = (id, name, method, url, status = 200) => ({ kind: 'http', id, name, request: { method, url, headers: [], params: [] }, assertions: [{ type: 'status', expected: status }] });
function prepare(ws) {
  mkdirSync(join(ws, 'collections'), { recursive: true });
  writeFileSync(
    join(ws, 'collections', 'local-demo.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'local-demo',
        name: 'Local demo',
        variables: [],
        items: [
          http('demo-health', 'Health', 'GET', `${API}/health`),
          http('demo-echo', 'Echo', 'GET', `${API}/echo?from=drop`),
          { kind: 'folder', id: 'demo-jobs', name: 'Jobs', items: [http('demo-start', 'Start a job', 'POST', `${API}/jobs`, 201), http('demo-read', 'Read the job', 'GET', `${API}/jobs/job-1`)] },
        ],
      },
      null,
      2,
    ),
  );
  mkdirSync(join(ws, 'tests', 'rest'), { recursive: true });
  writeFileSync(join(ws, 'tests', FILE), 'name: DnD flow\ntests: []\n');
}

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const row = (name) => [...document.querySelectorAll('aside[aria-label="Collections explorer"] [data-tree-row]')].find((b) => b.offsetParent && (b.textContent.trim().endsWith(name) || b.querySelector('.truncate')?.textContent.trim() === name));
  const flow = () => window.aps.invoke('tests.flow', { file: ${JSON.stringify(FILE)} });
  const until = async (fn, ms = 6000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(150)) { const v = await fn(); if (v) return v; } return undefined; };
  const deps = (f, id) => (f.steps.find((s) => s.id === id)?.dependsOn ?? []).join(',');
  /** The middle of a connection, on screen. */
  const edgeMid = (key) => { const p = document.querySelector('[data-flow-designer] [data-flow-edge-hit="' + key + '"]'); if (!p) return null; const m = p.getPointAtLength(p.getTotalLength() / 2); const pt = new DOMPoint(m.x, m.y).matrixTransform(p.getScreenCTM()); return { x: pt.x, y: pt.y }; };
`;
const step = stepOf(H);

const steps = [
  step(
    'open-the-flow-and-the-explorer',
    `await __t.view('Tests'); await __t.sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('dnd-flow.yaml')), 4000); if (!r) return 'NO FILE ROW';
     r.click(); await __t.sleep(1200); await __t.tab('Flow');
     if (!(await __t.waitFor(() => document.querySelector('[data-flow-designer] [data-flow-start]'), 6000))) return 'NO DESIGNER';
     await __t.real.key('b', { ctrl: true }); await __t.sleep(800); // Ctrl+B: the explorer beside the Tests view
     await __t.expand('Local demo'); await __t.expand('Jobs');
     return 'explorer: ' + !!row('Health') + ' | folder: ' + !!row('Jobs');`,
  ),
  step(
    'drag-a-request-onto-the-empty-canvas',
    `const r = await __t.real.dnd(row('Health'), { x: svg().getBoundingClientRect().left + svg().getBoundingClientRect().width * 0.6, y: svg().getBoundingClientRect().top + svg().getBoundingClientRect().height * 0.5 });
     if (r !== 'ok') return 'DND: ' + r;
     if (!(await __t.waitFor(() => nodes().length === 1, 6000))) return 'NO STEP: ' + nodes().length;
     return 'step: ' + nodes()[0].dataset.flowNode;`,
  ),
  step(
    'drag-a-second-request-onto-the-first',
    `const r = await __t.real.dnd(row('Echo'), byId('health').querySelector('rect')); if (r !== 'ok') return 'DND: ' + r;
     if (!(await __t.waitFor(() => nodes().length === 2, 6000))) return 'NO SECOND STEP';
     const f = await flow();
     return 'echo waits for: ' + deps(f, 'echo');`,
  ),
  step(
    'drag-a-block-onto-the-connection',
    `const tab = vis('[data-pinnable-panel="flow.blocks"] button[aria-expanded]')[0];
     if (tab && tab.getAttribute('aria-expanded') === 'false') { await __t.real.move(tab); await __t.sleep(600); }
     const block = await __t.waitFor(() => vis('[data-flow-palette-block="delay"]')[0], 3000); if (!block) return 'NO PALETTE';
     const mid = edgeMid('health>echo'); if (!mid) return 'NO EDGE';
     const r = await __t.real.dnd(block, mid); if (r !== 'ok') return 'DND: ' + r;
     const f = await until(async () => { const x = await flow(); return x.steps.length === 3 ? x : null; }); if (!f) return 'NOT INSERTED';
     const wait = f.steps.find((s) => s.type === 'delay');
     return 'delay waits for: ' + deps(f, wait.id) + ' | echo waits for: ' + (deps(f, 'echo') === wait.id ? 'the delay' : deps(f, 'echo'));`,
  ),
  step(
    'drag-a-folder-chains-its-requests',
    `const r = await __t.real.dnd(row('Jobs'), byId('echo').querySelector('rect')); if (r !== 'ok') return 'DND: ' + r;
     const f = await until(async () => { const x = await flow(); return x.steps.length === 5 ? x : null; }); if (!f) return 'NO FOLDER STEPS';
     const start = f.steps.find((s) => s.name === 'Start a job');
     const read = f.steps.find((s) => s.name === 'Read the job');
     return 'start waits for: ' + deps(f, start.id) + ' | read waits for start: ' + (deps(f, read.id) === start.id);`,
  ),
  step(
    'one-undo-takes-the-whole-drop-back',
    `// Ctrl+Z on the canvas (the toolbar may have folded Undo into its menu beside the explorer)
     const canvas = document.querySelector('[data-flow-designer] [data-flow-diagram]'); canvas.focus();
     await __t.real.key('z', { ctrl: true });
     const back = await until(async () => ((await flow()).steps.length === 3 ? true : null)); if (!back) return 'NOT UNDONE';
     canvas.focus(); await __t.real.key('y', { ctrl: true });
     const again = await until(async () => ((await flow()).steps.length === 5 ? true : null));
     return 'undone: true | redone: ' + !!again;`,
  ),
  [
    'the-cli-runs-it-as-ci-would',
    `main:const { spawnSync } = require('child_process'); const path = require('path'); const fs = require('fs');
     const root = path.resolve(process.env.E2E_PLAN, '..', '..', '..', '..', '..');
     const cli = path.join(root, 'packages', 'cli', 'bin', 'testpion.js');
     const out = path.join(process.env.E2E_OUT, 'ci-results');
     // the installed app has the RunAsNode fuse off (it cannot be turned into a Node.js): its CLI check runs on the system node
     const installed = /testpion\.exe$/i.test(process.execPath);
     const r = spawnSync(installed ? 'node' : process.execPath, [cli, 'test', 'tests/${FILE}', '-w', path.join(home, 'ws'), '-r', 'junit', '-o', out], { cwd: path.join(home, 'ws'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120000 });
     const junit = fs.existsSync(out) ? fs.readdirSync(out).find((f) => f.endsWith('.xml')) : undefined;
     return 'exit: ' + r.status + ' | junit: ' + !!junit + (r.status ? ' | ' + String(r.stdout + r.stderr).slice(-400) : '');`,
    false,
  ],
];

module.exports = withExpect(
  steps,
  {
    'open-the-flow-and-the-explorer': /^explorer: true \| folder: true$/,
    'drag-a-request-onto-the-empty-canvas': /^step: health$/,
    'drag-a-second-request-onto-the-first': /^echo waits for: health$/,
    'drag-a-block-onto-the-connection': /^delay waits for: health \| echo waits for: the delay$/,
    'drag-a-folder-chains-its-requests': /^start waits for: echo \| read waits for start: true$/,
    'one-undo-takes-the-whole-drop-back': /^undone: true \| redone: true$/,
    'the-cli-runs-it-as-ci-would': /^exit: 0 \| junit: true$/,
  },
  { prepare },
);
