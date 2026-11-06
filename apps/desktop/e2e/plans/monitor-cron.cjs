// A monitor at set times: a cron schedule ("0 9 * * 1-5") shows in words on its page ("at 09:00 on weekdays"), and the
// editor's "at set times (cron)" field says the schedule and its next runs as it is typed, or what is wrong with it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const setVal = `const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };`;

const steps = [
  step(
    'a-monitor-at-set-times',
    `const cols = await window.aps.invoke('col.list');
     const col = cols[0]; if (!col) return 'NO COLLECTION';
     const saved = await window.aps.invoke('monitor.save', { monitor: { name: 'Weekday mornings', collectionId: col.id, everyMinutes: 60, cron: '0 9 * * 1-5', enabled: true } });
     window.__cronMonitorId = saved.id;
     await __t.view('Monitors'); await __t.sleep(900);
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside *, main *')].find((e) => e.children.length === 0 && e.offsetParent && e.textContent.trim() === 'Weekday mornings'), 8000); if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(800);
     const sched = await __t.waitFor(() => document.querySelector('[data-monitor-schedule]'), 5000);
     return 'list says: ' + saved.schedule + ' | page says: ' + (sched?.textContent.trim() ?? 'NOTHING');`,
  ),
  step(
    'the-editor-reads-the-schedule-as-it-is-typed',
    `${setVal}
     const edit = [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Edit'); if (!edit) return 'NO EDIT';
     await __t.real.click(edit);
     const input = await __t.waitFor(() => document.querySelector('[data-monitor-cron]'), 5000); if (!input) return 'NO CRON FIELD';
     const preview = () => document.querySelector('[data-monitor-cron-preview]')?.textContent.trim() ?? 'NO PREVIEW';
     const first = preview();
     setVal(input, '0 25 * * *'); await __t.sleep(300);
     const wrong = preview();
     setVal(input, '*/30 * * * *'); await __t.sleep(300);
     const half = preview();
     await __t.esc(); await __t.sleep(300);
     await window.aps.invoke('monitor.delete', { id: window.__cronMonitorId });
     return 'value: ' + input.value + ' | first: ' + first.replace(/next: .*/, 'next: …') + ' | wrong: ' + wrong + ' | half: ' + half.replace(/next: .*/, 'next: …');`,
  ),
];

module.exports = withExpect(steps, {
  'a-monitor-at-set-times': /^list says: at 09:00 on weekdays \| page says: at 09:00 on weekdays$/,
  'the-editor-reads-the-schedule-as-it-is-typed': /^value: \*\/30 \* \* \* \* \| first: Runs at 09:00 on weekdays · next: … \| wrong: "25" is out of range for the hour \(0–23\) \| half: Runs every 30 minutes · next: …$/,
});
