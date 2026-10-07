// Not part of the suite (the _ prefix; it takes minutes): the Debugger under a flood of real traffic from another
// process — 20,000 requests at 50 at a time through the proxy, then bodies of 1 MB — while the window is measured:
// frames during the flood, the session held at its cap of 5,000, the list and a sort afterwards, and the memory the
// session keeps within its budget. "main:" steps run outside the page.
const { withExpect, step, EXCHANGES, waitRunning, mainMemory } = require('../lib.cjs');
const { join } = require('node:path');

const PORT = 8899;
const FLOOD = join(__dirname, '..', 'flood.mjs');
/** Starts the flood outside the app and returns at once; the result lands in <home>/flood-<tag>.json. */
const startFlood = (tag, count, concurrency, bodyBytes = 0) =>
  `main: const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs');
   const out = path.join(home, 'flood-${tag}.json'); try { fs.unlinkSync(out); } catch {}
   const child = spawn(process.execPath, [${JSON.stringify(FLOOD)}, '${PORT}', '${count}', '${concurrency}', out, '${bodyBytes}'], { stdio: 'ignore', windowsHide: true, detached: true });
   child.unref();
   return 'flood started: ${count} requests, ${concurrency} at a time' + (${bodyBytes} ? ', ${bodyBytes} B bodies' : '');`;
/** Waits for the flood's result file and reports it. */
const waitFlood = (tag) =>
  `main: const path = require('path'); const fs = require('fs'); const out = path.join(home, 'flood-${tag}.json');
   const t0 = Date.now();
   while (!fs.existsSync(out)) { if (Date.now() - t0 > 170000) return 'flood did not finish in time'; await new Promise((r) => setTimeout(r, 500)); }
   const r = JSON.parse(fs.readFileSync(out, 'utf8'));
   return 'sent: ' + r.sent + ' | ok: ' + r.ok + ' | failed: ' + r.failed + ' | seconds: ' + r.seconds + ' | rps: ' + r.rps;`;

const steps = [
  step(
    'start-capturing',
    `await __t.view('Debugger'); await __t.sleep(500);
     if (!(await window.aps.invoke('debug.status')).running) button('Start capturing')?.click();
     const st = ${waitRunning(true)};
     await window.aps.invoke('debug.clear');
     return 'port ' + st.port;`,
    false,
  ),
  ['memory-before', mainMemory('before'), false],
  ['flood-20k', startFlood('a', 20000, 50), false],
  // the window during the flood: frames and the list call, sampled for ten seconds
  step(
    'window-during-the-flood',
    `const frames = []; const lists = [];
     const t0 = performance.now();
     while (performance.now() - t0 < 10000) {
       const f = performance.now(); await painted(); frames.push(ms(f));
       const l = performance.now(); await window.aps.invoke('debug.exchanges', { limit: 50 }); lists.push(ms(l));
       await __t.sleep(200);
     }
     const max = (a) => Math.max(...a); const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
     const st = await window.aps.invoke('debug.status');
     return 'frames: avg ' + avg(frames) + ' max ' + max(frames) + ' ms | list calls: avg ' + avg(lists) + ' max ' + max(lists) + ' ms | captured so far: ' + st.exchanges + ' | rows painted: ' + vis('main [data-debugger-grid] [role=row][data-exchange]').length;`,
  ),
  ['flood-20k-result', waitFlood('a'), false],
  step(
    'after-the-flood',
    `await __t.sleep(1500);
     const st = await window.aps.invoke('debug.status');
     const t1 = performance.now(); const list = await window.aps.invoke('debug.exchanges', {}); const listMs = ms(t1);
     const head = vis('main [data-debugger-grid] [role=columnheader]').find((h) => h.textContent.trim().startsWith('Duration'));
     const t2 = performance.now(); head?.click(); await painted(); const sortMs = ms(t2);
     return 'session holds: ' + st.exchanges + ' | list ms: ' + listMs + ' | list kb: ' + Math.round(JSON.stringify(list).length / 1024) + ' | sort ms: ' + sortMs;`,
  ),
  ['flood-1mb-bodies', startFlood('b', 200, 10, 1048576), false],
  ['flood-1mb-result', waitFlood('b'), false],
  step(
    'bodies-are-capped',
    `await __t.sleep(1000);
     const e = (${EXCHANGES}).findLast((x) => x.method === 'POST');
     const full = e ? await window.aps.invoke('debug.exchange', { id: e.id }) : null;
     return 'request body bytes: ' + full?.requestBodyBytes + ' | kept in the session: ' + full?.requestBody?.length + ' | truncated: ' + !!full?.requestBodyTruncated;`,
  ),
  // far past the budget: 2,000 bodies of 1 MB (1 GB sent, 512 KB kept each without a budget) — the session's bodies stay under 200 MB
  ['flood-2000-x-1mb', startFlood('c', 2000, 20, 1048576), false],
  ['flood-2000-x-1mb-result', waitFlood('c'), false],
  step(
    'memory-is-bounded',
    `await __t.sleep(1500);
     const all = ${EXCHANGES};
     const a = await window.aps.invoke('debug.exchange', { id: all[0].id });
     const b = await window.aps.invoke('debug.exchange', { id: all[all.length - 1].id });
     return 'session holds: ' + all.length + ' | oldest kept body: ' + (a.requestBody?.length ?? 0) + ' dropped: ' + !!a.bodiesDropped + ' | newest kept body: ' + (b.requestBody?.length ?? 0);`,
  ),
  ['memory-after-the-big-bodies', mainMemory('after the big bodies', true), false],
  step('stop', `button('Stop')?.click(); ${waitRunning(false)}; return 'stopped';`, false),
  ['memory-after', mainMemory('after stop', true), false],
];

module.exports = withExpect(steps, {
  'flood-20k-result': /ok: 20000 \| failed: 0/,
  'after-the-flood': /^session holds: 5[01]\d\d \|/,
  'flood-1mb-result': /ok: 200 \| failed: 0/,
  'bodies-are-capped': /^request body bytes: 1048576 \| kept in the session: 524288 \| truncated: true$/,
  'flood-2000-x-1mb-result': /ok: 2000 \| failed: 0/,
  'memory-is-bounded': /oldest kept body: 0 dropped: true \| newest kept body: 524288/,
  'memory-after-the-big-bodies': (r) => (Number(/heap MB (\d+)/.exec(r)?.[1]) < 450 ? undefined : 'the session grew past its budget: ' + r),
  stop: /^stopped$/,
});
