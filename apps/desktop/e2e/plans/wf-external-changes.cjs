// WF-15 Open editors follow their file: a GraphQL request open without edits shows the version a pull (here: another
// program) wrote; with unsaved edits it asks "Keep mine / Take the new version" first, the same question as REST.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const items = [{ kind: 'graphql', id: 'ext-q', name: 'E2E ext query', request: { endpoint: 'http://127.0.0.1:4010/graphql', query: '{ startingQuery }', headers: [] } }];
  writeFileSync(
    join(ws, 'collections', 'e2e-ext.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-ext', name: 'E2E ext', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

/** Another program changes the saved query (a pull). */
const writeQuery = (q) => [
  `disk-${q}`,
  `main:
    const { readFileSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const p = join(home, 'ws', 'collections', 'e2e-ext.json');
    const c = JSON.parse(readFileSync(p, 'utf8'));
    c.items[0].request.query = '{ ${q} }';
    writeFileSync(p, JSON.stringify(c, null, 2));
    return 'written';`,
  false,
];
const H = `
  const text = () => document.querySelector('main')?.innerText ?? '';
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const dialog = () => vis('[role=dialog], [role=alertdialog]').find((d) => /changed on disk/.test(d.textContent));
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });

const steps = [
  s(
    'open',
    `await __t.requests(); await __t.waitFor(() => document.querySelector('aside input[placeholder^="Filter"]'), 8000); const r = await __t.find('E2E ext query'); if (r !== 'ok') return r; await __t.waitFor(() => /startingQuery/.test(text()), 5000); return 'shows: ' + /startingQuery/.test(text());`,
  ),
  writeQuery('fromDiskOne'),
  s('clean-follows', `const ok = await __t.waitFor(() => /fromDiskOne/.test(text()), 8000); return 'follows: ' + !!ok + ' | asked: ' + !!dialog();`),
  s(
    'edit',
    `const ep = vis('main input[aria-label="GraphQL endpoint"]')[0]; if (!ep) return 'NO INPUT';
     setVal(ep, ep.value + '/edited'); await __t.sleep(400);
     return 'edited: ' + /\\/edited$/.test(ep.value);`,
  ),
  writeQuery('fromDiskTwo'),
  s(
    'dirty-asks',
    `const d = await __t.waitFor(dialog, 8000); if (!d) return 'NO DIALOG';
     const buttons = [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
     const title = short(d.textContent, 40);
     [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Take the new version')?.click();
     const ok = await __t.waitFor(() => /fromDiskTwo/.test(text()), 5000);
     const ep = vis('main input[aria-label="GraphQL endpoint"]')[0];
     return title + ' | buttons: ' + buttons.join(' / ') + ' | took: ' + !!ok + ' | edits dropped: ' + !/\\/edited$/.test(ep?.value ?? '');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    open: /^shows: true$/,
    'disk-fromDiskOne': /^written$/,
    'clean-follows': /^follows: true \| asked: false$/,
    edit: /^edited: true$/,
    'disk-fromDiskTwo': /^written$/,
    'dirty-asks': /^"E2E ext query" changed on disk.* \| buttons: Keep mine \/ Take the new version \| took: true \| edits dropped: true$/,
  },
  { prepare },
);
