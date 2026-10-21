// Not part of the suite (the _ prefix): tab churn. A request tab is opened and closed 200 times (the Explorer's rows, the tab's
// own close button), 50 at a time; after each batch both processes are garbage-collected and the page's heap, DOM nodes, event
// listeners and the stores that hold a tab's state are read. A tab that leaves something behind (a result, an undo stack, a
// listener, a Monaco model) shows as a number that grows from batch to batch instead of staying flat.
//   npm run e2e -w @testpion/desktop -- --only _soak-tabs
const { withExpect } = require('../lib.cjs');
const { bigCollection } = require('./perf-large-workspace.cjs');

const BATCHES = Math.max(1, Number(process.env.SOAK_TAB_BATCHES) || 4);
const PER_BATCH = Math.max(1, Number(process.env.SOAK_TAB_CYCLES) || 50);
const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;

/** Collect garbage in the page, then one line: heap, DOM nodes, listeners, tabs, Monaco models. */
const measure = (label) => `main: const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.debugger.isAttached()) ?? BrowserWindow.getAllWindows()[0]; const dbg = win.webContents.debugger;
  await dbg.sendCommand('HeapProfiler.collectGarbage'); await dbg.sendCommand('HeapProfiler.collectGarbage');
  await new Promise((r) => setTimeout(r, 300));
  await dbg.sendCommand('Performance.enable').catch(() => {});
  const pm = Object.fromEntries((await dbg.sendCommand('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const hu = await dbg.sendCommand('Runtime.getHeapUsage');
  const page = await win.webContents.executeJavaScript("({ tabs: document.querySelectorAll('[role=tab]').length, models: window.__monaco?.editor.getModels().length ?? -1, ls: Object.keys(localStorage).length })");
  const row = { heapMB: +(hu.usedSize / 1048576).toFixed(1), nodes: pm.Nodes, listeners: pm.JSEventListeners, docs: pm.Documents, tabs: page.tabs, models: page.models, localStorageKeys: page.ls };
  globalThis.__tabSoak = [...(globalThis.__tabSoak ?? []), row];
  return '${label}: ' + JSON.stringify(row);`;

const batch = (n) => [
  `churn-${n}`,
  `(async () => {
    const rowsOf = () => [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.getAttribute('aria-expanded') === null && /Request \\d+ of folder/.test(b.textContent));
    let opened = 0;
    for (let i = 0; i < ${PER_BATCH}; i++) {
      const rows = rowsOf(); if (!rows.length) return 'NO ROWS after ' + opened;
      const r = rows[(i * 7 + ${n}) % rows.length];
      r.click(); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await ${painted}();
      const tab = document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]');
      const x = tab?.querySelector('button[aria-label^="Close "]');
      if (x) { x.click(); opened++; }
      await ${painted}();
    }
    return 'opened and closed ' + opened + ' of ${PER_BATCH}';
  })()`,
  false,
];

const steps = [
  ['setup', `(async () => { await __t.requests(); await __t.menu('Big collection'); [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Expand all')?.click(); await __t.sleep(1500); return 'rows ' + document.querySelectorAll('aside [data-tree-row]').length; })()`, false],
  ['warm-up', batch(0)[1], false],
  ['baseline', measure('baseline'), false],
];
for (let b = 1; b <= BATCHES; b++) steps.push([`churn-${b}`, batch(b)[1], false], [`measure-${b}`, measure(`after ${b * PER_BATCH}`), false]);
steps.push([
  'flat',
  `main: const rows = globalThis.__tabSoak ?? []; if (rows.length < 3) return 'NO ROWS';
   const first = rows[0], last = rows[rows.length - 1];
   const grew = { heapMB: +(last.heapMB - first.heapMB).toFixed(1), nodes: last.nodes - first.nodes, listeners: last.listeners - first.listeners, docs: last.docs - first.docs, models: last.models - first.models, localStorageKeys: last.localStorageKeys - first.localStorageKeys };
   return 'growth over ' + (${BATCHES} * ${PER_BATCH}) + ' tabs: ' + JSON.stringify(grew);`,
  false,
]);

module.exports = withExpect(
  steps,
  {
    // flat: a few MB of heap and a couple of hundred nodes at most (a leak of a tab's state would be hundreds of KB per tab)
    flat: (r) => {
      const m = /"heapMB":(-?[\d.]+),"nodes":(-?\d+),"listeners":(-?\d+),"docs":(-?\d+),"models":(-?\d+)/.exec(r);
      if (!m) return 'unreadable: ' + r;
      const [heap, nodes, listeners, docs, models] = m.slice(1).map(Number);
      return heap < 12 && nodes < 400 && listeners < 400 && docs <= 1 && models <= 2 ? true : 'not flat: ' + r;
    },
  },
  { prepare: bigCollection },
);
