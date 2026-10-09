// The flow debugger in the designer: a 3-step flow against the demo server (127.0.0.1:4010/health) is run; History
// lists the run and selecting it colours the canvas; a breakpoint on step 2 and Debug pause there, a variable edited at
// the pause reaches step 3's request after Continue; Run from here on step 3 runs only it; step 1's response is pinned
// and the next run answers it from the pin; a run made to fail is replayed on its own data after the fix.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const FILE = 'rest/debug-flow.yaml';
const TEXT = [
  'name: Debug flow',
  'tests:',
  '  - { id: first, name: First, url: "http://127.0.0.1:4010/health", extract: { who: "$.status" }, assertions: [{ type: status, expected: 200 }] }',
  '  - { id: second, name: Second, url: "http://127.0.0.1:4010/health?step=2", dependsOn: [first], assertions: [{ type: status, expected: 200 }] }',
  '  - { id: third, name: Third, url: "http://127.0.0.1:4010/health?who={{who}}", dependsOn: [second], assertions: [{ type: status, expected: 200 }] }',
  '',
].join('\n');
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const byId = (id) => nodes().find((n) => n.dataset.flowNode === id);
  const statuses = () => ['first', 'second', 'third'].map((id) => id + '=' + (byId(id)?.dataset.status ?? '-')).join(',');
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const settled = (ids) => __t.waitFor(() => ids.every((id) => byId(id) && ['passed', 'failed', 'error', 'skipped'].includes(byId(id).dataset.status)) ? true : null, 30000);
  const runs = () => window.aps.invoke('tests.flowRuns', { file: ${JSON.stringify(FILE)} }).then((r) => r.runs);
  const stepMenu = async (id, label) => {
    const n = byId(id); if (!n) return 'NO NODE ' + id;
    const r = n.querySelector('rect').getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20, button: 2 }));
    const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith(label)), 3000);
    if (!item) return 'NO MENU ITEM ' + label + ': ' + vis('[role=menuitem]').map((m) => m.textContent.trim()).join('/');
    item.click(); await __t.sleep(300);
    return '';
  };
  const select = async (id) => { const n = byId(id); if (!n) return null; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); await __t.sleep(300); return true; };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'run-a-three-step-flow',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: ${JSON.stringify(TEXT)} });
     await __t.view('Tests'); await __t.sleep(800);
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('debug-flow.yaml')), 4000);
     if (!row) return 'NO ROW'; row.click(); await __t.sleep(1200);
     await __t.tab('Flow');
     if (!(await __t.waitFor(() => byId('third'), 6000))) return 'NO DESIGNER';
     if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     if (!(await settled(['first', 'second', 'third']))) return 'NOT SETTLED: ' + statuses();
     await __t.sleep(1000);
     return statuses();`,
  ),
  step(
    'history-shows-the-run',
    `const t = vis('[data-flow-history-toggle]')[0]; if (!t) return 'NO HISTORY BUTTON'; t.click();
     const row = await __t.waitFor(() => vis('[data-flow-history-run]')[0], 5000); if (!row) return 'NO RUNS';
     row.click();
     const view = await __t.waitFor(() => vis('[data-flow-run-view]')[0], 5000); if (!view) return 'NO RUN VIEW';
     const timeline = vis('[data-variables-timeline]')[0];
     return 'run: ' + row.dataset.status + ' | ' + statuses() + ' | timeline has who: ' + !!timeline?.querySelector('[data-var-row="who"]');`,
  ),
  step(
    'breakpoint-pauses-the-debug-run',
    `let e = await stepMenu('second', 'Add breakpoint'); if (e) return e;
     if (!(await until(() => byId('second')?.dataset.breakpoint === 'true', 3000))) return 'NO BREAKPOINT MARK';
     const d = vis('[data-flow-debug]')[0]; if (!d) return 'NO DEBUG BUTTON'; d.click();
     const panel = await __t.waitFor(() => vis('[data-flow-paused-panel="second"]')[0], 15000);
     if (!panel) return 'NOT PAUSED: ' + statuses();
     await until(() => byId('first')?.dataset.status === 'passed', 3000);
     const who = panel.querySelector('input[aria-label="Value of who"]');
     return 'paused at: ' + panel.dataset.flowPausedPanel + ' | node paused: ' + (byId('second').dataset.paused === 'true') + ' | first: ' + byId('first').dataset.status + ' | who: ' + (who ? who.value : 'NO FIELD');`,
  ),
  step(
    'edit-a-variable-and-continue',
    `const who = vis('[data-flow-paused-panel] input[aria-label="Value of who"]')[0]; if (!who) return 'NO FIELD';
     setInput(who, 'Ada'); await __t.sleep(200);
     vis('[data-flow-continue]')[0].click();
     if (!(await until(() => !vis('[data-flow-paused-panel]').length, 5000))) return 'STILL PAUSED';
     if (!(await settled(['first', 'second', 'third']))) return 'NOT SETTLED: ' + statuses();
     await __t.sleep(1500);
     const latest = (await runs())[0];
     const r = await window.aps.invoke('tests.flowRunResults', { file: ${JSON.stringify(FILE)}, runId: latest.runId });
     const third = r.results.find((x) => x.id === 'third');
     // the run in the history panel: select it and the third step, its request in the inspector
     const row = await __t.waitFor(() => vis('[data-flow-history-run="' + latest.runId + '"]')[0], 5000);
     if (row) { row.click(); await __t.sleep(800); }
     await select('third');
     const shown = await __t.waitFor(() => vis('[data-flow-run-result="third"]')[0]?.textContent.includes('who=Ada') ? true : null, 5000);
     return 'run: ' + latest.status + ' | ' + statuses() + ' | third request: ' + (third?.input ?? '').replace(/^.*\\?/, '?') + ' | in the inspector: ' + !!shown;`,
  ),
  step(
    'run-from-here-on-step-three',
    `// back to the latest results, then Run from here on the third step: only it runs, seeded from the debug run
     vis('[data-flow-history] button').find((b) => b.textContent.trim() === 'Back to latest')?.click(); await __t.sleep(300);
     const before = (await runs()).length;
     const e = await stepMenu('third', 'Run from here'); if (e) return e;
     const done = await until(async () => { const r = await runs(); return r.length > before ? r[0] : null; }, 20000);
     if (!done) return 'NO NEW RUN';
     const r = await window.aps.invoke('tests.flowRunResults', { file: ${JSON.stringify(FILE)}, runId: done.runId });
     return 'steps run: ' + r.results.map((x) => x.id + '=' + x.status).join(',') + ' | seeded who: ' + (r.results[0]?.input ?? '').includes('who=Ada') + ' | name: ' + /from third/.test(done.name ?? '');`,
  ),
  step(
    'pin-step-one-and-run',
    `const e = await stepMenu('first', 'Pin last response'); if (e) return e;
     if (!(await until(() => byId('first')?.dataset.pinned === 'true', 4000))) return 'NO PIN MARK';
     const state = await window.aps.invoke('tests.flowState', { file: ${JSON.stringify(FILE)} });
     const yaml = await window.aps.invoke('tests.read', { path: ${JSON.stringify(FILE)} });
     if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     if (!(await settled(['first', 'second', 'third']))) return 'NOT SETTLED: ' + statuses();
     const label = await until(() => { const t = byId('first')?.querySelector('[data-flow-result]')?.textContent ?? ''; return t.includes('pinned') ? t : null; }, 4000);
     await __t.sleep(1000);
     const latest = (await runs())[0];
     const r = await window.aps.invoke('tests.flowRunResults', { file: ${JSON.stringify(FILE)}, runId: latest.runId });
     return 'pinned status: ' + state.pins.first?.status + ' | not in the YAML: ' + !yaml.includes('pin') + ' | node: ' + label + ' | result pinned: ' + (r.results.find((x) => x.id === 'first')?.metadata?.pinned === true) + ' | ' + statuses();`,
  ),
  step(
    'replay-a-failed-run',
    `// the second step made to fail (404), the flow run, the step fixed, then the failed run replayed on its data
     const edit = (url) => window.aps.invoke('tests.flowEdit', { file: ${JSON.stringify(FILE)}, op: { op: 'updateStep', id: 'second', set: { url } } });
     await edit('http://127.0.0.1:4010/nope-404');
     await __t.sleep(800);
     if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     const failed = await until(async () => { const r = await runs(); return r[0]?.status === 'failed' ? r[0] : null; }, 20000);
     if (!failed) return 'NO FAILED RUN: ' + JSON.stringify((await runs())[0]);
     await edit('http://127.0.0.1:4010/health?step=2');
     await __t.sleep(800);
     const replay = await __t.waitFor(() => vis('[data-flow-replay="' + failed.runId + '"]')[0], 8000);
     if (!replay) return 'NO REPLAY BUTTON';
     replay.click();
     const done = await until(async () => { const r = await runs(); return r[0] && r[0].runId !== failed.runId && r[0].status !== 'failed' ? r[0] : null; }, 20000);
     if (!done) return 'NO REPLAY RUN';
     const r = await window.aps.invoke('tests.flowRunResults', { file: ${JSON.stringify(FILE)}, runId: done.runId });
     return 'failed at: ' + failed.firstFailed + ' | replay: ' + done.status + ' | steps run: ' + r.results.map((x) => x.id + '=' + x.status).join(',') + ' | name: ' + /replay of/.test(done.name);`,
  ),
  step(
    'clean-up',
    `await window.aps.invoke('tests.flowUnpin', { file: ${JSON.stringify(FILE)}, stepId: 'first' });
     await window.aps.invoke('tests.flowBreakpoints', { file: ${JSON.stringify(FILE)}, ids: [] });
     const s = await window.aps.invoke('tests.flowState', { file: ${JSON.stringify(FILE)} });
     return 'pins: ' + Object.keys(s.pins).length + ' | breakpoints: ' + s.breakpoints.length;`,
  ),
];

module.exports = withExpect(steps, {
  'run-a-three-step-flow': /^first=passed,second=passed,third=passed$/,
  'history-shows-the-run': /^run: passed \| first=passed,second=passed,third=passed \| timeline has who: true$/,
  'breakpoint-pauses-the-debug-run': /^paused at: second \| node paused: true \| first: passed \| who: ok$/,
  'edit-a-variable-and-continue': /^run: passed \| first=passed,second=passed,third=passed \| third request: \?who=Ada \| in the inspector: true$/,
  'run-from-here-on-step-three': /^steps run: third=passed \| seeded who: true \| name: true$/,
  'pin-step-one-and-run': /^pinned status: 200 \| not in the YAML: true \| node: pinned · passed \| result pinned: true \| first=passed,second=passed,third=passed$/,
  'replay-a-failed-run': /^failed at: second \| replay: passed \| steps run: second=passed,third=passed \| name: true$/,
  'clean-up': /^pins: 0 \| breakpoints: 0$/,
});
