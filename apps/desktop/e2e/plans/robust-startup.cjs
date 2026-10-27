// E-8 The workspace from last time cannot be opened (a damaged workspace.json): Home says so in a card, with the engine's
// reason, Retry and Open another…, instead of an empty window and a toast that is gone in seconds. Fixing the file and
// pressing Retry opens the workspace and the card goes.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

let good = '';
function prepare(ws) {
  good = readFileSync(join(ws, 'workspace.json'), 'utf8');
  writeFileSync(join(ws, 'workspace.json'), '{"schemaVersion":');
  // the plan fixes the file again from the main process (below), so keep the good text where both can reach it
  writeFileSync(join(ws, '.good-workspace.json'), good);
}

const card = `document.querySelector('[data-startup-problem]')`;

const steps = [
  [
    'card-on-home',
    `(async () => {
      await __t.waitFor(() => ${card}, 10000);
      const c = ${card};
      if (!c) return 'NO CARD | ' + (document.querySelector('main')?.innerText ?? '').slice(0, 120).replace(/\\s+/g, ' ');
      const buttons = [...c.querySelectorAll('button')].map((b) => b.textContent.trim());
      return 'card | ' + c.innerText.replace(/\\s+/g, ' ').slice(0, 160) + ' | buttons: ' + buttons.join(', ');
    })()`,
    false,
  ],
  [
    'retry-after-fixing-the-file',
    `main:
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const problem = await win.webContents.executeJavaScript("window.aps.invoke('ws.openProblem')");
      writeFileSync(join(problem.path, 'workspace.json'), readFileSync(join(problem.path, '.good-workspace.json'), 'utf8'));
      return 'fixed ' + problem.path;`,
    false,
  ],
  [
    'retry-opens-it',
    `(async () => {
      const retry = [...${card}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Retry');
      if (!retry) return 'NO BUTTON';
      await __t.real.click(retry);
      const gone = !!(await __t.waitFor(() => !${card}, 8000));
      const ws = await window.aps.invoke('ws.current');
      return 'card gone: ' + gone + ' | opened: ' + !!ws?.name + ' | problem: ' + JSON.stringify(await window.aps.invoke('ws.openProblem'));
    })()`,
    false,
  ],
];

module.exports = withExpect(
  steps,
  {
    'card-on-home': /^card \| The workspace from last time could not be opened .*Could not open .* buttons: Retry, Open another…$/,
    'retry-after-fixing-the-file': /^fixed /,
    'retry-opens-it': /^card gone: true \| opened: true \| problem: null$/,
  },
  { prepare },
);
