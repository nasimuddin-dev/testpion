// Not part of the suite (the _ prefix): a CPU profile of the History view with 5,000 entries and the Traces view with
// the same 5,000 traces (made by sending 5,000 requests to the demo server on 127.0.0.1:4010): opening, scrolling,
// selecting, filtering. Build with TESTPION_PROFILE=1, then  npm run e2e -- --only _perf-history-traces ; each step's
// result lists the app functions with the most time, the IPC calls it made (count, ms, KB of result), and
// <step>.cpuprofile opens in DevTools ▸ Performance.
const { withExpect } = require('../lib.cjs');

const SENDS = 5000;
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
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  // the rows of the view's list: the buttons the VirtualList renders (absolutely placed divs in its tall inner div)
  const listRows = () => vis('main .overflow-auto.relative > div > div > button');
  const listEl = () => listRows()[0]?.closest('.overflow-auto');
`;
/** The view's list: keystrokes in its filter box, 20 scroll frames, 8 selections; one result line. */
const viewSteps = (label, filterLabel, picker) => [
  [
    `open-${label.toLowerCase()}`,
    `profile:(async () => { ${METER}
      const t0 = performance.now();
      document.querySelector('nav [aria-label="${label}"]').click();
      // the view is current and its own rows are painted (the previous view's rows stay in the DOM, hidden)
      await __t.waitFor(() => document.querySelector('nav [aria-label="${label}"][aria-current="page"]'), 10000); await ${painted}();
      await __t.waitFor(() => (${picker}().length > 5 ? true : null), 20000); await ${painted}();
      const l = await window.aps.invoke('${label === 'History' ? 'history' : 'traces'}.list', { limit: 1 }); const one = l.items[0];
      return '${label} shown ms: ' + Math.round(performance.now() - t0) + ' | rows in dom: ' + ${picker}().length + ' | ' + (await sized('${label === 'History' ? 'history' : 'traces'}.list', { limit: 200 })) + ' | ' + (await sized('${label === 'History' ? 'history' : 'traces'}.get', { id: one.id })) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    `scroll-${label.toLowerCase()}`,
    `profile:(async () => { ${METER}
      const el = listEl();
      if (!el) return 'NO LIST';
      const frames = [];
      for (let i = 0; i < 20; i++) { const t = performance.now(); el.scrollTop += 1200; await ${painted}(); frames.push(Math.round(performance.now() - t)); }
      el.scrollTop = 0; await ${painted}();
      return 'scroll frame ms: ' + frames.join(',') + ' | scrollHeight: ' + el.scrollHeight + ipc() + loaf();
    })()`,
    false,
  ],
  [
    `select-${label.toLowerCase()}`,
    `profile:(async () => { ${METER}
      const times = [];
      for (let i = 0; i < 8; i++) { const r = ${picker}()[i * 2]; if (!r) break; const t = performance.now(); r.click(); await __t.sleep(60); await ${painted}(); times.push(Math.round(performance.now() - t)); }
      return 'select each ms: ' + times.join(',') + ipc() + loaf();
    })()`,
    false,
  ],
  [
    `filter-${label.toLowerCase()}`,
    `profile:(async () => { ${METER}
      const box = vis('main input').find((i) => /${filterLabel}/i.test(i.placeholder + ' ' + i.getAttribute('aria-label')));
      if (!box) return 'NO INPUT filter';
      const lag = [], total = []; let typed = '';
      for (const ch of 'health?n=4') { typed += ch; const t = performance.now(); setInput(box, typed); await new Promise((r) => requestAnimationFrame(r)); lag.push(performance.now() - t); await ${painted}(); total.push(performance.now() - t); }
      await __t.sleep(900);
      const shown = ${picker}().length;
      setInput(box, ''); await __t.sleep(600);
      return 'input lag max ms: ' + Math.round(Math.max(...lag)) + ' | keystroke painted max ms: ' + Math.round(Math.max(...total)) + ' avg: ' + Math.round(total.reduce((a, b) => a + b) / total.length) + ' | rows after: ' + shown + ipc() + loaf();
    })()`,
    true,
  ],
];
const steps = [
  [
    'send-5000',
    `(async () => { ${METER}
      const t0 = performance.now();
      let n = 0, failed = 0;
      const worker = async () => { while (n < ${SENDS}) { const i = n++; try { await window.aps.invoke('http.send', { name: 'perf ' + i, request: { method: 'GET', url: 'http://127.0.0.1:4010/health?n=' + i, headers: [] } }); } catch { failed++; } } };
      await Promise.all(Array.from({ length: 24 }, worker));
      const h = await window.aps.invoke('history.list', { limit: 1 });
      const tr = await window.aps.invoke('traces.list', { limit: 1 });
      return 'sent in ms: ' + Math.round(performance.now() - t0) + ' | failed: ' + failed + ' | history total: ' + h.total + ' | traces total: ' + tr.total;
    })()`,
    false,
  ],
  ...viewSteps('History', 'search|filter|history', 'listRows'),
  ...viewSteps('Traces', 'search|filter|trace', 'listRows'),
];
module.exports = withExpect(steps, {});
