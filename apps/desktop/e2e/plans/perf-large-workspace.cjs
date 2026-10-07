// Performance with a large workspace: a collection of 500 requests in 25 folders (like a big Postman import).
// Each step reports milliseconds; the expectations are ceilings, loose enough for a busy CI machine, so a
// regression that makes an interaction several times slower fails here.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

// TESTPION_PERF_SCALE=6 makes it 3,000 requests (a big Postman import), for measuring by hand; the suite runs 500
const SCALE = Math.max(1, Number(process.env.TESTPION_PERF_SCALE) || 1);
const FOLDERS = 25 * SCALE;
const PER_FOLDER = 20;

/** A big collection in the fresh workspace before the app starts. */
function bigCollection(ws) {
  const items = [];
  for (let f = 0; f < FOLDERS; f++) {
    const reqs = [];
    for (let r = 0; r < PER_FOLDER; r++) {
      const n = f * PER_FOLDER + r;
      reqs.push({
        kind: 'http',
        id: `big-${n}`,
        name: `Request ${n} of folder ${f}`,
        request: {
          method: ['GET', 'POST', 'PUT', 'DELETE'][n % 4],
          url: `{{baseUrl}}/folder-${f}/item-${r}?page={{page}}`,
          headers: [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-Trace', value: '{{$guid}}', enabled: true }],
          body: n % 2 ? { type: 'json', content: JSON.stringify({ id: n, name: `item ${n}`, tags: ['a', 'b', 'c'], nested: { deep: { value: n } } }, null, 2) } : undefined,
        },
        preRequestScript: n % 3 ? 'pm.variables.set("page", "1");' : undefined,
        testScript: 'pm.test("ok", () => pm.response.to.have.status(200));',
        assertions: [{ type: 'status', equals: 200 }],
      });
    }
    items.push({ kind: 'folder', id: `big-folder-${f}`, name: `Folder ${f}`, items: reqs });
  }
  writeFileSync(join(ws, 'collections', 'big.json'), JSON.stringify({ schemaVersion: '1.0', id: 'big', name: 'Big collection', variables: [{ key: 'page', value: '1', enabled: true }], items }, null, 2));
}

/** Milliseconds from an action until the next two frames painted. */
const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;
const ms = (t0) => `Math.round(performance.now() - ${t0})`;

const steps = [
  [
    'open-and-expand',
    `(async () => {
      const t0 = performance.now();
      await __t.requests();
      const row = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.textContent.includes('Big collection')), 10000);
      if (!row) return 'NO ROW';
      const opened = ${ms('t0')};
      // Expand all from the collection's menu
      await __t.menu('Big collection');
      const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Expand all');
      const t1 = performance.now();
      item?.click();
      await __t.waitFor(() => document.querySelectorAll('aside [data-tree-row]').length > 400, 10000);
      await ${painted}();
      const rows = document.querySelectorAll('aside [data-tree-row]').length;
      return 'rows: ' + rows + ' | open ms: ' + opened + ' | expand ms: ' + ${ms('t1')};
    })()`,
  ],
  [
    'filter-tree',
    `(async () => {
      const input = document.querySelector('aside input[aria-label^="Filter"]');
      if (!input) return 'NO INPUT';
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const times = [];
      for (const ch of 'folder 7') {
        const t0 = performance.now();
        set.call(input, input.value + ch);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await ${painted}();
        times.push(performance.now() - t0);
      }
      await __t.sleep(400);
      const shown = document.querySelectorAll('aside [data-tree-row]').length;
      set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
      return 'max keystroke ms: ' + Math.round(Math.max(...times)) + ' | avg: ' + Math.round(times.reduce((a, b) => a + b) / times.length) + ' | rows shown: ' + shown;
    })()`,
  ],
  [
    'open-tabs-and-type',
    `(async () => {
      // open 12 requests in tabs
      const rows = [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => /Request \\d+ of folder 0$/.test(b.textContent.trim())).slice(0, 12);
      const t0 = performance.now();
      for (const r of rows) { r.click(); await ${painted}(); }
      const opened = ${ms('t0')};
      const tabs = document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]').length;
      // type into the URL bar of the active one
      const url = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && /\\{\\{baseUrl\\}\\}/.test(i.value));
      if (!url) return 'NO INPUT url';
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const times = [];
      for (const ch of '&q=hello-world') {
        const t1 = performance.now();
        set.call(url, url.value + ch);
        url.dispatchEvent(new Event('input', { bubbles: true }));
        await ${painted}();
        times.push(performance.now() - t1);
      }
      // switch between tabs
      const all = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
      const t2 = performance.now();
      for (let i = 0; i < 10; i++) { all[i % all.length].click(); await ${painted}(); }
      return 'tabs: ' + tabs + ' | open 12 ms: ' + opened + ' | max keystroke ms: ' + Math.round(Math.max(...times)) + ' | avg: ' + Math.round(times.reduce((a, b) => a + b) / times.length) + ' | 10 switches ms: ' + ${ms('t2')};
    })()`,
  ],
  [
    'save-and-refresh',
    `(async () => {
      // a save of the big collection: the explorer and everything else refreshes
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'big');
      const t0 = performance.now();
      await window.aps.invoke('col.save', { ...c, name: 'Big collection (saved)' });
      await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].some((b) => b.textContent.includes('(saved)')), 10000);
      await ${painted}();
      return 'save to tree ms: ' + ${ms('t0')};
    })()`,
  ],
];

const num = (s, key) => Number((new RegExp(key + ' ms: (\\d+)').exec(s) || [])[1]);
module.exports = withExpect(
  steps,
  {
    'open-and-expand': (r) => (SCALE > 1 || /^rows: 5\d\d \|/.test(r)) && num(r, 'expand') < 1500 ? undefined : 'slow or wrong: ' + r,
    'filter-tree': (r) => num(r, 'max keystroke') < 200 ? undefined : 'slow: ' + r,
    'open-tabs-and-type': (r) => (SCALE > 1 || /^tabs: 1[23] \|/.test(r)) && num(r, 'open 12') < 1500 && num(r, 'max keystroke') < 150 && num(r, '10 switches') < 1200 ? undefined : 'slow or wrong: ' + r,
    'save-and-refresh': (r) => num(r, 'save to tree') < 3000 ? undefined : 'slow: ' + r,
  },
  { prepare: bigCollection },
);
module.exports.bigCollection = bigCollection;
