// Not part of the suite (the _ prefix): a CPU profile of the Debugger with 5,000 exchanges (the most a session keeps),
// opened from a HAR: selecting rows, filtering, sorting and scrolling. Build with TESTPION_PROFILE=1, then
// npm run e2e -- --only _perf-debugger-5000 ; each step's result lists the app functions with the most time, the IPC
// calls it made (count, ms, KB of result), and <step>.cpuprofile opens in DevTools ▸ Performance.
const { withExpect } = require('../lib.cjs');

const COUNT = 5000;
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
const METER = `
  // the size and time of one RPC answer (window.aps is a context-bridge object: its methods can't be wrapped, so calls are measured one by one)
  const sized = async (method, params) => { const t = performance.now(); const r = await window.aps.invoke(method, params); const ms = Math.round(performance.now() - t); return method + ' ' + ms + 'ms ' + Math.round(JSON.stringify(r).length / 1024) + 'KB'; };
  const ipc = () => '';
  // long animation frames (Chrome's LoAF entries, frames over 50 ms): how much of a slow frame was style/layout/paint rather than script
  const loafList = (window.__loaf ??= (() => { const list = []; try { new PerformanceObserver((l) => list.push(...l.getEntries())).observe({ type: 'long-animation-frame', buffered: true }); } catch {} return list; })());
  loafList.splice(0);
  const loaf = () => { const es = loafList.splice(0); const sum = (f) => Math.round(es.reduce((n, e) => n + f(e), 0)); return ' | loaf: n=' + es.length + ' total ' + sum((e) => e.duration) + 'ms script ' + sum((e) => (e.scripts ?? []).reduce((n, s) => n + s.duration, 0)) + 'ms style+layout ' + sum((e) => (e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0)) + 'ms | dom nodes ' + document.getElementsByTagName('*').length; };
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const steps = [
  ['meter', `(async () => { ${METER} await __t.view('Debugger'); await __t.sleep(500); return 'ok'; })()`, false],
  [
    'open-5000',
    `profile:(async () => { ${METER}
      const text = ${har};
      const t0 = performance.now();
      const r = await window.aps.invoke('debug.openSession', { text });
      await __t.waitFor(() => (rows().length > 10 ? true : null), 30000); await ${painted}();
      return 'loaded: ' + r.loaded + ' | open ms: ' + Math.round(performance.now() - t0) + ' | ' + (await sized('debug.changes', { epoch: -1, since: 0 })) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'select-rows',
    `profile:(async () => { ${METER}
      const times = [];
      for (let i = 0; i < 12; i++) {
        const r = rows()[i * 2]; const t = performance.now();
        r.click();
        await __t.waitFor(() => (document.querySelector('main [data-details-pane=response]') && r.getAttribute('aria-selected') === 'true' ? true : null), 3000);
        await ${painted}();
        times.push(Math.round(performance.now() - t));
      }
      return 'select each ms: ' + times.join(',') + ' | ' + (await sized('debug.exchange', { id: rows()[0].dataset.exchange })) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'filter-keystrokes',
    `profile:(async () => { ${METER}
      const box = document.querySelector('main input[aria-label="Filter exchanges"]');
      const lag = [], total = [];
      let typed = '';
      for (const ch of 'items/42') { typed += ch; const t = performance.now(); setInput(box, typed); await new Promise((r) => requestAnimationFrame(r)); lag.push(performance.now() - t); await ${painted}(); total.push(performance.now() - t); }
      await __t.sleep(800);
      const shown = rows().length;
      setInput(box, ''); await __t.sleep(800);
      return 'input lag max ms: ' + Math.round(Math.max(...lag)) + ' | keystroke painted max ms: ' + Math.round(Math.max(...total)) + ' avg: ' + Math.round(total.reduce((a, b) => a + b) / total.length) + ' | rows shown: ' + shown + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'sort-and-scroll',
    `profile:(async () => { ${METER}
      const head = vis('main [data-debugger-grid] [role=columnheader]').find((h) => h.textContent.trim().startsWith('Duration'));
      let t = performance.now(); head.click(); await ${painted}(); const sort = Math.round(performance.now() - t);
      t = performance.now(); head.click(); await ${painted}(); const sort2 = Math.round(performance.now() - t);
      const list = document.querySelector('main [data-debugger-grid] .flex-1.overflow-auto, main [data-debugger-grid] [style*="overflow"]') ?? rows()[0].parentElement.parentElement.parentElement;
      const frames = [];
      for (let i = 0; i < 20; i++) { t = performance.now(); list.scrollTop += 1500; await ${painted}(); frames.push(Math.round(performance.now() - t)); }
      vis('main [data-debugger-grid] [role=columnheader]').find((h) => h.textContent.trim().startsWith('#'))?.click(); await __t.sleep(200);
      return 'sort ms: ' + sort + ' | sort back ms: ' + sort2 + ' | scroll frame ms: ' + frames.join(',') + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'structure-and-performance',
    `profile:(async () => { ${METER}
      const rail = (l) => document.querySelector('[data-tool-rail] button[aria-label="' + l + '"]');
      const open = async (l) => { const t = performance.now(); rail(l).click(); await ${painted}(); return Math.round(performance.now() - t); };
      const s = await open('Structure'); const p = await open('Performance');
      return 'structure ms: ' + s + ' | performance ms: ' + p + ipc() + loaf();
    })()`,
    true,
  ],
];
module.exports = withExpect(steps, {});
