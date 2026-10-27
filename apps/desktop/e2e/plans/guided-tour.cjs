// The guided tour of the first loop (Home ▸ Get started): in a new workspace it opens by itself on Home with an opening
// card; real keys and clicks walk it (→ to the Send button in a request tab, Next to Save …), Esc skips it, it does not
// open again after a reload (the e2e helpers are put back into the reloaded page), and Take the tour starts it again at the first step not done.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) { const v = fn(); if (v) return v; } };
  const card = () => document.querySelector('[role=dialog][data-coachmark]');
  const at = () => card() ? card().getAttribute('data-coachmark') + ':' + card().querySelector('#coachmark-title').textContent.trim() : 'none';
  const ring = () => !!document.querySelector('[data-coachmark-ring]');
  const cbtn = (label) => [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === label);
`;

const fresh = [
  'fresh-workspace',
  `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
   await w.webContents.executeJavaScript("localStorage.setItem('aps.capture.tour', '1'); window.aps.invoke('ws.create', { name: 'E2E tour' })");
   w.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)); await w.webContents.executeJavaScript(require('node:fs').readFileSync(require.resolve('./helpers.js'), 'utf8')); await w.webContents.executeJavaScript(require('./real-input.cjs').PAGE); return 'reloaded';`,
  false,
];

const steps = [
  fresh,
  step(
    'opens-by-itself-on-home',
    `${H}
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, altKey: true, bubbles: true }));
     const c = await until(card, 15000); if (!c) return 'NO TOUR';
     return at() + ' | focus in the card: ' + c.contains(document.activeElement) + ' | ring: ' + ring();`,
  ),
  step(
    'arrow-right-goes-to-send',
    `${H}
     await __t.real.key('ArrowRight'); await __t.sleep(300);
     const ok = await until(() => card()?.getAttribute('data-coachmark') === '1' && ring(), 6000);
     const send = document.querySelector('[data-tour="send"]');
     const r = document.querySelector('[data-coachmark-ring]')?.getBoundingClientRect(); const s = send?.getBoundingClientRect();
     const around = !!(r && s && r.left <= s.left && r.right >= s.right && r.top <= s.top && r.bottom >= s.bottom);
     return at() + ' | on the Send button: ' + around + ' | ok: ' + !!ok;`,
  ),
  step(
    'next-and-back-with-real-clicks',
    `${H}
     await __t.real.click(cbtn('Next')); await until(() => card()?.getAttribute('data-coachmark') === '2' && ring(), 4000); await __t.sleep(400); // placed at its control
     const second = at();
     await __t.real.click(cbtn('Back')); await until(() => card()?.getAttribute('data-coachmark') === '1', 4000);
     return second + ' → ' + at();`,
  ),
  step(
    'escape-skips',
    `${H}
     card()?.querySelector('button')?.focus();
     await __t.real.key('Escape'); await __t.sleep(400);
     return 'open: ' + !!card();`,
  ),
  [
    'reload',
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)); await w.webContents.executeJavaScript(require('node:fs').readFileSync(require.resolve('./helpers.js'), 'utf8')); await w.webContents.executeJavaScript(require('./real-input.cjs').PAGE); return 'reloaded';`,
    false,
  ],
  step(
    'never-opens-twice',
    `${H}
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, altKey: true, bubbles: true }));
     const gs = await until(() => document.querySelector('section[aria-label="Get started"]'), 10000); if (!gs) return 'NO GET STARTED';
     await __t.sleep(1500);
     return 'tour: ' + !!card();`,
  ),
  step(
    'take-the-tour-again',
    `${H}
     const b = document.querySelector('[data-take-tour]'); if (!b) return 'NO BUTTON';
     await __t.real.click(b);
     await until(() => card() && ring(), 6000);
     const first = at();
     await __t.real.click(cbtn('Skip tour')); await __t.sleep(300);
     return first + ' | closed: ' + !card();`,
  ),
];

module.exports = withExpect(steps, {
  'opens-by-itself-on-home': /^0:A quick tour \| focus in the card: true \| ring: true$/,
  'arrow-right-goes-to-send': /^1:Send a request \| on the Send button: true \| ok: true$/,
  'next-and-back-with-real-clicks': /^2:Save it in a collection → 1:Send a request$/,
  'escape-skips': /^open: false$/,
  'never-opens-twice': /^tour: false$/,
  'take-the-tour-again': /^1:Send a request \| closed: true$/,
});
