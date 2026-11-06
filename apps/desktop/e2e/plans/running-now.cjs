// What runs now: with a mock server started, the status bar's MCP segment says "1 more running"; a click lists it with
// Stop, and Stop ends it (the count goes back).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'a-mock-server-runs',
    `(async () => {
      const cols = await window.aps.invoke('col.list'); const col = cols.find((c) => !c.problem); if (!col) return 'NO COLLECTION';
      await window.aps.invoke('mock.start', { collectionId: col.id, port: 0 });
      window.__runningCol = col.name;
      const seg = document.querySelector('[data-running]'); if (!seg) return 'NO SEGMENT';
      seg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); seg.click();
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Mock server of /.test(m.textContent.trim())), 5000);
      const says = await __t.waitFor(() => (/1 more running/.test(seg.textContent) ? seg.textContent.trim() : null), 3000);
      if (!item) return 'NO MOCK IN THE LIST | segment: ' + seg.textContent.trim();
      const named = item.textContent.includes(window.__runningCol);
      item.click(); await __t.sleep(800);
      const after = (await window.aps.invoke('app.running')).filter((i) => i.kind === 'mock').length;
      return 'segment: ' + (says ? 'says 1 more running' : 'NO COUNT: ' + seg.textContent.trim()) + ' | listed by name: ' + named + ' | mocks after Stop: ' + after;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'a-mock-server-runs': /^segment: says 1 more running \| listed by name: true \| mocks after Stop: 0$/,
});
