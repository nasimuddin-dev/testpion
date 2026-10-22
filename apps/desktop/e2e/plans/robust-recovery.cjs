// E-3 A renderer crash is logged and the window comes back: the page is killed from the main process, app.log gets the
// record, the page reloads by itself (once) and is usable again; a dead white window never stays.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  ['before', `document.querySelector('header') ? 'ALIVE' : 'BLANK'`, false],
  [
    'crash-and-recover',
    `main:
      const { BrowserWindow } = require('electron');
      const { readFileSync } = require('node:fs');
      const { join } = require('node:path');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const w = BrowserWindow.getAllWindows()[0];
      const loaded = new Promise((r) => w.webContents.once('did-finish-load', () => r(true)));
      w.webContents.forcefullyCrashRenderer();
      const back = await Promise.race([loaded, sleep(20000).then(() => false)]);
      let alive = false;
      for (let i = 0; i < 40 && !alive; i++) {
        await sleep(250);
        alive = await w.webContents.executeJavaScript("(document.querySelector('header')?.innerText.length ?? 0) > 0").catch(() => false);
      }
      const log = readFileSync(join(home, 'logs', 'app.log'), 'utf8');
      return 'reloaded: ' + back + ' | usable: ' + alive + ' | logged: ' + /The window's page crashed/.test(log);`,
    false,
  ],
];

module.exports = withExpect(steps, {
  before: /^ALIVE$/,
  'crash-and-recover': /^reloaded: true \| usable: true \| logged: true$/,
});
