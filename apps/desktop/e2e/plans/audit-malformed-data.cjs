// The window with malformed workspace files (robustness audit 2026-10-09): an environment without `variables`, a
// collection without `items`, a truncated collection and a truncated environment. Every view keeps working without
// falling back to its error boundary, the broken files stay listed (with their problem), and the window never goes blank.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

function prepare(ws) {
  writeFileSync(join(ws, 'environments', 'odd.json'), JSON.stringify({ id: 'odd', name: 'Odd' }));
  writeFileSync(join(ws, 'environments', 'broken.json'), '{"id":"broken","name":"Broken","variables":[{"key":"a"');
  writeFileSync(join(ws, 'collections', 'odd.json'), JSON.stringify({ schemaVersion: '1.0', id: 'odd', name: 'Odd collection' }));
  writeFileSync(join(ws, 'collections', 'broken.json'), '{"schemaVersion":"1.0","id":"broken","name":"Broken collection","items":[{"kind":"http"');
}

const alive = `((document.querySelector('header')?.innerText.length ?? 0) > 0 && (document.querySelector('footer')?.innerText.length ?? 0) > 0 ? 'ALIVE' : 'BLANK')`;
const problem = `([...document.querySelectorAll('main')].map((m) => m.innerText).join(' ').match(/This view ran into a problem[\\s\\S]{0,200}/) ?? [''])[0].replace(/\\s+/g, ' ')`;
const picker = `document.querySelector('header button[aria-label="Environment"]')`;

const steps = [
  ['start', `(async () => { await __t.sleep(1500); return ${alive}; })()`],
  ['environments-view', `(async () => { await __t.view('Environments'); await __t.sleep(1200); const t = document.querySelector('main')?.innerText ?? ''; return ${alive} + ' | ' + (${problem} || 'no boundary') + ' | odd listed: ' + /\\bOdd\\b/.test(t) + ' | broken listed: ' + /Broken/.test(t); })()`],
  [
    'pick-odd-environment',
    `(async () => {
      const b = ${picker}; if (!b) return 'NO PICKER';
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click();
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Odd'), 2000);
      if (!item) { await __t.esc(); return 'NO ODD ITEM | ' + ${alive}; }
      item.click(); await __t.sleep(1000);
      return ${alive} + ' | picker: ' + (${picker}?.textContent.trim() ?? 'gone');
    })()`,
  ],
  ['collections-explorer', `(async () => { await __t.view('Collections'); await __t.sleep(1500); const t = document.body.innerText; return ${alive} + ' | ' + (${problem} || 'no boundary') + ' | odd: ' + /Odd collection/.test(t) + ' | broken: ' + /Broken collection|broken\\.json/.test(t); })()`],
  ['search-dialog', `(async () => { await __t.key('ctrl+shift+f').catch?.(() => {}); await __t.sleep(800); const input = document.querySelector('[role=dialog] input'); if (input) { input.focus(); document.execCommand('insertText', false, 'get'); await __t.sleep(1200); } const d = document.querySelector('[role=dialog]')?.innerText.slice(0, 200).replace(/\\s+/g, ' ') ?? 'no dialog'; await __t.esc(); return ${alive} + ' | ' + d; })()`],
  ['send-with-odd-env', `(async () => { await __t.view('Collections'); await __t.sleep(800); const send = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Send'); send?.click(); await __t.sleep(2500); const t = document.querySelector('main')?.innerText ?? ''; return ${alive} + ' | ' + ((t.match(/Cannot read[^\\n]*|ProtocolError[^\\n]*|InternalError[^\\n]*|\\{\\{baseUrl\\}\\} has no value|\\b[1-5]\\d\\d\\b [A-Z][^\\n]{0,30}/) ?? ['no result'])[0]); })()`],
];

module.exports = withExpect(
  steps,
  {
    start: /ALIVE/,
    // an environment file without "variables" is listed with none; a truncated one is listed as unreadable
    'environments-view': /ALIVE \| no boundary \| odd listed: true \| broken listed: true/,
    'pick-odd-environment': /ALIVE/,
    // a truncated collection file stays where it is and stays listed (in red, with why)
    'collections-explorer': /ALIVE \| no boundary \| odd: true \| broken: true/,
    'search-dialog': /ALIVE/,
    // Send with that environment sends (it has no variables), never "Cannot read properties of undefined"
    // the environment has no variables: the request is checked and answered ({{baseUrl}} has no value), never a crash
    'send-with-odd-env': /^ALIVE \| (\{\{baseUrl\}\} has no value|[1-5]\d\d [A-Z])/,
  },
  { prepare },
);
