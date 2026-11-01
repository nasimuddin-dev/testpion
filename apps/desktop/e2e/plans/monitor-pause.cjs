// A monitor paused for a while: Pause ▸ For 1 hour asks why, then the monitor says "paused until <time> (deploy)", its row says
// paused, no run is due, and Resume brings the schedule back at once. The CLI's `monitor pause --for` and `monitor resume` use the
// same two calls (monitor.pause / monitor.resume).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'a-monitor-to-pause',
    `const cols = await window.aps.invoke('col.list');
     const col = cols[0]; if (!col) return 'NO COLLECTION';
     const saved = await window.aps.invoke('monitor.save', { monitor: { name: 'Pause me', collectionId: col.id, everyMinutes: 60, enabled: true } });
     window.__pauseMonitorId = saved.id;
     return 'saved: ' + saved.name;`,
  ),
  step(
    'pause-for-an-hour-asks-why-and-says-until-when',
    `await __t.view('Monitors'); await __t.sleep(900);
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside *, main *')].find((e) => e.children.length === 0 && e.offsetParent && e.textContent.trim() === 'Pause me'), 8000); if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(800);
     const btn = await __t.waitFor(() => [...document.querySelectorAll('[data-monitor-pause]')].find((b) => b.offsetParent), 5000); if (!btn) return 'NO PAUSE BUTTON';
     await __t.real.click(btn);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'For 1 hour'), 4000); if (!item) return 'NO MENU ITEM';
     const labels = [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).join(' | ');
     await __t.real.click(item);
     const box = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] input, [role=dialog] textarea')].find((x) => x.offsetParent), 5000); if (!box) return 'NO WHY BOX | menu: ' + labels;
     await __t.real.click(box); await __t.real.type('deploy'); await __t.sleep(200);
     const ok = [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Pause'); if (!ok) return 'NO PAUSE OK';
     await __t.real.click(ok);
     const sched = await __t.waitFor(() => { const s = document.querySelector('[data-monitor-schedule]'); return s && /paused until/.test(s.textContent) ? s : null; }, 8000); if (!sched) return 'NO PAUSED TEXT: ' + document.querySelector('[data-monitor-schedule]')?.textContent;
     const st = (await window.aps.invoke('monitor.list')).find((m) => m.id === window.__pauseMonitorId);
     const inAnHour = st.pausedUntil && Math.abs(Date.parse(st.pausedUntil) - Date.now() - 3600000) < 120000;
     return 'menu: ' + labels + ' | says: ' + sched.textContent.split('').map((ch) => (ch >= '0' && ch <= '9' ? '#' : ch)).join('').replace(/#+:##( [AP]M)?/, 'HH:MM') + ' | paused: ' + st.paused + ' | due: ' + st.due + ' | enabled: ' + st.enabled + ' | in an hour: ' + inAnHour + ' | resume shown: ' + !![...document.querySelectorAll('[data-monitor-resume]')].find((b) => b.offsetParent);`,
  ),
  step(
    'resume-brings-the-schedule-back',
    `const btn = await __t.waitFor(() => [...document.querySelectorAll('[data-monitor-resume]')].find((b) => b.offsetParent), 5000); if (!btn) return 'NO RESUME BUTTON';
     await __t.real.click(btn);
     const sched = await __t.waitFor(() => { const s = document.querySelector('[data-monitor-schedule]'); return s && s.textContent.trim() === 'hourly' ? s : null; }, 8000); if (!sched) return 'NOT RESUMED: ' + document.querySelector('[data-monitor-schedule]')?.textContent;
     const st = (await window.aps.invoke('monitor.list')).find((m) => m.id === window.__pauseMonitorId);
     await window.aps.invoke('monitor.delete', { id: window.__pauseMonitorId });
     return 'says: ' + sched.textContent.trim() + ' | paused: ' + st.paused + ' | pausedUntil: ' + st.pausedUntil + ' | pause button back: ' + !!document.querySelector('[data-monitor-pause]');`,
  ),
];

module.exports = withExpect(steps, {
  'a-monitor-to-pause': /^saved: Pause me$/,
  'pause-for-an-hour-asks-why-and-says-until-when': /^menu: Until I resume it \| For 1 hour \| For 4 hours \| Until tomorrow 09:00 \| says: paused until HH:MM \(deploy\) \| paused: true \| due: false \| enabled: true \| in an hour: true \| resume shown: true$/,
  'resume-brings-the-schedule-back': /^says: hourly \| paused: false \| pausedUntil: undefined \| pause button back: true$/,
});
