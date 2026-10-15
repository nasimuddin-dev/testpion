// WF-05 The environment everywhere, the same way: the status bar's segment opens the same picker as the top bar;
// Ctrl+Shift+E opens Quick Open on environments; the Collection runner's field is the same picker; a run header shows
// the run's environment as a badge.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const items = [{ kind: 'http', id: 'envs-1', name: 'E2E envs health', request: { method: 'GET', url: 'http://127.0.0.1:4010/health?envs=1', headers: [] } }];
  writeFileSync(
    join(ws, 'collections', 'e2e-envs.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-envs', name: 'E2E envs', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

const H = `
  const press = (b) => { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); };
  const item = (re) => __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => re.test(m.textContent.trim())), 3000);
  const top = () => document.querySelector('header button[aria-label="Environment"]')?.textContent.trim();
  const seg = () => document.querySelector('footer [data-status="environment"]');
`;

const steps = [
  step(
    'status-bar-switches',
    `${H}
     const s = await __t.waitFor(seg, 5000); if (!s) return 'NO SEGMENT';
     press(s); (await item(/^No environment$/))?.click(); await __t.sleep(600);
     const none = top() + ' / ' + seg().textContent.trim();
     press(seg()); (await item(/^Public APIs/))?.click(); await __t.sleep(600);
     return none + ' → ' + top() + ' / ' + seg().textContent.trim();`,
  ),
  step(
    'ctrl-shift-e',
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, bubbles: true }));
     const input = await __t.waitFor(() => document.querySelector('[role=dialog] input'), 3000); if (!input) return 'NO PALETTE';
     await __t.sleep(400);
     const rows = [...document.querySelectorAll('[role=dialog] [role=option]')].map((o) => o.textContent.trim());
     const value = input.value; const ph = input.placeholder; await __t.esc();
     return 'query: ' + JSON.stringify(value) + ' | placeholder: ' + ph + ' | has Public APIs: ' + rows.some((r) => /Public APIs/.test(r)) + ' | rows: ' + rows.length;`,
  ),
  step(
    'runner-badge',
    `${H}
     await __t.requests();
     const r = await __t.menu('E2E envs'); if (/NO /.test(r)) return r;
     (await item(/^Run collection$/))?.click();
     const field = await __t.waitFor(() => document.querySelector('main button[aria-label="Environment"]'), 5000); if (!field) return 'NO FIELD';
     const run = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => /^Run /.test(b.textContent.trim()) && !b.disabled), 3000); if (!run) return 'NO RUN BUTTON';
     run.click();
     const badge = await __t.waitFor(() => document.querySelector('main [data-env-badge]'), 15000);
     return 'field: ' + field.textContent.trim() + ' | header badge: ' + (badge ? badge.getAttribute('data-env-badge') : 'NONE');`,
  ),
  // Load has the same picker: it starts on the active environment, and picking another leaves the top bar alone
  step(
    'load-field',
    `${H}
     await __t.view('Load');
     const field = () => document.querySelector('main button[aria-label="Environment"]');
     if (!(await __t.waitFor(field, 5000))) return 'NO FIELD';
     const first = field().textContent.trim();
     press(field()); (await item(/^No environment$/))?.click(); await __t.sleep(400);
     const picked = field().textContent.trim();
     press(field()); (await item(/^Public APIs/))?.click(); await __t.sleep(300);
     return 'field: ' + first + ' → ' + picked + ' | top bar: ' + top();`,
  ),
  // the production switch says what the guard does now
  step(
    'production-toggle',
    `await __t.view('Environments'); await __t.sleep(800);
     const l = await __t.waitFor(() => [...document.querySelectorAll('main label')].find((x) => /^Production/.test(x.textContent.trim())), 5000);
     if (!l) return 'NO TOGGLE';
     return l.textContent.trim() + ' | help: ' + /asks first/.test(l.title) + ' | blocks: ' + /block/i.test(l.textContent + l.title);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'status-bar-switches': /^No environment \/ No environment → Public APIs \/ Public APIs$/,
    'ctrl-shift-e': /^query: "" \| placeholder: Environment or variable… \| has Public APIs: true \| rows: \d+$/,
    'runner-badge': /^field: Public APIs \| header badge: Public APIs$/,
    'load-field': /^field: Public APIs → No environment \| top bar: Public APIs$/,
    'production-toggle': /^Production — asks before anything that changes data \| help: true \| blocks: false$/,
  },
  { prepare },
);
