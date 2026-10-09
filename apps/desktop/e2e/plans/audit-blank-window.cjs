// An environment whose "name" is not a string (as a hand edit or a bad git merge leaves it) must not blank the window
// (robustness audit 2026-10-09): names from user files are shown as text, the top bar, status bar, sidebar and every
// dialog host have an error boundary of their own, and the whole app has one more (Reload, Report a problem).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

function prepare(ws) {
  writeFileSync(join(ws, 'environments', 'weird.json'), JSON.stringify({ id: 'weird', name: { en: 'Weird' }, variables: [] }));
}

const alive = `((document.querySelector('header')?.innerText.length ?? 0) > 0 ? 'ALIVE' : 'BLANK')`;
const picker = `document.querySelector('header button[aria-label="Environment"]')`;

const steps = [
  ['start', `(async () => { await __t.sleep(1500); return ${alive}; })()`],
  [
    'open-environment-menu',
    `(async () => {
      const b = ${picker}; if (!b) return 'NO PICKER | ' + ${alive};
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click();
      await __t.sleep(1200);
      const r = ${alive} + ' | items: ' + document.querySelectorAll('[role=menuitem]').length;
      await __t.esc();
      return r;
    })()`,
  ],
  ['environments-view', `(async () => { await __t.view('Environments'); await __t.sleep(1200); return ${alive} + ' | ' + ((document.querySelector('main')?.innerText ?? '').match(/This view ran into a problem/) ? 'boundary' : 'ok'); })()`],
];

module.exports = withExpect(
  steps,
  {
    start: /ALIVE/,
    // the menu lists it (its name as text) with "No environment" and "Manage environments…"
    'open-environment-menu': /ALIVE \| items: [3-9]/,
    'environments-view': /ALIVE \| ok/,
  },
  { prepare },
);
