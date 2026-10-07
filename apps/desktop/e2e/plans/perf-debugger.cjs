// Performance of the Debugger with a long capture: 5,000 exchanges (the most a session keeps) opened from a HAR.
// Each step reports milliseconds (and the list's payload); the expectations are ceilings, loose enough for a busy
// CI machine, so a regression that makes an interaction several times slower fails here.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const COUNT = 5000;
/** A HAR of COUNT exchanges over 40 hosts, with headers and small JSON bodies, built in the page. */
const har = `(() => {
  const entries = [];
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  for (let i = 0; i < ${COUNT}; i++) {
    const host = 'api-' + (i % 40) + '.example.test';
    const status = i % 17 === 0 ? 500 : i % 9 === 0 ? 404 : 200;
    const body = JSON.stringify({ id: i, name: 'item ' + i, tags: ['a', 'b'], nested: { value: i } });
    entries.push({
      startedDateTime: new Date(t0 + i * 37).toISOString(),
      time: 20 + (i % 300),
      request: { method: ['GET', 'POST', 'PUT', 'DELETE'][i % 4], url: 'https://' + host + '/v1/items/' + i + '?page=' + (i % 7), httpVersion: 'HTTP/1.1', headers: [{ name: 'accept', value: 'application/json' }, { name: 'authorization', value: 'Bearer abc.def.ghi' }, { name: 'x-trace', value: 'trace-' + i }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status, statusText: status === 200 ? 'OK' : 'Error', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }, { name: 'x-request-id', value: 'r-' + i }], cookies: [], content: { size: body.length, mimeType: 'application/json', text: body }, redirectURL: '', headersSize: -1, bodySize: body.length },
      cache: {},
      timings: { send: 1, wait: 10 + (i % 200), receive: 5 },
    });
  }
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries } });
})()`;
const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;
const ms = (t0) => `Math.round(performance.now() - ${t0})`;
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-a-long-session',
    `await __t.view('Debugger'); await __t.sleep(500);
     const text = ${har};
     const t0 = performance.now();
     const r = await window.aps.invoke('debug.openSession', { text });
     await __t.waitFor(() => (rows().length > 10 ? true : null), 20000);
     await ${painted}();
     const open = ${ms('t0')};
     const t1 = performance.now();
     const list = await window.aps.invoke('debug.exchanges', {});
     const listMs = ${ms('t1')};
     const kb = Math.round(JSON.stringify(list).length / 1024);
     return 'loaded: ' + r.loaded + ' | open ms: ' + open + ' | list ms: ' + listMs + ' | list kb: ' + kb + ' | rows painted: ' + (rows().length > 10);`,
  ),
  // a new request in a long capture: the window gets that row, not the list again
  step(
    'live-update-is-a-delta',
    `const base = await window.aps.invoke('debug.changes', {});
     if (!(await window.aps.invoke('debug.status')).running) { vis('main button').find((b) => b.textContent.trim() === 'Start capturing')?.click(); await __t.sleep(800); }
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?live=1' });
     await __t.sleep(300);
     const d = await window.aps.invoke('debug.changes', { epoch: base.epoch, since: base.rev });
     const t = performance.now();
     const box = document.querySelector('main input[aria-label="Filter exchanges"]');
     setInput(box, 'live=1');
     const shown = await __t.waitFor(() => (rows().some((r) => r.textContent.includes('live=1')) ? true : null), 4000);
     const ms1 = ${ms('t')};
     setInput(box, ''); await __t.sleep(500);
     return 'reset: ' + d.reset + ' | rows: ' + d.rows.length + ' | kb: ' + Math.ceil(JSON.stringify(d).length / 1024) + ' | listed: ' + !!shown + ' | ms: ' + ms1;`,
  ),
  step(
    'select-rows',
    `// the first selection mounts the detail panes (and may meet a garbage collection after the big load): timed apart
     const times = [];
     for (let i = 0; i < 9; i++) {
       const r = rows()[i * 2]; const t = performance.now();
       r.click();
       await __t.waitFor(() => (document.querySelector('main [data-details-pane=response]') && r.getAttribute('aria-selected') === 'true' ? true : null), 3000);
       await ${painted}();
       times.push(performance.now() - t);
     }
     const first = times.shift();
     return 'first select ms: ' + Math.round(first) + ' | max select ms: ' + Math.round(Math.max(...times)) + ' | avg: ' + Math.round(times.reduce((a, b) => a + b, 0) / times.length) + ' | each: ' + times.map(Math.round).join(',');`,
  ),
  step(
    'filter-keystrokes',
    `const box = document.querySelector('main input[aria-label="Filter exchanges"]');
     const times = [];
     let typed = '';
     for (const ch of 'items/42') {
       typed += ch; const t = performance.now();
       setInput(box, typed); await ${painted}();
       times.push(performance.now() - t);
     }
     await __t.sleep(800);
     const shown = rows().length;
     setInput(box, ''); await __t.sleep(800);
     return 'max keystroke ms: ' + Math.round(Math.max(...times)) + ' | rows shown: ' + shown;`,
  ),
  step(
    'sort-and-scroll',
    `const head = vis('main [data-debugger-grid] [role=columnheader]').find((h) => h.textContent.trim().startsWith('Duration'));
     let t = performance.now(); head.click(); await ${painted}(); const sort = ${ms('t')};
     t = performance.now(); head.click(); await ${painted}(); const sort2 = ${ms('t')};
     const list = document.querySelector('main [data-debugger-grid] .flex-1.overflow-auto, main [data-debugger-grid] [style*="overflow"]') ?? rows()[0].parentElement.parentElement.parentElement;
     t = performance.now();
     for (let i = 0; i < 10; i++) { list.scrollTop += 2000; await ${painted}(); }
     const scroll = Math.round((performance.now() - t) / 10);
     vis('main [data-debugger-grid] [role=columnheader]').find((h) => h.textContent.trim().startsWith('#'))?.click(); await __t.sleep(200);
     return 'sort ms: ' + sort + ' | sort back ms: ' + sort2 + ' | scroll frame ms: ' + scroll;`,
  ),
  step(
    'structure-and-performance',
    `const rail = (l) => document.querySelector('[data-tool-rail] button[aria-label="' + l + '"]');
     const open = async (l) => { if (document.querySelector('main [data-dock]')?.getAttribute('data-dock') === l.toLowerCase()) return 0; const t = performance.now(); rail(l).click(); await ${painted}(); return Math.round(performance.now() - t); };
     const s = await open('Structure');
     const p = await open('Performance');
     await window.aps.invoke('debug.clear');
     return 'structure ms: ' + s + ' | performance ms: ' + p;`,
  ),
];

const num = (s, key) => Number((new RegExp(key + ' ms: (\\d+)').exec(s) || [])[1]);
module.exports = withExpect(steps, {
  'open-a-long-session': (r) => (/^loaded: 5000 \|/.test(r) && num(r, 'open') < 8000 && /rows painted: true/.test(r) ? undefined : 'slow or wrong: ' + r),
  'live-update-is-a-delta': (r) => (/^reset: false \| rows: [12] \| kb: [1-4] \| listed: true/.test(r) ? undefined : 'not a delta: ' + r),
  // the average says how fast selecting is; one select may meet a garbage collection of the page's 5,000 rows
  'select-rows': (r) => (num(r, 'first select') < 1000 && Number(/avg: (\d+)/.exec(r)?.[1]) < 200 && num(r, 'max select') < 800 ? undefined : 'slow: ' + r),
  'filter-keystrokes': (r) => (num(r, 'max keystroke') < 200 ? undefined : 'slow: ' + r),
  'sort-and-scroll': (r) => (num(r, 'sort') < 600 && num(r, 'scroll frame') < 100 ? undefined : 'slow: ' + r),
  'structure-and-performance': (r) => (num(r, 'structure') < 800 && num(r, 'performance') < 800 ? undefined : 'slow: ' + r),
});
