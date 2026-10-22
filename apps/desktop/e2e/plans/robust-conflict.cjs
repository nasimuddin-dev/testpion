// C-2 A save that would overwrite what another program changed on disk asks first: Keep mine / Take theirs / Open both,
// and nothing is lost silently. The collection variables are edited in the Environments view; another program (here: a
// "main:" step, like git pull) rewrites the file just before Save is pressed, inside the watcher's debounce, so the window
// still holds the version it read.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepOf } = require('../lib.cjs');

function prepare(ws) {
  const items = [{ kind: 'http', id: 'c-r', name: 'E2E conflict request', request: { method: 'GET', url: 'http://127.0.0.1:4010/get', headers: [], params: [] } }];
  writeFileSync(
    join(ws, 'collections', 'e2e-conflict.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-conflict',
        name: 'E2E conflict',
        version: 1,
        updatedAt: new Date().toISOString(),
        description: 'start',
        variables: [{ key: 'userId', value: '1', enabled: true }],
        items,
      },
      null,
      2,
    ),
  );
}

const H = `
  const tabs = () => [...document.querySelectorAll('main [role=tab]')].filter((t) => t.offsetParent && !t.closest('[aria-label="Open environments"]'));
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const dialog = () => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find((d) => d.getClientRects().length > 0 && /Changed on disk/.test(d.textContent));
  const userId = () => { const key = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && i.value === 'userId'); const row = key?.closest('tr') ?? key?.parentElement?.parentElement; return row && [...row.querySelectorAll('input')].find((i) => i !== key && i.type !== 'checkbox'); };
  const disk = async () => (await window.aps.invoke('col.list')).find((x) => x.id === 'e2e-conflict');
`;
const step = stepOf(H);

/** Another program rewrites the collection file (the description changes; the variables stay as they were). */
const outside = (name, text) => [
  name,
  `main:
    const { readFileSync, writeFileSync, utimesSync } = require('node:fs');
    const { join } = require('node:path');
    const p = join(home, 'ws', 'collections', 'e2e-conflict.json');
    const c = JSON.parse(readFileSync(p, 'utf8'));
    c.description = '${text}';
    writeFileSync(p, JSON.stringify(c, null, 2));
    const t = new Date(Date.now() + 3000); utimesSync(p, t, t);
    return 'written';`,
  false,
];

/** Edit the variable and press Save at once: the window has not heard of the outside change yet. */
const editAndSave = (name, value) =>
  step(
    name,
    `const v = userId(); if (!v) return 'NO ROW'; setVal(v, '${value}'); await __t.sleep(100);
    return 'edited';`,
  );
const pressSave = (name) =>
  step(
    name,
    `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Save' && !b.disabled)?.click();
    const sv = [...document.querySelectorAll('main button')].filter((b) => b.offsetParent && b.textContent.trim() === 'Save').map((b) => b.disabled); const d = await __t.waitFor(dialog, 6000); if (!d) return 'NO DIALOG | save buttons disabled: ' + sv.join(',') + ' | toasts: ' + [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' // ') + ' | value: ' + userId()?.value;
    return 'asked: ' + [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' / ');`,
    false,
  );
const choose = (name, label) =>
  step(
    name,
    `const d = dialog(); if (!d) return 'NO DIALOG'; [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '${label}')?.click(); await __t.waitFor(() => !dialog(), 5000); await __t.sleep(800); return 'chose ${label}';`,
    false,
  );

const steps = [
  step(
    'open',
    `await __t.view('Environments'); await __t.sleep(800); const t = tabs().find((x) => x.textContent.trim().startsWith('Collection variables')); t?.click(); await __t.sleep(800);
    const b = [...document.querySelectorAll('main [aria-label="Collections"] button')].find((x) => x.textContent.includes('E2E conflict')); if (!b) return 'NO COLLECTION'; b.click(); await __t.sleep(800);
    return userId() ? 'ready' : 'NO ROW';`,
  ),

  // 1. Keep mine: my edit is saved over the outside change
  editAndSave('mine-edit', '8'),
  outside('mine-outside', 'pulled one'),
  pressSave('mine-asks'),
  choose('mine-choose', 'Keep mine'),
  step('mine-result', `const c = await disk(); return 'userId ' + c.variables[0].value + ' | description ' + c.description;`, false),

  // 2. Take theirs: the outside version stays, my edit is dropped
  editAndSave('theirs-edit', '9'),
  outside('theirs-outside', 'pulled two'),
  pressSave('theirs-asks'),
  choose('theirs-choose', 'Take theirs'),
  step('theirs-result', `const c = await disk(); return 'userId ' + c.variables[0].value + ' | description ' + c.description;`, false),

  // 3. Open both: the outside version stays, my edit is saved as a copy
  editAndSave('both-edit', '10'),
  outside('both-outside', 'pulled three'),
  pressSave('both-asks'),
  choose('both-choose', 'Open both'),
  step(
    'both-result',
    `const all = await window.aps.invoke('col.list'); const c = all.find((x) => x.id === 'e2e-conflict'); const copy = all.find((x) => x.name === 'E2E conflict (my changes)');
     return 'theirs: ' + c.description + ' / ' + c.variables[0].value + ' | copy: ' + (copy ? copy.variables[0].value : 'MISSING');`,
    false,
  ),
];

module.exports = withExpect(
  steps,
  {
    open: /^ready$/,
    'mine-edit': /^edited$/,
    'mine-outside': /^written$/,
    'mine-asks': /^asked: Cancel \/ Take theirs \/ Keep mine \/ Open both$/,
    'mine-result': /^userId 8 \| description start$/,
    'theirs-edit': /^edited$/,
    'theirs-outside': /^written$/,
    'theirs-asks': /^asked: Cancel \/ Take theirs \/ Keep mine \/ Open both$/,
    'theirs-result': /^userId 8 \| description pulled two$/,
    'both-edit': /^edited$/,
    'both-outside': /^written$/,
    'both-asks': /^asked: Cancel \/ Take theirs \/ Keep mine \/ Open both$/,
    'both-result': /^theirs: pulled three \/ 8 \| copy: 10$/,
  },
  { prepare },
);
