// The Flow tab of a test file: one node per step and an arrow per dependsOn, the nodes coloured by the latest run,
// a double-click on a node moves the editor to the step (a click selects it in the designer). The wheel zooms and Fit shows the whole flow again.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const FILE = 'rest/httpbin.yaml';
const H = `
  const editor = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
  const nodes = () => [...document.querySelectorAll('[data-flow-node]')];
  const edges = () => [...document.querySelectorAll('[data-flow-edge]')];
  const openFile = async (name) => { await __t.view('Tests'); await __t.sleep(800); const r = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)); if (!r) return false; r.click(); await __t.sleep(1500); return !!editor(); };
  const flowTab = async () => { await __t.tab('Flow'); return __t.waitFor(() => nodes().length ? nodes().length : null, 8000); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'nodes-and-edges',
    `if (!(await openFile('httpbin.yaml'))) return 'NO EDITOR';
     if (!(await flowTab())) return 'NO NODES';
     const ids = nodes().map((n) => n.dataset.flowNode);
     return 'nodes: ' + nodes().length + ' | edges: ' + edges().map((e) => e.dataset.flowEdge).join(',') + ' | problems: ' + !!document.querySelector('[data-flow-problems]') + ' | chained: ' + ids.includes('httpbin-chained');`,
  ),
  step(
    'wheel-zooms-fit-restores',
    `const svg = document.querySelector('[data-flow-diagram] svg'); const g = svg.querySelector('g[transform]');
     const before = g.getAttribute('transform');
     const r = svg.getBoundingClientRect();
     svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true }));
     await __t.sleep(300);
     const zoomed = g.getAttribute('transform');
     await __t.button('Fit'); await __t.sleep(300);
     return 'zoom changed: ' + (zoomed !== before) + ' | fit restores: ' + (g.getAttribute('transform') === before);`,
  ),
  step(
    'run-colours-the-nodes',
    `if (!(await __t.button('Run'))) return 'NO RUN BUTTON';
     // the run opens the Runs tab; the diagram reads the finished run when the tab comes back
     const done = await __t.waitFor(async () => { const f = await window.aps.invoke('tests.flow', { file: ${JSON.stringify(FILE)} }); return f.run && f.steps.every((s) => s.status) ? f : null; }, 90000);
     if (!done) return 'RUN DID NOT FINISH';
     if (!(await flowTab())) return 'NO NODES';
     await __t.waitFor(() => nodes().every((n) => n.dataset.status) ? true : null, 5000);
     const statuses = nodes().map((n) => n.dataset.status).filter(Boolean);
     return 'with status: ' + statuses.length + '/' + nodes().length + ' | results shown: ' + document.querySelectorAll('[data-flow-result]').length;`,
  ),
  step(
    'click-moves-the-editor',
    `const n = nodes().find((x) => x.dataset.flowNode === 'httpbin-chained'); if (!n) return 'NO NODE';
     // the Flow tab is the designer: a click selects the step, a double-click opens it in the editor
     n.dispatchEvent(new MouseEvent('click', { bubbles: true })); n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(1500);
     const ed = editor(); if (!ed) return 'NO EDITOR';
     const line = ed.getPosition().lineNumber;
     const text = ed.getModel().getLineContent(line).trim();
     const active = document.querySelector('main [role=tab][data-tab-id^="file:"]')?.getAttribute('aria-selected');
     return 'line: ' + line + ' | text: ' + text + ' | tab: ' + active;`,
  ),
  step(
    'result-selected-in-runs',
    `document.querySelector('main [role=tab][data-tab-id="run"]')?.click(); await __t.sleep(1500);
     const picked = [...document.querySelectorAll('main button')].find((x) => x.classList.contains('bg-accent/10') && x.textContent.includes('A later test uses an extracted value'));
     return 'result shown: ' + !!picked;`,
  ),
];

module.exports = withExpect(steps, {
  'nodes-and-edges': /^nodes: 4 \| edges: httpbin-post>httpbin-chained \| problems: false \| chained: true$/,
  'wheel-zooms-fit-restores': /^zoom changed: true \| fit restores: true$/,
  'run-colours-the-nodes': /^with status: 4\/4 \| results shown: 4$/,
  'click-moves-the-editor': /^line: 27 \| text: name: A later test uses an extracted value \| tab: true$/,
  'result-selected-in-runs': /^result shown: true$/,
});
