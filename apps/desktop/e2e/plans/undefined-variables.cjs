// The environment switcher (top bar and status bar) shows a red count when the request on screen uses {{variables}} the
// active environment, its collection and the globals don't define; it follows typing (real keys), and each one opens
// the variable popover to add it (Also add to the other environments); added, the count goes.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

// a second environment, so the popover offers Also add to
function prepare(ws) {
  writeFileSync(
    join(ws, 'environments', 'e2e-other.json'),
    JSON.stringify({ id: 'e2e-other', name: 'E2E other', variables: [{ key: 'httpbin', value: 'http://127.0.0.1:4010', enabled: true }] }, null, 2),
  );
  // a request whose test script holds a visualizer (Handlebars) template, like the examples' "List patients"
  const testScript = 'const template = `<h3>{{total}} patients</h3>{{#each items}}<td>{{id}}</td>{{else}}none{{/each}}`;\npm.visualizer.set(template, pm.response.json());';
  writeFileSync(
    join(ws, 'collections', 'e2e-visualizer.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-visualizer', name: 'E2E visualizer', version: 1, variables: [], updatedAt: new Date(0).toISOString(), items: [{ kind: 'http', id: 'e2e-vis-list', name: 'Visualized list', request: { method: 'GET', url: '{{httpbin}}/get' }, testScript }] }, null, 2),
  );
}

const H = `
  const badges = () => [...document.querySelectorAll('[data-undefined-vars]')].filter((b) => b.getClientRects().length);
  const counts = () => badges().map((b) => (b.closest('header') ? 'top ' : b.closest('footer') ? 'status ' : '? ') + b.textContent.trim()).join(', ') || 'none';
  const url = () => vis('main input[aria-label="Request URL"]')[0];
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'baseurl-at-first',
    `await __t.newTab('HTTP request'); await __t.sleep(600);
     // a new tab starts at {{baseUrl}}/, which the examples' environment doesn't define
     return 'url: ' + url().value + ' | badges: ' + counts();`,
  ),
  s(
    'typing-adds-one',
    `await __t.real.click(url()); await __t.real.key('a', { ctrl: true }); await __t.real.type('{{badgeHost}}/pets/{{badgeId}}?x={{$guid}}'); await __t.sleep(1500);
     const two = counts();
     // a defined one does not count: the examples' environment has httpbin
     await __t.real.key('a', { ctrl: true }); await __t.real.type('{{httpbin}}/get?id={{badgeId}}'); await __t.sleep(1500);
     return 'two: ' + two + ' | one: ' + counts();`,
  ),
  s(
    'add-from-the-badge',
    `const b = badges().find((x) => x.closest('header')); if (!b) return 'NO BADGE';
     await __t.real.click(b);
     const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => /badgeId/.test(m.textContent)), 2000); if (!item) return 'NO ITEM';
     const label = item.textContent.trim();
     await __t.real.click(item);
     const pop = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Variable badgeId"]'), 3000); if (!pop) return 'NO POPOVER | ' + label;
     const also = pop.querySelectorAll('[data-also-add] label').length;
     const field = pop.querySelector('input.field'); await __t.real.click(field); await __t.real.type('42');
     [...pop.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add')?.click();
     await __t.waitFor(() => !badges().length, 6000);
     return label + ' | also add offered: ' + (also > 0) + ' | after: ' + counts();`,
  ),
  // {{total}}, {{#each items}}, {{id}}, {{/each}} in a script are not variables: no badge
  s(
    'visualizer-template-not-counted',
    `await __t.requests(); const e = await __t.expand('E2E visualizer'); if (e !== 'ok') return e;
     const o = await __t.open('Visualized list'); if (o !== 'ok') return o; await __t.sleep(1500);
     return 'url: ' + url()?.value + ' | badges: ' + counts();`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'baseurl-at-first': /^url: \{\{baseUrl\}\}\/ \| badges: top 1, status 1$/,
    'typing-adds-one': /^two: top 2, status 2 \| one: top 1, status 1$/,
    'add-from-the-badge': /^Add \{\{badgeId\}\} to .+… \| also add offered: true \| after: none$/,
    'visualizer-template-not-counted': /^url: \{\{httpbin\}\}\/get \| badges: none$/,
  },
  { prepare },
);
