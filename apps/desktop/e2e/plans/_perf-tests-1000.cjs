// Not part of the suite (the _ prefix): a CPU profile of the Tests view opening a 500-step file (editor and Flow tab)
// and of the run panel (the one the Evaluations view shows too) with a 1,000-result run against the demo server on
// 127.0.0.1:4010. Build with TESTPION_PROFILE=1, then  npm run e2e -- --only _perf-tests-1000 ; each step's result
// lists the app functions with the most time, the IPC calls it made (count, ms, KB of result), and <step>.cpuprofile
// opens in DevTools ▸ Performance.
const { withExpect } = require('../lib.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function testFile(n) {
  const lines = ['# A big test file for profiling the Tests view.', 'defaults:', '  type: http', '  tags: [perf]', 'tests:'];
  for (let i = 0; i < n; i++) {
    lines.push(
      `  - id: step-${i}`,
      `    name: Step ${i} checks the demo server`,
      `    method: GET`,
      `    url: "http://127.0.0.1:4010/health?step=${i}"`,
      `    assertions:`,
      `      - { type: status, expected: 200 }`,
      `      - { type: latency, max: 5000 }`,
      '',
    );
  }
  return lines.join('\n');
}
function prepare(ws) {
  mkdirSync(join(ws, 'tests', 'perf'), { recursive: true });
  writeFileSync(join(ws, 'tests', 'perf', 'big-500.yaml'), testFile(500));
  writeFileSync(join(ws, 'tests', 'perf', 'big-1000.yaml'), testFile(1000));
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
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const treeRow = (name) => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name));
  const resultRows = () => vis('main button[data-result]');
`;
const steps = [
  [
    'meter',
    `(async () => { ${METER} await __t.view('Tests'); await __t.sleep(800); const f = treeRow('perf'); if (f && f.getAttribute('aria-expanded') === 'false') f.click(); await __t.sleep(500); return treeRow('big-500.yaml') ? 'ok' : 'NO ROW big-500.yaml'; })()`,
    false,
  ],
  [
    'open-500-step-file',
    `profile:(async () => { ${METER}
      const r = treeRow('big-500.yaml'); if (!r) return 'NO ROW';
      const t0 = performance.now(); r.click();
      await __t.waitFor(() => (document.querySelector('main .monaco-editor .view-lines')?.textContent?.includes('step-') ? true : null), 20000); await ${painted}();
      return 'file open ms: ' + Math.round(performance.now() - t0) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'flow-tab-500',
    `profile:(async () => { ${METER}
      const tab = vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Flow')); if (!tab) return 'NO TAB Flow';
      const t0 = performance.now(); tab.click();
      await __t.waitFor(() => (document.querySelectorAll('[data-flow-node]').length > 400 ? true : null), 20000); await ${painted}();
      const ms = Math.round(performance.now() - t0);
      const back = vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Editor')); const t1 = performance.now(); back?.click(); await ${painted}();
      const tree = await window.aps.invoke('tests.tree'); const find = (ns) => { for (const n of ns) { if (n.name === 'big-500.yaml') return n.path; const p = n.items ? find(n.items) : n.children ? find(n.children) : undefined; if (p) return p; } };
      const p500 = find(tree);
      return 'flow ms: ' + ms + ' | ' + (p500 ? (await sized('tests.flow', { file: p500 })) + ' | ' + (await sized('tests.read', { path: p500 })) : 'no path') + ' | nodes: ' + document.querySelectorAll('[data-flow-node]').length + ' | back to editor ms: ' + Math.round(performance.now() - t1) + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'run-1000',
    `(async () => { ${METER}
      const f = treeRow('big-1000.yaml'); if (!f) return 'NO ROW big-1000'; f.click(); await __t.sleep(1500);
      const workers = vis('main input[type=number]')[0]; if (workers) setInput(workers, '16'); await __t.sleep(200);
      const run = vis('main button').find((b) => b.textContent.trim() === 'Run'); if (!run) return 'NO BUTTON Run';
      const t0 = performance.now(); run.click();
      const ok = await __t.waitFor(() => (/\\b1000\\/1000\\b/.test(document.querySelector('main')?.textContent ?? '') ? true : null), 170000);
      return 'run done: ' + !!ok + ' | ms: ' + Math.round(performance.now() - t0) + ' | result rows in dom: ' + resultRows().length + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'results-scroll-1000',
    `profile:(async () => { ${METER}
      const el = resultRows()[0]?.closest('.overflow-auto'); if (!el) return 'NO LIST';
      const frames = [];
      for (let i = 0; i < 20; i++) { const t = performance.now(); el.scrollTop += 900; await ${painted}(); frames.push(Math.round(performance.now() - t)); }
      el.scrollTop = 0; await ${painted}();
      const runs = await window.aps.invoke('runs.list', { limit: 1 }); const runId = runs.items[0]?.id;
      return 'scroll frame ms: ' + frames.join(',') + ' | scrollHeight: ' + el.scrollHeight + ' | ' + (runId ? (await sized('runs.results', { runId, offset: 0, limit: 200 })) + ' | ' + (await sized('runs.summary', { runId })) : 'no run') + ipc() + loaf();
    })()`,
    false,
  ],
  [
    'results-select-and-filter',
    `profile:(async () => { ${METER}
      const times = [];
      for (let i = 0; i < 8; i++) { const r = resultRows()[i * 2]; if (!r) break; const t = performance.now(); r.click(); await __t.sleep(60); await ${painted}(); times.push(Math.round(performance.now() - t)); }
      const box = vis('main input').find((i) => /filter by name/i.test(i.placeholder)); if (!box) return 'select each ms: ' + times.join(',') + ' | NO INPUT filter';
      const total = []; let typed = '';
      for (const ch of 'Step 77') { typed += ch; const t = performance.now(); setInput(box, typed); await ${painted}(); total.push(Math.round(performance.now() - t)); }
      await __t.sleep(900);
      const shown = resultRows().length; setInput(box, ''); await __t.sleep(500);
      return 'select each ms: ' + times.join(',') + ' | filter keystroke ms: ' + total.join(',') + ' | rows after: ' + shown + ipc() + loaf();
    })()`,
    true,
  ],
];
module.exports = withExpect(steps, {}, { prepare });
