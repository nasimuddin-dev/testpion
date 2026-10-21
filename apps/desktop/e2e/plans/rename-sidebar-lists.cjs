// Rename in place in the sidebar lists (Monitors, AI Lab prompts and their folders); Enter opens a row.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.offsetParent);
  const row = (txt) => visible('[data-tree-row]').find((b) => b.textContent.trim().includes(txt));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const input = () => (document.activeElement?.tagName === 'INPUT' && document.activeElement.getAttribute('aria-label')?.toLowerCase().includes('name') ? document.activeElement : null);
  const names = (re) => visible('[data-tree-row]').filter((b) => re.test(b.textContent)).map((b) => b.textContent.trim().slice(0, 40)).join(' / ');
  const f2 = async (txt) => { const r = row(txt); if (!r) return null; r.focus(); key(r, 'F2'); await __t.sleep(400); return input(); };
  const type = async (i, v, k = 'Enter') => { setVal(i, v); key(i, k); await __t.sleep(900); };
`;
const step = stepOf(H);
const steps = [
  step('monitors', `await __t.view('Monitors'); await __t.sleep(800); return names(/./);`),
  step('monitor-f2', `const i = await f2('Public APIs health'); if (!i) return 'NO INPUT'; await type(i, 'API health X'); return names(/health/) + ' | focus on: ' + (document.activeElement?.getAttribute('data-row-name') ?? '');`),
  step('monitor-esc-blank', `let i = await f2('API health X'); setVal(i, 'NOPE'); key(i, 'Escape'); await __t.sleep(500); i = await f2('API health X'); setVal(i, ''); key(i, 'Enter'); await __t.sleep(300); const alert = document.querySelector('[role=alert]')?.textContent; key(input(), 'Escape'); await __t.sleep(400); return names(/health|NOPE/) + ' | blank: ' + alert;`),
  step('monitor-menu-back', `const r = row('API health X'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); await __t.sleep(600); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Rename')?.click(); await __t.sleep(700); const i = input(); if (!i) return 'NO INPUT'; await type(i, 'Public APIs health'); return names(/health/);`),
  step('monitor-enter-opens', `const r = row('Public APIs health'); r.focus(); key(r, 'Enter'); await __t.sleep(1000); return 'tab: ' + visible('main [role=tab][aria-selected="true"]').map((t) => t.textContent.trim()).join('') + ' | heading: ' + (visible('main h2')[0]?.textContent ?? '');`),
  step('ailab-prompt-f2', `await __t.view('AI Lab'); await __t.sleep(800); const i = await f2('Summarise a text'); if (!i) return 'NO INPUT: ' + names(/./); await type(i, 'Summarise X'); const back = await f2('Summarise X'); await type(back, 'Summarise a text'); return names(/Summarise/);`),
  step('ailab-folder-f2', `const i = await f2('Offline demo model'); if (!i) return 'NO INPUT'; await type(i, 'Demo model'); const n1 = names(/Demo model|Offline demo/); const j = await f2('Demo model'); await type(j, 'Offline demo model'); return n1 + ' -> ' + names(/Demo model|Offline demo/) + ' | prompts still: ' + names(/Classify intent|Summarise a text/);`),
  step('click-selects', `const r = row('Classify intent'); r.click(); await __t.sleep(800); return 'selected: ' + (visible('[data-node-id].bg-accent-soft')[0]?.textContent.trim().slice(0, 30) ?? 'none');`),
];

module.exports = withExpect(steps, {
  'monitor-f2': /API health X.*focus on: API health X/,
  'monitor-esc-blank': /blank: A name is required/,
  'monitor-menu-back': /^Public APIs health/,
  'monitor-enter-opens': /heading: Public APIs health/,
  'ailab-prompt-f2': /^Summarise a text/,
  'ailab-folder-f2': /Demo model3 -> Offline demo model3/,
  'click-selects': /selected: Classify intent/,
});
