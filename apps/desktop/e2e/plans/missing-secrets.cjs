// Missing secrets: a secret variable keeps its value in the OS secret store, never in the workspace files, so after a clone every one is empty
// on this computer. The environment file says the variable is secret; Home's "Needs attention" lists the environment as a warning (the
// same list as the Problems tab, `testpion problems` and `what_needs_attention`), a click opens the environment, and the empty secret says
// where to type it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

/** An environment of a clone: its secret variables are named in the file and empty here. */
function prepare(ws) {
  writeFileSync(
    join(ws, 'environments', 'e2e-clone.json'),
    JSON.stringify({ id: 'e2e-clone', name: 'E2E clone', variables: [{ key: 'apiKey', value: '', secret: true, enabled: true }, { key: 'baseUrl', value: 'http://127.0.0.1:4010', enabled: true }] }, null, 2),
  );
}

const steps = [
  step(
    'home-lists-the-environment',
    `await __t.view('Home'); await __t.sleep(1200);
     const card = await __t.waitFor(() => document.querySelector('section[aria-label="Needs attention"]'), 8000); if (!card) return 'NO CARD';
     const row = await __t.waitFor(() => [...card.querySelectorAll('[data-problem]')].find((r) => /E2E clone/.test(r.textContent)), 6000); if (!row) return 'NO ROW: ' + card.innerText.slice(0, 200);
     return 'says: ' + row.textContent.replace(/\\s+/g, ' ').trim().replace(/^.*?(Environment)/, '$1');`,
  ),
  step(
    'the-row-opens-the-environment-and-the-secret-says-where-to-type',
    `const card = document.querySelector('section[aria-label="Needs attention"]');
     const row = [...card.querySelectorAll('[data-problem]')].find((r) => /E2E clone/.test(r.textContent));
     row.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(row.querySelector('button') ?? row);
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'environments', 5000);
     const box = await __t.waitFor(() => [...document.querySelectorAll('input')].find((i) => i.offsetParent && /^No value on this computer/.test(i.placeholder)), 8000);
     return 'view: ' + localStorage.getItem('aps.view') + ' | secret field says where to type: ' + !!box;`,
  ),
];

module.exports = withExpect(steps, {
  'home-lists-the-environment': /^says: Environment "E2E clone" has a secret with no value on this computer: apiKey$/,
  'the-row-opens-the-environment-and-the-secret-says-where-to-type': /^view: environments \| secret field says where to type: true$/,
}, { prepare });
