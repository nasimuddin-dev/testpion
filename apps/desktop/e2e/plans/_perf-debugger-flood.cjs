// Not part of the suite (the _ prefix; it takes minutes): the Debugger under a flood of real traffic from another
// process — 20,000 requests at 50 at a time through the proxy, then 200 requests with 1 MB bodies — while the window
// is measured: frames during the flood, the session held at its cap of 5,000, the list and a sort afterwards, and the
// app's memory before and after. "main:" steps run outside the page.
const { withExpect } = require('../lib.cjs');
const { join } = require('node:path');

const FLOOD = join(__dirname, '..', 'flood.mjs');
const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const ms = (t0) => Math.round(performance.now() - t0);
`;
const step = (name, body, shot) => [name, `(async () => { ${H} ${body} })()`, shot];
/** Starts the flood outside the app and returns at once; the result lands in <home>/flood-<tag>.json. */
const startFlood = (tag, count, concurrency, bodyBytes = 0) =>
  `main: const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs');
   const out = path.join(home, 'flood-${tag}.json'); try { fs.unlinkSync(out); } catch {}
   const st = JSON.parse(fs.readFileSync(path.join(home, 'flood-port.txt'), 'utf8'));
   const child = spawn(process.execPath, [${JSON.stringify(FLOOD)}, String(st.port), '${count}', '${concurrency}', out, '${bodyBytes}'], { stdio: 'ignore', windowsHide: true, detached: true });
   child.unref();
   return 'flood started: ${count} requests, ${concurrency} at a time' + (${bodyBytes} ? ', ${bodyBytes} B bodies' : '');`;
const waitFlood = (tag) =>
  `main: const path = require('path'); const fs = require('fs'); const out = path.join(home, 'flood-${tag}.json');
   const t0 = Date.now();
   while (!fs.existsSync(out)) { if (Date.now() - t0 > 170000) return 'flood did not finish in time'; await new Promise((r) => setTimeout(r, 500)); }
   const r = JSON.parse(fs.readFileSync(out, 'utf8'));
   const mem = process.memoryUsage();
   return 'sent: ' + r.sent + ' | ok: ' + r.ok + ' | failed: ' + r.failed + ' | seconds: ' + r.seconds + ' | rps: ' + r.rps + ' | main rss MB: ' + Math.round(mem.rss / 1048576) + ' | heap MB: ' + Math.round(mem.heapUsed / 1048576);`;

const steps = [
  step(
    'start-capturing',
    `await __t.view('Debugger'); await __t.sleep(500);
     if (!(await window.aps.invoke('debug.status')).running) { vis('main button').find((b) => b.textContent.trim() === 'Start capturing')?.click(); }
     const st = await __t.waitFor(async () => { const s = await window.aps.invoke('debug.status'); return s.running ? s : null; }, 10000);
     await window.aps.invoke('debug.clear');
     return 'port ' + st.port;`,
    false,
  ),
  [
    'remember-port',
    `main: const path = require('path'); const fs = require('fs'); fs.writeFileSync(path.join(home, 'flood-port.txt'), JSON.stringify({ port: 8899 })); const m = process.memoryUsage(); return 'main rss MB before: ' + Math.round(m.rss / 1048576) + ' | heap MB: ' + Math.round(m.heapUsed / 1048576);`,
    false,
  ],
  ['flood-20k', startFlood('a', 20000, 50), false],
  // the window during the flood: frames and the list call, sampled for ten seconds
  step(
    'window-during-the-flood',
    `const frames = []; const lists = [];
     const t0 = performance.now();
     while (performance.now() - t0 < 10000) {
       const f = performance.now(); await ${painted}(); frames.push(ms(f));
       const l = performance.now(); await window.aps.invoke('debug.exchanges', { limit: 50 }); lists.push(ms(l));
       await __t.sleep(200);
     }
     const max = (a) => Math.max(...a); const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
     const st = await window.aps.invoke('debug.status');
     return 'frames: avg ' + avg(frames) + ' max ' + max(frames) + ' ms | list calls: avg ' + avg(lists) + ' max ' + max(lists) + ' ms | captured so far: ' + st.exchanges + ' | rows painted: ' + rows().length;`,
  ),
  ['flood-20k-result', waitFlood('a'), false],
  step(
    'after-the-flood',
    `await __t.sleep(1500);
     const st = await window.aps.invoke('debug.status');
     const t1 = performance.now(); const list = await window.aps.invoke('debug.exchanges', {}); const listMs = ms(t1);
     const kb = Math.round(JSON.stringify(list).length / 1024);
     const head = vis('main [data-debugger-grid] [role=columnheader]').find((h) => h.textContent.trim().startsWith('Duration'));
     const t2 = performance.now(); head?.click(); await ${painted}(); const sortMs = ms(t2);
     const stats = await window.aps.invoke('debug.stats').catch(() => null);
     return 'session holds: ' + st.exchanges + ' | list ms: ' + listMs + ' | list kb: ' + kb + ' | sort ms: ' + sortMs + ' | rows painted: ' + rows().length + (stats ? ' | stats total: ' + (stats.total ?? stats.requests ?? '?') : '');`,
  ),
  ['flood-1mb-bodies', startFlood('b', 200, 10, 1048576), false],
  ['flood-1mb-result', waitFlood('b'), false],
  step(
    'bodies-are-capped',
    `await __t.sleep(1000);
     const list = await window.aps.invoke('debug.exchanges', { limit: 5 });
     const items = Array.isArray(list) ? list : list.items;
     const e = items.find((x) => x.method === 'POST') ?? items[0];
     const full = e ? await window.aps.invoke('debug.exchange', { id: e.id }) : null;
     const sent = full?.requestBodyBytes ?? full?.request?.bodyBytes;
     const kept = full?.requestBody?.length ?? full?.request?.body?.length;
     return 'request body bytes: ' + sent + ' | kept in the session: ' + kept + ' | truncated: ' + !!(full?.requestBodyTruncated || full?.request?.truncated || (kept !== undefined && sent !== undefined && kept < sent));`,
  ),
  // far past the budget: 2,000 bodies of 1 MB (1 GB sent, 512 KB kept each without a budget) — the session's bodies stay under 200 MB
  ['flood-2000-x-1mb', startFlood('c', 2000, 20, 1048576), false],
  ['flood-2000-x-1mb-result', waitFlood('c'), false],
  step(
    'memory-is-bounded',
    `await __t.sleep(1500);
     const st = await window.aps.invoke('debug.status');
     const list = await window.aps.invoke('debug.exchanges', {});
     const items = Array.isArray(list) ? list : list.items;
     // the oldest exchange with a body in this session has lost it; the newest keeps it
     const oldest = items[0]; const newest = items[items.length - 1];
     const a = await window.aps.invoke('debug.exchange', { id: oldest.id });
     const b = await window.aps.invoke('debug.exchange', { id: newest.id });
     const main = await window.aps.invoke('app.memory').catch(() => null);
     return 'session holds: ' + st.exchanges + ' | oldest kept body: ' + (a.requestBody?.length ?? 0) + ' dropped: ' + !!a.bodiesDropped + ' | newest kept body: ' + (b.requestBody?.length ?? 0) + (main ? ' | main heap MB: ' + Math.round(main.heapUsed / 1048576) : '');`,
  ),
  ['memory-after-the-big-bodies', `main: const v8 = require('v8'); v8.setFlagsFromString('--expose_gc'); const gc = require('vm').runInNewContext('gc'); gc(); gc(); const m = process.memoryUsage(); return 'main rss MB: ' + Math.round(m.rss / 1048576) + ' | heap MB: ' + Math.round(m.heapUsed / 1048576);`, false],
  ['stop', `(async () => { [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Stop')?.click(); await __t.sleep(800); const m = await window.aps.invoke('debug.status'); return 'stopped: ' + !m.running; })()`, false],
  ['memory-after', `main: const v8 = require('v8'); v8.setFlagsFromString('--expose_gc'); const gc = require('vm').runInNewContext('gc'); gc(); gc(); const m = process.memoryUsage(); return 'main rss MB after: ' + Math.round(m.rss / 1048576) + ' | heap MB: ' + Math.round(m.heapUsed / 1048576);`, false],
];

module.exports = withExpect(steps, {
  'flood-20k-result': /ok: 20000 \| failed: 0/,
  'after-the-flood': /^session holds: 5000 \|/,
  'flood-1mb-result': /ok: 200 \| failed: 0/,
  'flood-2000-x-1mb-result': /ok: 2000 \| failed: 0/,
  'memory-is-bounded': /oldest kept body: 0 dropped: true \| newest kept body: 524288/,
  'memory-after-the-big-bodies': (r) => (Number(/heap MB: (\d+)/.exec(r)?.[1]) < 450 ? undefined : 'the session grew past its budget: ' + r),
  stop: /^stopped: true$/,
});
