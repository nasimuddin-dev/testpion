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
    'home-same-list': /^rows: [1-5] \| first is the file: true$/,
  },
  { prepare },
);
