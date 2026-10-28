// The HTTP Debugger's row menu fits the window (the shared menu is never taller than the room it has and scrolls), the
// rarely used rule actions sit under "Change this traffic", and the strip under the filters has the quick controls:
// Hide tunnels, Save session, Clear.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepWith } = require('../lib.cjs');
const step = stepWith({ extra: '' });

const steps = [
  step(
    'quick-controls',
    `await __t.view('Debugger');
     const start = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Start capturing'); if (!start) return 'NO START';
     await __t.real.click(start);
     await __t.waitFor(() => window.aps.invoke('debug.status').then((s) => s.running), 6000);
     await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health' });
     const row = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/health')), 6000); if (!row) return 'NO ROW';
     const btn = (t) => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === t);
     const hide = [...document.querySelectorAll('main label')].find((l) => l.textContent.trim() === 'Hide tunnels');
     return 'hide tunnels: ' + !!hide?.querySelector('input[type=checkbox]') + ' | save session: ' + !!btn('Save session') + ' | clear: ' + !!btn('Clear');`,
  ),
  step(
    'row-menu-fits',
    `const row = [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/health'));
     row.scrollIntoView({ block: 'center' }); await __t.sleep(200); await __t.real.rightClick(row);
     const menu = await __t.waitFor(() => document.querySelector('[role=menu]'), 3000); if (!menu) return 'NO MENU';
     await __t.sleep(300);
     const r = menu.getBoundingClientRect();
     const items = [...document.querySelectorAll('[role=menuitem]')].filter((m) => m.offsetParent).map((m) => m.textContent.trim());
     const cs = getComputedStyle(menu);
     return 'inside the window: ' + (r.top >= 0 && r.bottom <= innerHeight) + ' | scrolls: ' + (cs.overflowY === 'auto') + ' | change traffic: ' + items.some((t) => t === 'Change this traffic') + ' | flat rule items: ' + items.some((t) => /^(Modify headers|Redirect connections|Auto-reply)/.test(t));`,
  ),
  step(
    'change-traffic-submenu',
    `const sub = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Change this traffic'); if (!sub) return 'NO ITEM';
     await __t.real.click(sub); await __t.sleep(400);
     const names = [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim());
     const out = 'sub has: ' + ['Auto-reply', 'Modify headers…', 'Redirect connections…'].map((n) => names.includes(n)).join(',');
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(200);
     return out;`,
  ),
];

module.exports = withExpect(steps, {
  'quick-controls': /^hide tunnels: true \| save session: true \| clear: true$/,
  'row-menu-fits': /^inside the window: true \| scrolls: true \| change traffic: true \| flat rule items: false$/,
  'change-traffic-submenu': /^sub has: true,true,true$/,
});
