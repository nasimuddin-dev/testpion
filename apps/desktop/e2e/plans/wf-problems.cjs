// WF-03 Problems: the status bar counts the workspace's problems and toggles the Problems tab (grouped, failures and
// errors marked); F8 opens the next one; Home's "Needs attention" is the same list.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

/** An environment file that is not JSON: a problem of the workspace's files. */
function prepare(ws) {
  writeFileSync(join(ws, 'environments', 'e2e-broken.json'), '{ "id": "e2e-broken", "name": ');
}

const steps = [
  step(
    'status-badge',
    `const b = await __t.waitFor(() => document.querySelector('footer [data-status="problems"]'), 5000); if (!b) return 'NO BADGE';
     await __t.waitFor(() => Number(b.textContent.trim()) > 0, 5000);
     b.click();
     const panel = await __t.waitFor(() => document.querySelector('[data-bottom-panel="problems"]'), 3000); if (!panel) return 'NO PANEL';
     await __t.waitFor(() => panel.querySelector('[data-problem]'), 4000);
     const heads = [...panel.querySelectorAll('[role=list] > div:not([role])')].map((x) => x.textContent.trim());
     const first = panel.querySelector('[data-problem]')?.textContent.trim();
     return 'count > 0: ' + (Number(b.textContent.trim()) > 0) + ' | groups: ' + heads.join(',') + ' | first: ' + short(first, 80);`,
  ),
  step(
    'f8-opens-it',
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', bubbles: true }));
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'environments', 5000);
     return 'view: ' + localStorage.getItem('aps.view');`,
  ),
  // a problem set aside: it leaves the list and the count, the panel says how many are snoozed, Show lists it greyed, Bring it back returns it
  step(
    'snooze-and-bring-back',
    `const b = document.querySelector('footer [data-status="problems"]'); if (!b) return 'NO BADGE';
     let panel = document.querySelector('[data-bottom-panel="problems"]'); if (!panel) { b.click(); panel = await __t.waitFor(() => document.querySelector('[data-bottom-panel="problems"]'), 3000); }
     const before = Number(b.textContent.trim());
     const row = await __t.waitFor(() => panel.querySelector('[data-problem]'), 4000); if (!row) return 'NO ROW';
     const text = row.querySelector('button')?.getAttribute('title');
     row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Snooze for 1 hour'), 3000); if (!item) return 'NO SNOOZE ITEM: ' + [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).join(',');
     item.click();
     await __t.waitFor(() => Number(b.textContent.trim()) === before - 1, 6000);
     const gone = ![...panel.querySelectorAll('[data-problem]')].some((r) => r.querySelector('button')?.getAttribute('title') === text);
     const note = await __t.waitFor(() => panel.querySelector('[data-problems-snoozed]'), 4000); if (!note) return 'NO SNOOZED NOTE';
     const noteText = note.textContent.trim();
     await __t.real.click(note);
     const grey = await __t.waitFor(() => panel.querySelector('[data-problem][data-snoozed="until"]'), 4000); if (!grey) return 'NO GREY ROW';
     grey.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
     const back = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Bring it back'), 3000); if (!back) return 'NO BRING BACK';
     back.click();
     const restored = await __t.waitFor(() => (Number(b.textContent.trim()) === before ? true : null), 6000);
     if (!restored) { const sn = await window.aps.invoke('attention.snoozed'); const st = await window.aps.invoke('stats.attention'); return 'NOT RESTORED | snoozed: ' + sn.length + ' ' + JSON.stringify(sn.map((x) => x.key)) + ' | shown: ' + st.length + ' | badge: ' + b.textContent.trim() + ' | view: ' + localStorage.getItem('aps.view'); }
     return 'count down by one: true | row gone: ' + gone + ' | note: ' + noteText + ' | greyed when shown: true | back: ' + (Number(b.textContent.trim()) === before) + ' | note gone: ' + !panel.querySelector('[data-problems-snoozed]');`,
  ),
  step(
    'home-same-list',
    `await __t.view('Home'); await __t.sleep(800);
     const card = document.querySelector('section[aria-label="Needs attention"]'); if (!card) return 'NO CARD';
     return 'rows: ' + card.querySelectorAll('[data-problem]').length + ' | first is the file: ' + /can't be read/.test(card.querySelector('[data-problem]')?.textContent ?? '');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'status-badge': /^count > 0: true \| groups: Workspace files.* \| first: Environment .*can't be read/,
    'f8-opens-it': /^view: environments$/,
    'snooze-and-bring-back': /^count down by one: true \| row gone: true \| note: 1 snoozed problem · Show \| greyed when shown: true \| back: true \| note gone: true$/,
    'home-same-list': /^rows: [1-5] \| first is the file: true$/,
  },
  { prepare },
);
