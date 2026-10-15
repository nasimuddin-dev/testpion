// Evaluations as a matrix, with real mouse, wheel and keys (__t.real): ten saved evaluations (prompt × model variants)
// of 5,000 cases each are run for real with the CLI before the app starts (the mock provider, a lexical similarity
// evaluator, tags in the dataset). The Matrix switch shows cases × variants; a baseline colours the cells by regression
// and improvement with the delta; the filter chips, a tag, the search and a column's sort narrow it; a cell opens the
// case (input, output, the checks) with the baseline's result one click away; scrolling 5,000 rows keeps few rows in
// the DOM and the frames short.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { withExpect } = require('../lib.cjs');

const N = 5000;
const V = 10;
const WORDS = ['refund', 'booking', 'cancel', 'refill', 'billing', 'other', 'urgent'];
const name = (v) => `Matrix v${v + 1}`;

/** Ten saved evaluations over one 5,000-record dataset, run with the CLI (4 at a time) into the workspace's history. */
async function prepare(ws, out) {
  const dataset = Array.from({ length: N }, (_, i) =>
    JSON.stringify({
      id: String(i + 1),
      input: `case ${i + 1} about ${WORDS[i % 7]} and ${WORDS[(i * 3) % 7]}`,
      expected: `${WORDS[i % 7]} ${WORDS[(i * 5) % 7]}`,
      tags: [WORDS[i % 7], i % 10 === 0 ? 'edge' : 'core'],
    }),
  ).join('\n');
  const items = Array.from({ length: V }, (_, v) => ({
    id: `e2e-matrix-${v}`,
    name: name(v),
    data: {
      name: name(v),
      type: 'llm',
      provider: 'mock',
      model: `mock-${v % 2 ? 'b' : 'a'}`,
      prompt: `Variant ${v}: {{input}} ${WORDS[v % 7]} ${WORDS[(v + 2) % 7]}`,
      format: 'text',
      datasetFormat: 'jsonl',
      dataset,
      expectedField: 'expected',
      evaluators: [{ type: 'similarity', expected: '{{expected}}', threshold: 0.25 }],
      concurrency: 16,
      retries: 0,
    },
  }));
  mkdirSync(join(ws, 'library'), { recursive: true });
  writeFileSync(join(ws, 'library', 'evaluations.json'), JSON.stringify({ schemaVersion: '1.0', folders: [], items }, null, 2));
  const cli = resolve(__dirname, '..', '..', '..', '..', 'packages', 'cli', 'bin', 'testpion.js');
  const runOne = (v) =>
    new Promise((ok, fail) => {
      const p = spawn(process.execPath, [cli, 'eval', 'run', name(v), '-w', ws, '-q', '-r', 'json'], { env: { ...process.env, TESTPION_HOME: dirname(ws), NO_COLOR: '1' }, stdio: 'ignore' });
      // exit 1: some cases failed (they are meant to)
      p.on('exit', (code) => (code === 0 || code === 1 ? ok() : fail(new Error(`eval run ${name(v)} exited ${code}`))));
    });
  const t0 = Date.now();
  // one at a time per database writer is not needed: each run records itself when it ends; 4 runs side by side
  const queue = Array.from({ length: V }, (_, v) => v);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let v = queue.shift(); v !== undefined; v = queue.shift()) await runOne(v);
    }),
  );
  writeFileSync(join(out, 'prepare.txt'), `${V} runs × ${N} cases in ${Date.now() - t0} ms\n`);
}

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(50)) { const v = await fn(); if (v) return v; } return undefined; };
  const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const matrix = () => vis('[data-eval-matrix]')[0];
  const rows = () => vis('[data-matrix-row]').filter((r) => r.dataset.matrixRow !== 'loading');
  const loading = () => vis('[data-matrix-row="loading"]').length;
  const settled = () => until(() => matrix() && rows().length && !loading() ? rows() : null, 10000);
  const chip = (label) => vis('[data-eval-matrix] [role=radio]').find((b) => b.textContent.trim().startsWith(label));
  const count = (label) => Number((chip(label)?.textContent.match(/\\d+/) ?? ['-1'])[0]);
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const R = __t.real;
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-the-matrix',
    `await __t.view('Evaluations'); await __t.sleep(800);
     const sw = await until(() => vis('[role=radio]').find((b) => b.textContent.trim() === 'Matrix'), 10000); if (!sw) return 'NO MATRIX SWITCH';
     const t0 = performance.now();
     await R.click(sw);
     const r = await settled(); if (!r) return 'NO ROWS';
     await painted();
     const ms = Math.round(performance.now() - t0);
     const m = matrix();
     console.log('[eval-matrix] first paint of 5000×10: ' + ms + ' ms');
     return 'cases: ' + m.dataset.cases + ' | columns: ' + vis('[data-matrix-column]').length + ' | rows in the DOM: ' + (rows().length < 80 ? 'few' : rows().length) + ' | first rows: ' + rows().slice(0, 3).map((x) => x.dataset.matrixRow).join(',') + ' | measured: ' + ms + ' ms';`,
  ),
  step(
    'pick-a-baseline',
    `const sel = vis('[data-eval-matrix] select[aria-label="Baseline run"]')[0]; if (!sel) return 'NO BASELINE PICKER';
     const opt = [...sel.options].find((o) => o.textContent.startsWith('Matrix v1 ')); if (!opt) return 'NO RUN OF Matrix v1';
     setSelect(sel, opt.value);
     // the page compared with that baseline has come (the chips count against it)
     if (!(await until(() => matrix().dataset.baseline === opt.value && chip('Regressed') ? true : null))) return 'NO REGRESSED CHIP';
     await settled(); await __t.sleep(300);
     const cells = vis('[data-cell-change]');
     const kinds = [...new Set(cells.map((c) => c.dataset.cellChange))].sort().join(',');
     // the baseline's own column is unchanged everywhere; others regress and improve somewhere
     const reg = count('Regressed'), imp = count('Improved');
     return 'regressed: ' + (reg > 0 ? 'some' : reg) + ' | improved: ' + (imp > 0 ? 'some' : imp) + ' | on screen: ' + kinds + ' | coloured: ' + vis('[data-cell-change="regressed"]').filter((c) => getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)').length + ' red';`,
  ),
  step(
    'regressed-only',
    `const c = chip('Regressed'); const n = count('Regressed');
     await R.click(c);
     if (!(await until(() => Number(matrix().dataset.total) === n ? true : null))) return 'NOT FILTERED: ' + matrix().dataset.total + ' vs ' + n;
     const r = await settled();
     const every = r.every((row) => row.querySelector('[data-cell-change="regressed"]'));
     return 'total matches the chip: ' + (Number(matrix().dataset.total) === n) + ' | every row on screen has a regression: ' + every;`,
  ),
  step(
    'a-tag',
    `await R.click(chip('All')); await until(() => Number(matrix().dataset.total) === ${N} ? true : null);
     const tag = vis('[data-eval-matrix] select[aria-label="Tag"]')[0]; if (!tag) return 'NO TAG PICKER';
     setSelect(tag, 'edge');
     if (!(await until(() => Number(matrix().dataset.total) === ${N / 10} ? true : null))) return 'NOT FILTERED BY TAG: ' + matrix().dataset.total;
     const r = await settled();
     const ok = r.every((row) => Number(row.dataset.matrixRow) % 10 === 1);
     setSelect(tag, ''); await until(() => Number(matrix().dataset.total) === ${N} ? true : null);
     return 'edge cases: ' + ${N / 10} + ' | rows are the edge records: ' + ok;`,
  ),
  step(
    'search-with-the-keyboard',
    `const box = vis('[data-eval-matrix] input[aria-label="Find a case"]')[0]; if (!box) return 'NO SEARCH';
     await R.click(box); await R.type('4242');
     if (!(await until(() => Number(matrix().dataset.total) === 1 ? true : null))) return 'NOT FOUND: ' + matrix().dataset.total;
     const r = await settled();
     const found = r.map((x) => x.dataset.matrixRow).join(',');
     await R.key('a', { ctrl: true }); await R.key('Backspace');
     await until(() => Number(matrix().dataset.total) === ${N} ? true : null);
     return 'found: ' + found + ' | cleared: ' + matrix().dataset.total;`,
  ),
  step(
    'sort-by-a-column',
    `const head = vis('[data-matrix-column]')[3]; if (!head) return 'NO COLUMN';
     await R.click(head); await __t.sleep(200);
     const r = await settled();
     const scores = r.slice(0, 20).map((row) => row.querySelectorAll('[data-cell-status]')[3]).map((c) => parseFloat(c?.textContent.replace(/[^\\d.]+/g, ' ').trim().split(' ').pop() ?? 'NaN'));
     const asc = scores.every((s, i) => i === 0 || s >= scores[i - 1]);
     await R.click(head); await __t.sleep(200);
     const r2 = await settled();
     const top = parseFloat(r2[0].querySelectorAll('[data-cell-status]')[3].textContent.replace(/[^\\d.]+/g, ' ').trim().split(' ').pop());
     return 'ascending: ' + asc + ' | then descending from the top score: ' + (top >= scores[scores.length - 1]);`,
  ),
  step(
    'open-a-case',
    `await R.click(chip('Regressed')); await until(() => Number(matrix().dataset.total) === count('Regressed') ? true : null);
     const r = await settled();
     const cell = r[0].querySelector('[data-cell-change="regressed"]'); if (!cell) return 'NO REGRESSED CELL';
     await R.click(cell);
     const detail = await until(() => vis('[data-eval-cell-detail]')[0], 6000); if (!detail) return 'NO DETAIL';
     if (!(await until(() => /Mock response/.test(detail.textContent) ? true : null, 6000))) return 'NO OUTPUT: ' + detail.textContent.slice(0, 200);
     const run = detail.dataset.evalCellDetail;
     const base = vis('[data-eval-cell-detail] [role=radio]').find((b) => b.textContent.trim() === 'Baseline'); if (!base) return 'NO BASELINE SWITCH';
     await R.click(base);
     const other = await until(() => { const d = vis('[data-eval-cell-detail]')[0]; return d && d.dataset.evalCellDetail !== run && /Mock response/.test(d.textContent) ? d : null; }, 6000);
     const close = vis('[data-eval-cell-detail] button').find((b) => b.textContent.trim() === 'Close'); await R.click(close);
     const gone = await until(() => !vis('[data-eval-cell-detail]').length ? true : null, 3000);
     return 'run result: ' + run.replace(/:\\d+$/, ':N') + ' | baseline result: ' + (other ? other.dataset.evalCellDetail.replace(/:\\d+$/, ':N') : 'NONE') + ' | output shown | closed: ' + !!gone;`,
  ),
  step(
    'scroll-5000-rows',
    `await R.click(chip('All')); await until(() => Number(matrix().dataset.total) === ${N} ? true : null);
     // by case again (the step before sorted by a column)
     const sort = vis('[data-eval-matrix] select[aria-label="Sort"]')[0]; setSelect(sort, 'case:asc');
     await until(() => rows()[0]?.dataset.matrixRow === '1' ? true : null);
     await settled();
     const list = vis('[data-eval-matrix] .overflow-auto').find((x) => x.scrollHeight > x.clientHeight * 10); if (!list) return 'NO LIST';
     // long animation frames, with what ran in them (for the log: where a slow frame's time went)
     const loafs = [];
     const po = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame') ? new PerformanceObserver((l) => loafs.push(...l.getEntries())) : null;
     po?.observe({ type: 'long-animation-frame' });
     let worst = 0, frames = 0, last = performance.now(), on = true;
     const tick = (t) => { worst = Math.max(worst, t - last); last = t; frames++; if (on) requestAnimationFrame(tick); };
     requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
     const t0 = performance.now();
     // the wheel, as a user scrolls: 40 notches down
     for (let i = 0; i < 40; i++) await R.wheel(list, 600);
     const wheelMs = Math.round(performance.now() - t0);
     // a jump to the end (the scrollbar dragged down): rows there are paged in
     const t1 = performance.now();
     list.scrollTop = list.scrollHeight;
     const end = await until(() => rows().some((r) => r.dataset.matrixRow === '${N}') && !loading() ? true : null, 8000);
     const jumpMs = Math.round(performance.now() - t1);
     on = false; await painted(); po?.disconnect();
     // the renderer alone (no input injection between frames): 60 frames of scrolling back up, 2,000 px a frame
     let worstOwn = 0, prev = 0;
     const own = [];
     const po2 = po ? new PerformanceObserver((l) => own.push(...l.getEntries())) : null;
     po2?.observe({ type: 'long-animation-frame' });
     for (let i = 0; i < 60; i++) { list.scrollTop = Math.max(0, list.scrollTop - 2000); const t = await new Promise((r) => requestAnimationFrame(r)); if (prev) worstOwn = Math.max(worstOwn, t - prev); prev = t; }
     await painted(); po2?.disconnect();
     const ownSlow = own.sort((a, b) => b.duration - a.duration).slice(0, 3).map((f) => Math.round(f.duration) + ' ms (blocking ' + Math.round(f.blockingDuration) + ', style+layout ' + Math.round(f.styleAndLayoutStart ? f.startTime + f.duration - f.styleAndLayoutStart : 0) + ', render ' + Math.round(f.renderStart ? f.startTime + f.duration - f.renderStart : 0) + ', scripts: ' + f.scripts.map((x) => (x.invoker || x.sourceFunctionName || '?') + ' ' + Math.round(x.duration)).join(', ') + ')');
     const slow = loafs.sort((a, b) => b.duration - a.duration).slice(0, 3).map((f) => Math.round(f.duration) + ' ms (render ' + Math.round(f.renderStart ? f.startTime + f.duration - f.renderStart : 0) + ' ms, scripts: ' + f.scripts.map((x) => (x.invoker || x.sourceFunctionName || '?') + ' ' + Math.round(x.duration)).join(', ') + ')');
     console.log('[eval-matrix] slowest frames: ' + (slow.join(' | ') || 'none over 50 ms'));
     const dom = vis('[data-matrix-row]').length;
     const heap = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576);
     console.log('[eval-matrix] 5000×10 scroll: 40 wheel notches ' + wheelMs + ' ms, jump to the end ' + jumpMs + ' ms, longest frame ' + Math.round(worst) + ' ms over ' + frames + ' frames, ' + dom + ' rows in the DOM, heap ' + heap + ' MB');
     return 'last row reached: ' + !!end + ' | rows in the DOM: ' + (dom < 80 ? 'few' : dom) + ' | longest frame: ' + (worst < 200 ? 'under 200 ms' : Math.round(worst) + ' ms') + ' | measured: wheel ' + wheelMs + ' ms, jump ' + jumpMs + ' ms, longest frame ' + Math.round(worst) + ' ms over ' + frames + ' frames (the renderer alone, scrolling 2,000 px a frame: longest ' + Math.round(worstOwn) + ' ms: ' + (ownSlow.join(' | ') || 'no long frame') + '), heap ' + heap + ' MB; slowest frames: ' + (slow.join(' | ') || 'none over 50 ms');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'open-the-matrix': /^cases: 5000 \| columns: 10 \| rows in the DOM: few \| first rows: 1,2,3 \| measured: /,
    'pick-a-baseline': /^regressed: some \| improved: some \| on screen: .*regressed.* \| coloured: [1-9]\d* red$/,
    'regressed-only': /^total matches the chip: true \| every row on screen has a regression: true$/,
    'a-tag': /^edge cases: 500 \| rows are the edge records: true$/,
    'search-with-the-keyboard': /^found: 4242 \| cleared: 5000$/,
    'sort-by-a-column': /^ascending: true \| then descending from the top score: true$/,
    'open-a-case': /^run result: matrix-v\d+:N \| baseline result: matrix-v1:N \| output shown \| closed: true$/,
    'scroll-5000-rows': /^last row reached: true \| rows in the DOM: few \| longest frame: under 200 ms \| measured: /,
  },
  { prepare },
);
