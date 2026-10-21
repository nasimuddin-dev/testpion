// B-07: the Flow tab of a dataset-driven test file (one template, one test per dataset row when it runs). The canvas shows
// the template as ONE step, labelled with its dataset, and every edit made on the canvas (a drag, a change in the
// inspector, a new step) is written to that step: it used to list one step per row, ids no edit could find
// ("No step … in the flow"). The flow is written by the plan and calls the local demo server (127.0.0.1:4010).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepOf } = require('../lib.cjs');

const FILE = 'rest/dataset-flow.yaml';
const TEXT = ['name: Echo each row', 'type: http', 'method: GET', 'url: "http://127.0.0.1:4010/echo?q={{word}}"', 'dataset:', '  path: ../datasets/words.jsonl', 'assertions:', '  - { type: status, expected: 200 }', ''].join('\n');
const ROWS = ['{"id":"a","word":"alpha"}', '{"id":"b","word":"beta"}', '{"id":"c","word":"gamma"}', ''].join('\n');

const H = `
  const nodes = () => [...document.querySelectorAll('[data-flow-node]')];
  const flowOf = () => window.aps.invoke('tests.flow', { file: ${JSON.stringify(FILE)} });
  const openFlow = async () => {
    await __t.view('Tests'); await __t.sleep(800);
    const r = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('dataset-flow.yaml'));
    if (!r) return false;
    r.click(); await __t.sleep(1500);
    await __t.tab('Flow');
    return __t.waitFor(() => nodes().length || null, 8000);
  };
`;
const step = stepOf(H);

const REAL = `const { BrowserWindow } = require('electron'); const wc = BrowserWindow.getAllWindows()[0].webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code);
  const centre = (sel) => { const el = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const at = (sel) => js('(' + centre.toString() + ')(' + JSON.stringify(sel) + ')');
  const drag = async (p, q) => { wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await wait(30); wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); for (let i = 1; i <= 10; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + ((q.x - p.x) * i) / 10), y: Math.round(p.y + ((q.y - p.y) * i) / 10), button: 'left', modifiers: ['leftButtonDown'] }); await wait(20); } wc.sendInputEvent({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 1 }); };`;

const steps = [
  step(
    'one-node-for-all-rows',
    `if (!(await openFlow())) return 'NO NODES';
     const f = await flowOf();
     return 'nodes: ' + nodes().length + ' | steps: ' + f.steps.length + ' | loop: ' + f.steps[0].loop;`,
  ),
  ['real-drag-writes-the-step', `main:${REAL}
     const before = await js("window.aps.invoke('tests.flow', { file: '${FILE}' }).then((f) => f.steps[0].position ?? null)");
     const p = await at('[data-flow-designer] [data-flow-node] rect'); if (!p) return 'NO STEP';
     await drag(p, { x: p.x + 80, y: p.y + 50 }); await wait(1500);
     const after = await js("window.aps.invoke('tests.flow', { file: '${FILE}' }).then((f) => f.steps[0].position ?? null)");
     const toast = await js("[...document.querySelectorAll('[role=status], [role=alert]')].map((x) => x.textContent).join(' ')");
     return 'moved: ' + (!!after && (!before || after[0] > before[0])) + ' | error: ' + /No step/.test(toast);`],
  step(
    'inspector-edit-and-new-step',
    `const id = (await flowOf()).steps[0].id;
     const edit = (op) => window.aps.invoke('tests.flowEdit', { file: ${JSON.stringify(FILE)}, op }).then(() => 'ok', (e) => 'ERR ' + e.message);
     const a = await edit({ op: 'updateStep', id, set: { method: 'POST' } });
     const b = await edit({ op: 'addStep', step: { name: 'After the rows', type: 'http', url: 'http://127.0.0.1:4010/echo' }, after: id });
     await __t.view('Home');
     await openFlow();
     await __t.waitFor(() => nodes().length === 2, 6000);
     const f = await flowOf();
     const text = await window.aps.invoke('tests.read', { path: ${JSON.stringify(FILE)} });
     return 'update: ' + a + ' | add: ' + b + ' | steps: ' + f.steps.length + ' | dataset kept: ' + /dataset:/.test(text) + ' | nodes: ' + nodes().length;`,
  ),
  step(
    'every-row-still-runs',
    `const r = await window.aps.invoke('tests.run', { paths: [${JSON.stringify(FILE)}], name: 'Dataset flow' });
     const done = await __t.waitFor(async () => { const f = await flowOf(); return f.run && f.run.runId === r.runId && f.steps.every((s) => s.status) ? f : null; }, 30000);
     if (!done) return 'RUN DID NOT FINISH';
     const results = await window.aps.invoke('runs.results', { runId: r.runId }).catch(() => null);
     const rows = Array.isArray(results) ? results.filter((x) => /Echo each row \\[/.test(x.name)).length : (results?.items ?? []).filter((x) => /Echo each row \\[/.test(x.name)).length;
     return 'rows run: ' + rows + ' | step status: ' + done.steps[0].status;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'one-node-for-all-rows': /^nodes: 1 \| steps: 1 \| loop: × each row of \.\.\/datasets\/words\.jsonl$/,
    'real-drag-writes-the-step': /^moved: true \| error: false$/,
    'inspector-edit-and-new-step': /^update: ok \| add: ok \| steps: 2 \| dataset kept: true \| nodes: 2$/,
    'every-row-still-runs': /^rows run: 3 \| step status: (passed|failed)$/,
  },
  {
    prepare: (ws) => {
      mkdirSync(join(ws, 'tests', 'rest'), { recursive: true });
      mkdirSync(join(ws, 'tests', 'datasets'), { recursive: true });
      writeFileSync(join(ws, 'tests', FILE), TEXT);
      writeFileSync(join(ws, 'tests', 'datasets', 'words.jsonl'), ROWS);
    },
  },
);
