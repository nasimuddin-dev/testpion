// First launch: a new window starts in the Examples workspace. Home there shows Get started in the examples' own words, the
// walk-throughs and a way to My Workspace; the tour is offered once; a new request tab has the cursor in its URL field.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) { const v = fn(); if (v) return v; } };
  const card = () => document.querySelector('section[aria-label="Get started"]');
`;

const steps = [
  [
    'start-in-the-examples',
    // the e2e window keeps the tour shut unless a plan opens it (aps.capture.tour); a window that never saw the tour is the first launch
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
     await w.webContents.executeJavaScript("localStorage.setItem('aps.capture.tour', '1'); localStorage.setItem('aps.view', 'home'); Object.keys(localStorage).filter((k) => k.includes('tour.firstLoop')).forEach((k) => localStorage.removeItem(k));");
     w.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)); await w.webContents.executeJavaScript(require('node:fs').readFileSync(require.resolve('./helpers.js'), 'utf8')); await w.webContents.executeJavaScript(require('./real-input.cjs').PAGE); return 'reloaded';`,
    false,
  ],
  step(
    'home-offers-the-first-steps',
    `${H}
     const c = await until(card, 15000); if (!c) return 'NO CARD';
     const steps = [...c.querySelectorAll('[data-get-started] li')].map((li) => li.querySelector('.font-medium').textContent.replace(/^\\d+\\.\\s*/, '').trim());
     const walk = !!document.querySelector('[data-walkthroughs]');
     const own = !!document.querySelector('[data-open-own-workspace]');
     const tour = !!(await until(() => document.querySelector('[role=dialog][data-coachmark]'), 8000));
     return 'steps: ' + steps.slice(0, 4).join(' / ') + ' | walk-throughs: ' + walk + ' | my workspace: ' + own + ' | tour: ' + tour;`,
  ),
  step(
    'skipping-the-tour-keeps-the-card',
    `${H}
     document.querySelector('[role=dialog][data-coachmark] button')?.focus();
     await __t.real.key('Escape'); await __t.sleep(500);
     return 'tour: ' + !!document.querySelector('[role=dialog][data-coachmark]') + ' | card: ' + !!card() + ' | walk-throughs: ' + !!document.querySelector('[data-walkthroughs]');`,
  ),
  step(
    'a-new-request-tab-has-the-cursor-in-the-url',
    `${H}
     const b = [...document.querySelectorAll('button')].find((x) => /New HTTP request/.test(x.textContent) && x.offsetParent); if (!b) return 'NO BUTTON';
     b.click();
     const ok = await until(() => document.activeElement?.getAttribute('aria-label') === 'Request URL', 5000);
     return 'focus in the URL field: ' + !!ok;`,
  ),
];

module.exports = withExpect(steps, {
  'home-offers-the-first-steps': /^steps: Send one of these \/ Save a copy of your own \/ Save it as a test \/ Run the offline suite \| walk-throughs: true \| my workspace: true \| tour: true$/,
  'skipping-the-tour-keeps-the-card': /^tour: false \| card: true \| walk-throughs: true$/,
  'a-new-request-tab-has-the-cursor-in-the-url': /^focus in the URL field: true$/,
});
