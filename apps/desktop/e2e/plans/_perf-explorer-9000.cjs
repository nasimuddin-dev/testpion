// Not part of the suite (the _ prefix): a CPU profile of the Home view and the Collections explorer with a very big
// workspace: 3 collections of 3,000 requests (9,000 rows), an environment with 30 variables. Build with
// TESTPION_PROFILE=1 (readable names), then  npm run e2e -- --only _perf-explorer-9000 ; each step's result lists the
// app functions with the most time, the IPC calls it made (count, ms, KB of result), and <step>.cpuprofile opens in
// DevTools ▸ Performance.
const { withExpect } = require('../lib.cjs');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const COLLECTIONS = 3;
const FOLDERS = 150;
const PER_FOLDER = 20;

function prepare(ws) {
  for (let c = 0; c < COLLECTIONS; c++) {
    const items = [];
    for (let f = 0; f < FOLDERS; f++) {
      const reqs = [];
      for (let r = 0; r < PER_FOLDER; r++) {
        const n = f * PER_FOLDER + r;
        reqs.push({
          kind: 'http',
          id: `big${c}-${n}`,
          name: `Request ${n} of folder ${f}`,
          request: {
            method: ['GET', 'POST', 'PUT', 'DELETE'][n % 4],
            url: `{{baseUrl}}/folder-${f}/item-${r}?page={{page}}&v={{v${(n % 30) + 1}}}`,
            headers: [
              { key: 'Accept', value: 'application/json', enabled: true },
              { key: 'X-Trace', value: '{{$guid}}', enabled: true },
            ],
            body: n % 2 ? { type: 'json', content: JSON.stringify({ id: n, name: `item ${n}`, tags: ['a', 'b', 'c'], nested: { deep: { value: n } } }, null, 2) } : undefined,
          },
          preRequestScript: n % 3 ? 'tp.variables.set("page", "1");' : undefined,
          testScript: 'tp.test("ok", () => tp.response.to.have.status(200));',
          assertions: [{ type: 'status', equals: 200 }],
        });
      }
      items.push({ kind: 'folder', id: `big${c}-folder-${f}`, name: `Folder ${f}`, items: reqs });
    }
    writeFileSync(
      join(ws, 'collections', `big${c}.json`),
      JSON.stringify(
        {
          schemaVersion: '1.0',
          id: `big${c}`,
          name: `Big collection ${c}`,
          variables: [
            { key: 'page', value: '1', enabled: true },
            { key: 'baseUrl', value: 'http://127.0.0.1:4010', enabled: true },
          ],
          items,
        },
        null,
        2,
      ),
    );
  }
  // 30 variables in the environment the app opens first
  const envFile = join(ws, 'environments', 'public.json');
  const env = JSON.parse(readFileSync(envFile, 'utf8'));
  for (let i = 1; i <= 30; i++) env.variables.push({ key: `v${i}`, value: `value-${i}`, enabled: true });
  writeFileSync(envFile, JSON.stringify(env, null, 2));
}

const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;
const METER = `
  // the size and time of one RPC answer (window.aps is a context-bridge object: its methods can't be wrapped, so calls are measured one by one)
  const sized = async (method, params) => { const t = performance.now(); const r = await window.aps.invoke(method, params); const ms = Math.round(performance.now() - t); return method + ' ' + ms + 'ms ' + Math.round(JSON.stringify(r).length / 1024) + 'KB'; };
  const ipc = () => '';
  // long animation frames (Chrome's LoAF entries, frames over 50 ms): how much of a slow frame was style/layout/paint rather than script
  const loafList = (window.__loaf ??= (() => { const list = []; try { new PerformanceObserver((l) => list.push(...l.getEntries())).observe({ type: 'long-animation-frame', buffered: true }); } catch {} return list; })());
  loafList.splice(0);
  const loaf = () => { const es = loafList.splice(0); const sum = (f) => Math.round(es.reduce((n, e) => n + f(e), 0)); return ' | loaf: n=' + es.length + ' total ' + sum((e) => e.duration) + 'ms script ' + sum((e) => (e.scripts ?? []).reduce((n, s) => n + s.duration, 0)) + 'ms style+layout ' + sum((e) => (e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0)) + 'ms | dom nodes ' + document.getElementsByTagName('*').length; };
  const rows = () => document.querySelectorAll('aside [data-tree-row]');
`;
const steps = [
  ['meter', `(async () => { ${METER} return 'ok'; })()`, false],
  [
    'home-and-back-x3',
    `profile:(async () => { ${METER}
      const times = [];
      for (let i = 0; i < 3; i++) {
        await __t.requests(); await __t.waitFor(() => rows().length > 2, 10000); await ${painted}();
        const t0 = performance.now();
        document.querySelector('nav [aria-label="Home"]').click();
        await __t.waitFor(() => document.querySelector('nav [aria-label="Home"][aria-current="page"]') && !document.querySelector('aside[aria-label="Collections explorer"]'), 10000);
        await ${painted}();
        times.push(Math.round(performance.now() - t0));
        await __t.sleep(800);
      }
      return 'home ms: ' + times.join(',') + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'open-explorer',
    `profile:(async () => { ${METER}
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, altKey: true, bubbles: true }));
      await __t.waitFor(() => rows().length > 2, 10000); await ${painted}();
      const shown = Math.round(performance.now() - t0);
      const t1 = performance.now(); const list = await window.aps.invoke('col.list'); const listMs = Math.round(performance.now() - t1);
      const t2 = performance.now(); const kb = Math.round(JSON.stringify(list).length / 1024); const strMs = Math.round(performance.now() - t2);
      return 'explorer shown ms: ' + shown + ' | rows: ' + rows().length + ' | col.list ms: ' + listMs + ' kb: ' + kb + ' (stringify ms ' + strMs + ') | ' + (await sized('col.get', { id: 'big0' })) + ' | ' + (await sized('vars.inspect', { environment: 'Public APIs', template: '{{baseUrl}}/{{v1}}/{{v2}}' })) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'expand-all-3000',
    `profile:(async () => { ${METER}
      await __t.menu('Big collection 0');
      const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Expand all');
      if (!item) return 'NO MENU Expand all';
      const t0 = performance.now(); item.click();
      await __t.waitFor(() => rows().length > 3000, 20000); await ${painted}();
      return 'expand ms: ' + Math.round(performance.now() - t0) + ' | rows: ' + rows().length + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'filter-keystrokes',
    `profile:(async () => { ${METER}
      const input = document.querySelector('aside input[aria-label^="Filter"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const lag = [], total = [];
      for (const ch of 'folder 77 request 1') { const t1 = performance.now(); set.call(input, input.value + ch); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); lag.push(performance.now() - t1); await ${painted}(); total.push(performance.now() - t1); }
      await __t.sleep(500);
      const shown = rows().length;
      set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(600);
      return 'input lag max ms: ' + Math.round(Math.max(...lag)) + ' avg: ' + Math.round(lag.reduce((a, b) => a + b) / lag.length) + ' | keystroke painted max ms: ' + Math.round(Math.max(...total)) + ' | rows shown: ' + shown + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'open-10-tabs',
    `profile:(async () => { ${METER}
      const list = [...rows()].filter((b) => /Request \\d+ of folder 1$/.test(b.textContent.trim())).slice(0, 10);
      if (list.length < 10) return 'NO ROWS: ' + list.length;
      const each = [];
      for (const r of list) { const t = performance.now(); r.click(); await ${painted}(); each.push(Math.round(performance.now() - t)); }
      return 'open each ms: ' + each.join(',') + ' | tabs: ' + document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]').length + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'switch-10-tabs',
    `profile:(async () => { ${METER}
      const all = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
      const each = [];
      for (let i = 0; i < 20; i++) { const t = performance.now(); all[i % all.length].click(); await ${painted}(); each.push(Math.round(performance.now() - t)); }
      return 'switch each ms: ' + each.join(',') + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'type-url-30-vars',
    `profile:(async () => { ${METER}
      const url = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && /\\{\\{baseUrl\\}\\}/.test(i.value));
      if (!url) return 'NO INPUT url';
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(url, '{{baseUrl}}/a/{{v1}}/{{v2}}/{{v3}}/{{v4}}/{{v5}}?x={{v6}}&y={{v7}}&z={{v8}}&q={{v9}}&r={{v10}}&s={{v11}}&t={{v12}}'); url.dispatchEvent(new Event('input', { bubbles: true }));
      await __t.sleep(600);
      const lag = [], total = [];
      for (const ch of '&more={{v13}}-x') { const t1 = performance.now(); set.call(url, url.value + ch); url.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); lag.push(performance.now() - t1); await ${painted}(); total.push(performance.now() - t1); }
      await __t.sleep(800);
      return 'input lag max ms: ' + Math.round(Math.max(...lag)) + ' avg: ' + Math.round(lag.reduce((a, b) => a + b) / lag.length) + ' | keystroke painted max ms: ' + Math.round(Math.max(...total)) + ' avg: ' + Math.round(total.reduce((a, b) => a + b) / total.length) + ' | ' + (await sized('vars.inspect', { environment: 'Public APIs', collectionId: 'big0', template: url.value })) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'save-to-tree',
    `profile:(async () => { ${METER}
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'big1');
          const t0 = performance.now();
      await window.aps.invoke('col.save', { ...c, name: 'Big collection 1 (saved)' });
      await __t.waitFor(() => [...rows()].some((b) => b.textContent.includes('(saved)')), 20000); await ${painted}();
      return 'save to tree ms: ' + Math.round(performance.now() - t0) + ipc() + loaf();
    })()`,
    true,
  ],
];
module.exports = withExpect(steps, {}, { prepare });
