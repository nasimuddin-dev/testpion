// The flow designer's Scale stage in the Tests view, against the demo server (127.0.0.1:4010): Run with data… with a
// CSV runs the flow once per row and the Runs tab shows the per-row grid; Failed filters it and the failing row opens
// its steps and the failing step's result; Run in several environments… compares two environments step by step; a run's
// Timeline tab draws the bars with the critical path and Save as HTML writes the file (save dialog stubbed); a
// 10,000-row data run keeps the window responsive (the longest frame while it runs and the grid scrolls).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

const FILE = 'scale/e2e-scale.yaml';
const TEXT = [
  'name: Scale flow',
  'tests:',
  '  - { id: health, name: Health, url: "http://127.0.0.1:4010/health", extract: { state: "$.status" }, assertions: [{ type: status, expected: 200 }] }',
  '  - { id: status, name: Status, url: "http://127.0.0.1:4010/status?code={{code}}&who={{who}}", dependsOn: [health], assertions: [{ type: status, expected: 200 }] }',
  '',
].join('\n');
const CSV = 'who,code\nann,200\nbob,404\ncy,200\n';
const BIG = ['who,code', ...Array.from({ length: 10000 }, (_, i) => `u${i},200`)].join('\n');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
  const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const fileTab = async () => { document.querySelector('[data-tab-id="file:${FILE}"]')?.click(); await __t.sleep(600); };
  const dialog = () => document.querySelector('[data-run-with-data]');
  const openDialog = async () => {
    // the Runs tab has no file actions: back to the file's tab
    if (!vis('[data-run-with-data-open]').length) await fileTab();
    const b = await __t.waitFor(() => vis('[data-run-with-data-open]')[0], 4000); if (!b) return 'NO OPEN BUTTON';
    b.click();
    if (!(await __t.waitFor(() => dialog(), 3000))) return 'NO DIALOG';
    return '';
  };
  const start = () => document.querySelector('[data-scale-start]').click();
  const pickData = async (name) => {
    const d = await window.aps.invoke('datasets.list');
    const hit = d.find((x) => x.name.endsWith(name)); if (!hit) return 'NO DATASET ' + name + ': ' + d.map((x) => x.name).join(',');
    const sel = dialog().querySelector('select[aria-label="Data source"]');
    if (!(await until(() => [...sel.options].some((o) => o.value === hit.path), 3000))) return 'NOT IN THE LIST';
    setSelect(sel, hit.path); await __t.sleep(200);
    return '';
  };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-the-flow',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: ${JSON.stringify(TEXT)} });
     await window.aps.invoke('col.uploadDataFile', { name: 'e2e-scale.csv', text: ${JSON.stringify(CSV)} });
     await window.aps.invoke('col.uploadDataFile', { name: 'e2e-scale-big.csv', text: ${JSON.stringify(BIG)} });
     await window.aps.invoke('env.save', { env: { id: 'e2e-scale-dev', name: 'E2E scale dev', variables: [{ key: 'code', value: '200', enabled: true }, { key: 'who', value: 'dev', enabled: true }] } });
     await window.aps.invoke('env.save', { env: { id: 'e2e-scale-stage', name: 'E2E scale stage', variables: [{ key: 'code', value: '503', enabled: true }, { key: 'who', value: 'stage', enabled: true }] } });
     await __t.view('Tests'); await __t.sleep(800);
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('e2e-scale.yaml')), 5000);
     if (!row) return 'NO ROW'; row.click(); await __t.sleep(1000);
     return vis('[data-run-with-data-open]').length ? 'open' : 'NO RUN WITH DATA BUTTON';`,
  ),
  step(
    'run-with-a-csv',
    `let e = await openDialog(); if (e) return e;
     e = await pickData('e2e-scale.csv'); if (e) return e;
     start();
     const grid = await __t.waitFor(() => vis('[data-flow-data-grid]')[0], 6000); if (!grid) return 'NO GRID';
     if (!(await until(() => grid.dataset.running === 'false' && vis('[data-data-row]').length === 3, 20000))) return 'NOT DONE: ' + grid.dataset.running + ' rows ' + vis('[data-data-row]').length;
     return 'rows: ' + vis('[data-data-row]').map((r) => r.dataset.dataRow + '=' + r.dataset.status).join(',');`,
  ),
  step(
    'failed-row-opens-its-steps',
    `const f = vis('[data-flow-data-grid] [role=radio]').find((b) => b.textContent.startsWith('Failed')); if (!f) return 'NO FILTER'; f.click();
     if (!(await until(() => vis('[data-data-row]').length === 1, 4000))) return 'NOT FILTERED: ' + vis('[data-data-row]').length;
     vis('[data-data-row]')[0].click();
     const detail = await __t.waitFor(() => vis('[data-data-row-detail]')[0], 4000); if (!detail) return 'NO DETAIL';
     const steps = await until(() => vis('[data-row-step]').length === 2 ? vis('[data-row-step]') : null, 3000); if (!steps) return 'NO STEPS';
     // the failing step is chosen: its result (the run panel's ResultDetail) shows the failed check
     const shown = await until(() => /404|Status/.test(detail.textContent) && detail.querySelector('[role=tab]') ? true : null, 4000);
     return 'row ' + detail.dataset.dataRowDetail + ' | steps: ' + steps.map((s) => s.dataset.rowStep).join(',') + ' | result shown: ' + !!shown;`,
  ),
  step(
    'matrix-of-two-environments',
    `let e = await openDialog(); if (e) return e;
     const m = [...dialog().querySelectorAll('[role=radio]')].find((b) => b.textContent.includes('environments')); if (!m) return 'NO MODE'; m.click(); await __t.sleep(300);
     for (const id of ['E2E scale dev', 'E2E scale stage']) { const c = dialog().querySelector('[data-matrix-env="' + id + '"]'); if (!c) return 'NO ENV ' + id; if (!c.checked) c.click(); }
     for (const c of dialog().querySelectorAll('[data-matrix-env]')) if (c.checked && !/^E2E scale/.test(c.dataset.matrixEnv)) c.click();
     await __t.sleep(200); start();
     const grid = await __t.waitFor(() => vis('[data-flow-matrix]')[0], 6000); if (!grid) return 'NO MATRIX';
     if (!(await until(() => grid.dataset.running === 'false', 20000))) return 'NOT DONE';
     await __t.sleep(300);
     const cols = vis('[data-matrix-column]').map((c) => c.dataset.matrixColumn + '=' + c.dataset.status).join(',');
     const differs = vis('[data-matrix-step]').filter((r) => r.dataset.differs === 'true').map((r) => r.dataset.matrixStep).join(',');
     return 'columns: ' + cols + ' | differ: ' + differs;`,
  ),
  step(
    'timeline-renders',
    `const back = vis('main button').find((b) => b.textContent.includes('Test runs')); back?.click(); await __t.sleep(300);
     await fileTab();
     if (!(await __t.button('Run'))) return 'NO RUN BUTTON';
     const done = await until(() => vis('main [role=tab]').some((t) => t.textContent.trim() === 'Timeline'), 20000); if (!done) return 'NO TIMELINE TAB';
     await __t.tab('Timeline');
     const bars = await until(() => vis('[data-run-timeline] [data-step-id]').length === 2 ? vis('[data-run-timeline] [data-step-id]') : null, 6000);
     if (!bars) return 'NO BARS';
     return 'bars: ' + bars.map((b) => b.dataset.stepId + (b.dataset.critical ? '*' : '')).join(',') + ' | critical path text: ' + /Health → Status/.test(document.querySelector('[data-run-timeline]').textContent);`,
  ),
  step(
    'save-timeline-as-html',
    `const b = vis('[data-timeline-save-html]')[0]; if (!b) return 'NO BUTTON'; b.click();
     const t = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent.trim()).find((x) => /Timeline saved to/.test(x)), 5000);
     return t ?? 'no toast';`,
  ),
  step(
    'ten-thousand-rows-stay-responsive',
    `await fileTab();
     let e = await openDialog(); if (e) return e;
     e = await pickData('e2e-scale-big.csv'); if (e) return e;
     setInput(dialog().querySelector('input[aria-label="Rows at once"]'), '16');
     await __t.sleep(100); start();
     const grid = await __t.waitFor(() => vis('[data-flow-data-grid]')[0], 6000); if (!grid) return 'NO GRID';
     // the longest frame while the run goes, the grid scrolled now and then
     let worst = 0, frames = 0, last = performance.now(), on = true;
     const tick = (t) => { worst = Math.max(worst, t - last); last = t; frames++; if (on) requestAnimationFrame(tick); };
     requestAnimationFrame(tick);
     const t0 = Date.now();
     const box = () => grid.querySelector('.overflow-auto');
     const ok = await until(() => { const b = box(); if (b) b.scrollTop = b.scrollHeight; return grid.dataset.running === 'false'; }, 180000);
     on = false;
     const ms = Date.now() - t0;
     if (!ok) return 'NOT DONE in 180 s';
     await __t.sleep(600);
     const b = box(); b.scrollTop = b.scrollHeight; await __t.sleep(800);
     const lastRow = Math.max(...vis('[data-data-row]').map((r) => Number(r.dataset.dataRow)));
     const domRows = vis('[data-data-row]').length;
     const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
     console.log('[flow-scale] 10k rows: ' + ms + ' ms, longest frame ' + Math.round(worst) + ' ms over ' + frames + ' frames, ' + domRows + ' rows in the DOM, heap ' + heap + ' MB');
     // every row reached the demo server and passed: a run that only fails fast (the server gone) is not a scale run
     const passed = /(\\d+) passed/.exec(grid.textContent)?.[1];
     return 'last row: ' + lastRow + ' | passed: ' + passed + ' | rows in the DOM: ' + (domRows < 120 ? 'few' : domRows) + ' | longest frame: ' + (worst < 250 ? 'under 250 ms' : Math.round(worst) + ' ms') + ' | measured: ' + ms + ' ms for 10,000 rows, longest frame ' + Math.round(worst) + ' ms over ' + frames + ' frames, ' + domRows + ' rows in the DOM, heap ' + heap + ' MB';`,
  ),
  step(
    'clean-up',
    `await window.aps.invoke('tests.delete', { path: ${JSON.stringify(FILE)} });
     await window.aps.invoke('env.delete', { id: 'e2e-scale-dev' });
     await window.aps.invoke('env.delete', { id: 'e2e-scale-stage' });
     return 'done';`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'open-the-flow': /^open$/,
    'run-with-a-csv': /^rows: 0=passed,1=failed,2=passed$/,
    'failed-row-opens-its-steps': /^row 1 \| steps: health,status \| result shown: true$/,
    'matrix-of-two-environments': /^columns: E2E scale dev=passed,E2E scale stage=failed \| differ: status$/,
    'timeline-renders': /^bars: health\*,status\* \| critical path text: true$/,
    'save-timeline-as-html': /Timeline saved to .*timeline\.html/,
    'ten-thousand-rows-stay-responsive': /^last row: 9999 \| passed: 10000 \| rows in the DOM: few \| longest frame: under 250 ms \| measured: /,
    'clean-up': /^done$/,
  },
  { env: (out) => ({ E2E_STUB_SAVE: join(out, 'e2e-scale-timeline.html') }) },
);
