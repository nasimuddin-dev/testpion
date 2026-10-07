// Not part of the suite (the _ prefix): a CPU profile of the app with a large workspace, for finding what makes an
// interaction slow. Build with TESTPION_PROFILE=1 (readable names), then  npm run e2e -- --only _profile ; each
// step's result lists the app functions with the most time, and <step>.cpuprofile opens in DevTools ▸ Performance.
const { withExpect } = require('../lib.cjs');
const { bigCollection } = require('./perf-large-workspace.cjs');
const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;
const steps = [
  ['setup', `(async () => { await __t.requests(); await __t.menu('Big collection'); [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Expand all')?.click(); await __t.sleep(1500); return 'rows ' + document.querySelectorAll('aside [data-tree-row]').length; })()`, false],
  ['open-requests', `profile:(async () => {
    const rows = [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.textContent.includes('of folder 2')).slice(0, 15);
    if (!rows.length) return 'NO ROWS; sample: ' + [...document.querySelectorAll('aside [data-tree-row]')].slice(20, 23).map((b) => JSON.stringify(b.textContent)).join(' ');
    const t0 = performance.now();
    for (const r of rows) { r.click(); await ${painted}(); }
    return 'open 15 ms: ' + Math.round(performance.now() - t0);
  })()`, false],
  ['switch-tabs', `profile:(async () => {
    const all = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { all[i % all.length].click(); await ${painted}(); }
    return 'switch 20 ms: ' + Math.round(performance.now() - t0);
  })()`, false],
  ['filter', `profile:(async () => {
    const input = document.querySelector('aside input[aria-label^="Filter"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const t0 = performance.now();
    const lag = [];
    for (const ch of 'folder 7 request') { const t1 = performance.now(); set.call(input, input.value + ch); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); lag.push(performance.now() - t1); await ${painted}(); }
    return 'filter 16 keys ms: ' + Math.round(performance.now() - t0) + ' | input lag max ms: ' + Math.round(Math.max(...lag)) + ' avg: ' + Math.round(lag.reduce((a, b) => a + b) / lag.length);
  })()`, false],
  ['views', `profile:(async () => {
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) { await __t.view('Home'); await ${painted}(); await __t.requests(); await __t.waitFor(() => document.querySelectorAll('aside [data-tree-row]').length > 400, 5000); await ${painted}(); }
    return 'home and back x3 ms: ' + Math.round(performance.now() - t0);
  })()`, false],
  ['save', `profile:(async () => {
    const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'big');
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) {
      await window.aps.invoke('col.save', { ...c, name: 'Big collection ' + i });
      await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].some((b) => b.textContent.includes('Big collection ' + i)), 10000);
      await ${painted}();
    }
    return 'save x3 ms: ' + Math.round(performance.now() - t0);
  })()`, false],
];
module.exports = withExpect(steps, {}, { prepare: bigCollection });
