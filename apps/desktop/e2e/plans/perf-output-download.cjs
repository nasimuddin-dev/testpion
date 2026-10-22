// Performance of the down arrow with a big output: a 50 MB response body saved as pretty JSON. The bytes go from the
// spooled payload to the file in the backend (re-indented as they stream), never through the window: the window keeps
// its frames (no long task, no frame over 50 ms while the progress toast updates) and its heap does not grow by the body.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { join } = require('node:path');
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const dl = () => vis('[data-output-download="response.body"]')[0];
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim());
`;
const step = stepOf(H);

const steps = [
  step(
    'a-50-mb-response',
    `await __t.newTab('HTTP request');
     const u = vis('main input[aria-label="Request URL"]')[0]; if (!u) return 'NO INPUT url';
     setVal(u, 'http://127.0.0.1:4010/large?mb=50'); await __t.sleep(300);
     vis('main button').find((b) => b.textContent.trim() === 'Send')?.click();
     const ok = await __t.waitFor(() => (dl() && !dl().disabled ? true : null), 60000); if (!ok) return 'NO RESPONSE';
     const truncated = vis('main *').some((e) => e.children.length === 0 && e.textContent.trim() === 'preview truncated');
     return 'response: ok | preview truncated: ' + truncated;`,
  ),
  step(
    'save-it-as-pretty-json',
    `const heap0 = performance.memory?.usedJSHeapSize ?? 0;
     const longTasks = []; const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(Math.round(e.duration)))); po.observe({ entryTypes: ['longtask'] });
     // what the slowest frames spent their time on (Long Animation Frames): script, style and layout, or waiting
     const loafs = []; const lo = new PerformanceObserver((l) => l.getEntries().forEach((e) => loafs.push(e)));
     try { lo.observe({ type: 'long-animation-frame', buffered: false }); } catch {}
     let last = performance.now(); let worst = 0; let worstAt = 0; let frames = 0; let running = true;
     const tick = (t) => { if (t - last > worst) ((worst = t - last), (worstAt = last - t0)); last = t; frames++; if (running) requestAnimationFrame(tick); };
     requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
     const before = toasts().filter((x) => / saved to /.test(x)).length;
     const t0 = performance.now();
     await __t.real.click(dl());
     const sawProgress = await __t.waitFor(() => (toasts().some((x) => /^Saving response body…/.test(x)) || !!document.querySelector('[data-output-cancel]') ? true : null), 20000);
     const done = await __t.waitFor(() => (toasts().filter((x) => / saved to /.test(x)).length > before ? true : null), 120000);
     const took = Math.round(performance.now() - t0);
     running = false; po.disconnect(); await __t.sleep(100); lo.disconnect();
     const heap = Math.round(((performance.memory?.usedJSHeapSize ?? 0) - heap0) / 1024 / 1024);
     const w = loafs.sort((a, b) => b.duration - a.duration)[0];
     const loaf = w ? 'worst ' + Math.round(w.duration) + ' ms (script ' + Math.round((w.scripts ?? []).reduce((n, s) => n + s.duration, 0)) + ', style+layout ' + Math.round(w.styleAndLayoutStart ? w.startTime + w.duration - w.styleAndLayoutStart : 0) + ', blocking ' + Math.round(w.blockingDuration ?? 0) + ', ' + ((w.scripts ?? []).map((s) => (s.invoker || s.sourceFunctionName || '?') + ' ' + Math.round(s.duration)).slice(0, 3).join('; ') || 'no script') + ') of ' + loafs.length : 'none';
     return 'saved: ' + !!done + ' | progress shown: ' + !!sawProgress + ' | worst frame ms: ' + Math.round(worst) + ' | long tasks: ' + (longTasks.filter((d) => d > 50).join(',') || 'none') + ' | heap growth mb: ' + heap + ' | frames: ' + frames + ' | took ms: ' + took + ' | worst frame at ms: ' + Math.round(worstAt) + ' | loaf: ' + loaf;`,
  ),
  [
    'the-file',
    `main:const fs = require('node:fs'); const p = process.env.E2E_STUB_SAVE; const st = fs.statSync(p); const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(64); fs.readSync(fd, b, 0, 64, 0); fs.closeSync(fd); const r = 'mb: ' + Math.round(st.size / 1024 / 1024) + ' | starts pretty: ' + b.toString().startsWith('{\\n  "items": [\\n    {'); fs.rmSync(p, { force: true }); return r;`,
    false,
  ],
];

const num = (s, key) => Number((new RegExp(key + ': (-?\\d+)').exec(s) || [])[1]);
module.exports = withExpect(
  steps,
  {
    'a-50-mb-response': /^response: ok \| preview truncated: true$/,
    'save-it-as-pretty-json': (r) =>
      /^saved: true \| progress shown: true/.test(r) && num(r, 'worst frame ms') < 50 && /long tasks: none/.test(r) && num(r, 'heap growth mb') < 10 ? undefined : 'slow, blocked or heavy: ' + r,
    'the-file': (r) => (num(r, 'mb') >= 55 && /starts pretty: true$/.test(r) ? undefined : 'wrong file: ' + r),
  },
  { env: (out) => ({ E2E_STUB_SAVE: join(out, 'big.json') }) },
);
