// Performance of the Console (the bottom panel) while requests stream in: 620 requests sent four at a time, past its
// 500-entry buffer. The rows that stay are not drawn again as entries arrive and old ones leave (rows keyed by the entry,
// entries sent in batches), so the window keeps its frames, and a row opened to read stays open while the buffer slides.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => [...document.querySelectorAll('[data-output="console"] > div')].filter((d) => d.querySelector('button'));
  const rowOf = (n) => rows().find((r) => r.querySelector('[title$="console-perf=' + n + '"]'));
  const send = async (from, to) => {
    for (let i = from; i < to; i += 4)
      await Promise.all([0, 1, 2, 3].filter((k) => i + k < to).map((k) => window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:4010/health?console-perf=' + (i + k), headers: [] } }).catch(() => undefined)));
  };
`;
const step = stepOf(H);

const steps = [
  step(
    'fill-the-console',
    `await window.aps.invoke('console.clear');
     const c = [...document.querySelectorAll('footer button')].find((x) => x.textContent.trim() === 'Console');
     if (!c) return 'NO BUTTON Console';
     if (!document.querySelector('[data-bottom-tab="console"][aria-selected="true"]')) c.click();
     await __t.waitFor(() => document.querySelector('[data-output="console"]'), 4000);
     await send(0, 520);
     const ok = await __t.waitFor(() => (rowOf(519) ? true : null), 15000);
     return 'filled: ' + !!ok + ' | rows: ' + rows().length;`,
  ),
  step(
    'stream-past-the-buffer',
    `// open a recent entry, then send 100 more while measuring the frames
     const r = rowOf(510); if (!r) return 'NO ROW 510';
     r.querySelector('button').click(); await __t.sleep(200);
     if (r.querySelector('button').getAttribute('aria-expanded') !== 'true') return 'DID NOT EXPAND';
     const longTasks = []; const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(Math.round(e.duration)))); po.observe({ entryTypes: ['longtask'] });
     let last = performance.now(); let worst = 0; let frames = 0; let running = true;
     const tick = (t) => { worst = Math.max(worst, t - last); last = t; frames++; if (running) requestAnimationFrame(tick); };
     requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
     const t0 = performance.now();
     await send(520, 620);
     await __t.waitFor(() => (rowOf(619) ? true : null), 15000);
     await __t.sleep(300);
     running = false; po.disconnect();
     const took = Math.round(performance.now() - t0);
     const again = rowOf(510);
     const open = again?.querySelector('button')?.getAttribute('aria-expanded') === 'true';
     return 'worst frame ms: ' + Math.round(worst) + ' | long tasks: ' + (longTasks.filter((d) => d > 50).join(',') || 'none') + ' | rows: ' + rows().length + ' | still open: ' + open + ' | frames: ' + frames + ' | took ms: ' + took;`,
  ),
];

const num = (s, key) => Number((new RegExp(key + ': (-?\\d+)').exec(s) || [])[1]);
module.exports = withExpect(steps, {
  'fill-the-console': /^filled: true \| rows: 500$/,
  'stream-past-the-buffer': (r) => (num(r, 'worst frame ms') < 50 && /long tasks: none/.test(r) && /rows: 500 /.test(r) && /still open: true/.test(r) ? undefined : 'janky or lost: ' + r),
});
