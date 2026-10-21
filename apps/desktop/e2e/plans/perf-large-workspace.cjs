// Performance with a large workspace: a collection of 500 requests in 25 folders (like a big Postman import).
// Each step reports milliseconds; the expectations are ceilings, loose enough for a busy CI machine, so a
// regression that makes an interaction several times slower fails here.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');
const { closeSync, mkdirSync, openSync, writeFileSync, writeSync } = require('node:fs');
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
        preRequestScript: n % 3 ? 'tp.variables.set("page", "1");' : undefined,
        testScript: 'tp.test("ok", () => tp.response.to.have.status(200));',
        assertions: [{ type: 'status', equals: 200 }],
      });
    }
    items.push({ kind: 'folder', id: `big-folder-${f}`, name: `Folder ${f}`, items: reqs });
  }
  writeFileSync(join(ws, 'collections', 'big.json'), JSON.stringify({ schemaVersion: '1.0', id: 'big', name: 'Big collection', variables: [{ key: 'page', value: '1', enabled: true }], items }, null, 2));
}

/**
 * A finished RAG run of 5,000 samples x 40 metrics (the metrics matrix budget, planning/rag-testing.md section 5.1): written as the
 * runner writes it, one result per line, so the matrix is built from a real results file.
 */
const RAG_RUN = 'perf-rag-5000';
const RAG_METRICS = ['faithfulness', 'answer-relevance', 'context-precision', 'context-recall', 'context-relevance', 'factual-correctness', 'answer-correctness', 'hallucination', 'correctness', 'completeness', 'factuality', 'citation-accuracy', 'claim-precision', 'claim-recall', 'claim-f1', 'noise-sensitivity-relevant', 'context-precision-ids', 'context-recall-ids', 'mrr@k', 'map@k', 'token-f1', 'rouge', 'string-similarity', 'bleu', 'chrf', 'semantic-similarity', 'toxicity', 'bias', 'pii-leakage', 'refusal-correctness', 'knowledge-retention', 'turn-relevancy', 'topic-adherence', 'trajectory-match', 'tool-call-f1', 'goal-accuracy', 'g-eval', 'summarization', 'latency', 'tokens'];
function ragRun(ws) {
  const dir = join(ws, 'runs', RAG_RUN);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, 'results.jsonl'), 'w');
  for (let i = 0; i < 5000; i++) {
    const checks = RAG_METRICS.map((id, k) => {
      const score = ((i * 31 + k * 17) % 101) / 100;
      if ((i + k) % 29 === 0) return { type: id, name: id, passed: true, source: 'ai-judge', message: id + ' is n/a: nothing to judge', metadata: { na: 'nothing to judge', metric: id } };
      return { type: id, name: id, passed: score >= 0.5, source: 'ai-judge', message: id + ' ' + score + ': 3 of 4 supported', score, metadata: { threshold: 0.5, metric: id } };
    });
    const r = { id: 'perf:' + i, name: 'sample ' + i, type: 'rag', status: 'passed', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 5, attempts: 1, checks, tags: ['tag-' + (i % 12), i % 2 ? 'odd' : 'even'], metadata: { rag: { query: 'question ' + i } } };
    writeSync(fd, `${JSON.stringify(r)}\n`);
  }
  closeSync(fd);
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
      // the tree draws only the rows on screen: data-tree-rows counts every row it shows
      const treeRows = () => Number(document.querySelector('aside [data-tree-rows]')?.getAttribute('data-tree-rows') ?? 0);
      // checked every frame (waitFor's 50 ms steps would round the time up)
      for (const end = performance.now() + 10000; treeRows() <= 400 && performance.now() < end; ) await new Promise((r) => requestAnimationFrame(r));
      await ${painted}();
      return 'rows: ' + treeRows() + ' | open ms: ' + opened + ' | expand ms: ' + ${ms('t1')} + ' | drawn: ' + document.querySelectorAll('aside [data-tree-row]').length + ' | dom nodes: ' + document.getElementsByTagName('*').length;
    })()`,
  ],
  [
    // MENU-1: a row's menu is built only while it opens: on the expanded big tree, the time from the right-click until the
    // menu is in the page (best of three, never one sample), and until it is painted
    'open-a-menu',
    `(async () => {
      const close = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.waitFor(() => !document.querySelector('[role=menu]'), 1500); };
      const builds = []; const paints = [];
      for (let i = 0; i < 3; i++) {
        const rows = [...document.querySelectorAll('aside [data-node-id] [data-tree-row]')].filter((b) => b.offsetParent && /Request \\d+ of folder/.test(b.textContent));
        const row = rows[(i * 7) % Math.max(1, rows.length)]?.parentElement; if (!row) return 'NO ROW';
        const t0 = performance.now();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
        for (const end = performance.now() + 2000; !document.querySelector('[role=menu]') && performance.now() < end; ) await new Promise((r) => requestAnimationFrame(r));
        builds.push(performance.now() - t0);
        await ${painted}();
        paints.push(performance.now() - t0);
        await close();
      }
      return 'menu open ms: ' + Math.round(Math.min(...builds)) + ' | painted ms: ' + Math.round(Math.min(...paints)) + ' | rows: ' + document.querySelector('aside [data-tree-rows]')?.getAttribute('data-tree-rows');
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
      for (const r of rows) { r.click(); r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await ${painted}(); }
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
    // the metrics matrix of a run of 5,000 samples x 40 metrics: the page, the by-tag and chart data come with it; a re-cut (sorted by a metric) is another call
    'rag-matrix-5000-by-40',
    `(async () => {
      const t0 = performance.now();
      const m = await window.aps.invoke('rag.matrix', { runId: '${RAG_RUN}', offset: 0, limit: 50 });
      const first = ${ms('t0')};
      const t1 = performance.now();
      const s = await window.aps.invoke('rag.matrix', { runId: '${RAG_RUN}', offset: 0, limit: 50, sort: m.columns[0].key });
      return 'total: ' + m.total + ' | columns: ' + m.columns.length + ' | rows: ' + m.rows.length + ' | tags: ' + m.byTag.length + ' | bins: ' + m.aggregates[0].distribution.length + ' | first ms: ' + first + ' | re-cut ms: ' + ${ms('t1')} + ' | sorted rows: ' + s.rows.length;
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
    // the two-frame floor is 33 ms (memory ui-perf-profiling): the menu itself must be in the page within it
    'open-a-menu': (r) => num(r, 'menu open') <= 33 && num(r, 'painted') < 100 ? undefined : 'slow: ' + r,
    'filter-tree': (r) => num(r, 'max keystroke') < 200 ? undefined : 'slow: ' + r,
    'open-tabs-and-type': (r) => (SCALE > 1 || /^tabs: 1[23] \|/.test(r)) && num(r, 'open 12') < 1500 && num(r, 'max keystroke') < 150 && num(r, '10 switches') < 1200 ? undefined : 'slow or wrong: ' + r,
    'save-and-refresh': (r) => num(r, 'save to tree') < 3000 ? undefined : 'slow: ' + r,
    'rag-matrix-5000-by-40': (r) => /^total: 5000 \| columns: 40 \| rows: 50 \| tags: 14 \| bins: 10 /.test(r) && num(r, 'first') < 10000 && num(r, 're-cut') < 10000 && /sorted rows: 50$/.test(r) ? undefined : 'slow or wrong: ' + r,
  },
  { prepare: (ws) => (bigCollection(ws), ragRun(ws)) },
);
module.exports.bigCollection = bigCollection;
