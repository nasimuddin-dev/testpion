// A note for your team: in a workspace of your own, Home offers "Add a note for your team"; the few lines typed there are saved in the
// workspace file and shown under the workspace's name (with git they travel to the team); editing it replaces it, and clearing it brings the
// usual line back. The shipped examples workspace has no such link (its Home text is the app's).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const fresh = [
  'new-workspace-offers-a-note',
  `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
   await w.webContents.executeJavaScript("window.aps.invoke('ws.create', { name: 'Note team' })");
   w.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)); await w.webContents.executeJavaScript(require('node:fs').readFileSync(require.resolve('./helpers.js'), 'utf8')); await w.webContents.executeJavaScript(require('./real-input.cjs').PAGE);
   return 'reloaded';`,
  false,
];

const steps = [
  fresh,
  step(
    'a-workspace-of-your-own-offers-a-note',
    `const link = await __t.waitFor(() => vis('[data-workspace-note-edit]')[0], 8000);
     return 'workspace: ' + document.querySelector('h1')?.textContent.trim() + ' | link: ' + (link ? link.textContent.trim() : 'NONE') + ' | note shown: ' + !!vis('[data-workspace-note-text]').length;`,
  ),
  step(
    'saving-a-note-shows-it-under-the-name',
    `await __t.real.click(vis('[data-workspace-note-edit]')[0]);
     const box = await __t.waitFor(() => vis('[data-note-text]')[0], 5000); if (!box) return 'NO DIALOG';
     const off = vis('[data-note-save]')[0]?.disabled;
     await __t.real.click(box); await __t.real.type('Start with Staging. Ask Ana for the key.');
     await __t.sleep(300);
     await __t.real.click(vis('[data-note-save]')[0]);
     const shown = await __t.waitFor(() => vis('[data-workspace-note-text]')[0], 6000);
     const file = (await window.aps.invoke('ws.current', {})).description;
     return 'save off while unchanged: ' + off + ' | shown: ' + shown?.textContent.trim() + ' | in the workspace file: ' + file + ' | link now: ' + vis('[data-workspace-note-edit]')[0]?.textContent.trim();`,
  ),
  step(
    'clearing-it-brings-the-usual-line-back',
    `await __t.real.click(vis('[data-workspace-note-edit]')[0]);
     const box = await __t.waitFor(() => vis('[data-note-text]')[0], 5000); if (!box) return 'NO DIALOG';
     await __t.real.click(box); box.select(); await __t.real.key('Delete');
     await __t.sleep(300);
     await __t.real.click(vis('[data-note-save]')[0]);
     const gone = await __t.waitFor(() => (vis('[data-workspace-note-text]').length ? null : true), 6000);
     return 'note gone: ' + !!gone + ' | usual line: ' + /Everything stays on this computer/.test(document.querySelector('main')?.innerText ?? '') + ' | link: ' + vis('[data-workspace-note-edit]')[0]?.textContent.trim();`,
  ),
];

module.exports = withExpect(steps, {
  'new-workspace-offers-a-note': /^reloaded$/,
  'a-workspace-of-your-own-offers-a-note': /^workspace: Note team \| link: Add a note for your team \| note shown: false$/,
  'saving-a-note-shows-it-under-the-name': /^save off while unchanged: true \| shown: Start with Staging. Ask Ana for the key. \| in the workspace file: Start with Staging. Ask Ana for the key. \| link now: Edit the note for your team$/,
  'clearing-it-brings-the-usual-line-back': /^note gone: true \| usual line: true \| link: Add a note for your team$/,
});
