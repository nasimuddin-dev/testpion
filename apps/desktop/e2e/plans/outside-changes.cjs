// Git, phase 1 (GIT-103): files changed outside the app (git pull, a branch switch, another editor) show up in the
// app by themselves, with a message; the app's own saves don't trigger it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');
const { readdirSync, statSync, utimesSync } = require('node:fs');
const { join } = require('node:path');

/** Files last read days ago, like an installed workspace's: Windows updates a file's access time on a read only when it is old. */
function ageAccessTimes(ws) {
  const old = new Date(Date.now() - 3 * 86400_000);
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else utimesSync(p, old, statSync(p).mtime);
    });
  walk(join(ws, 'tests'));
}

const toasts = `[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).filter((t) => /outside TestPion/.test(t))`;
const steps = [
  ['before', `(async () => { await __t.requests(); await __t.sleep(800); return 'collections: ' + [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.offsetParent && b.getAttribute('aria-expanded') !== null && !/\\d$/.test(b.textContent.trim())).length + ' | messages: ' + ${toasts}.length; })()`, false],
  // opening files only reads them (Windows reports the read as a change): no message
  [
    'opening-files-is-quiet',
    `(async () => {
      await __t.view('Tests'); await __t.sleep(800);
      const files = [...document.querySelectorAll('[data-tree-row]')].filter((b) => b.offsetParent && /\\.ya?ml$/.test(b.textContent.trim())).slice(0, 4);
      for (const f of files) { f.click(); await __t.sleep(700); }
      await __t.sleep(2500);
      const n = ${toasts}.length;
      await __t.requests();
      return 'opened: ' + files.length + ' | messages: ' + n;
    })()`,
  ],
  // another program renames a collection and adds a test file
  [
    'change-files-outside',
    `main:
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const ws = join(home, 'ws');
      const p = join(ws, 'collections', 'httpbin.json');
      const c = JSON.parse(readFileSync(p, 'utf8'));
      c.name = 'HTTP basics (renamed in git)';
      writeFileSync(p, JSON.stringify(c, null, 2));
      writeFileSync(join(ws, 'tests', 'from-git.yaml'), 'tests:\\n  - name: added by a pull\\n    type: http\\n    method: GET\\n    url: https://example.com\\n');
      return 'written';`,
    false,
  ],
  [
    'app-shows-it',
    `(async () => {
      const seen = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].some((b) => b.offsetParent && b.textContent.includes('renamed in git')), 5000);
      const msg = await __t.waitFor(() => ${toasts}[0], 3000);
      await __t.view('Tests'); await __t.sleep(800);
      const test = [...document.querySelectorAll('[data-tree-row]')].some((b) => b.offsetParent && b.textContent.trim().endsWith('from-git.yaml'));
      return 'tree updated: ' + !!seen + ' | test file listed: ' + test + ' | message: ' + (msg ?? 'none');
    })()`,
  ],
  // the app's own save is not "outside"
  [
    'own-save-is-quiet',
    `(async () => {
      await __t.sleep(5000); // the first message has gone
      const before = ${toasts}.length;
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      await window.aps.invoke('col.save', { ...c, name: 'HTTP basics (httpbin)' }); await __t.sleep(2500);
      return 'new messages after own save: ' + (${toasts}.length - before);
    })()`,
  ],
  // GIT-302: a request open with unsaved edits changes on disk (a pull): the app asks; taking the new version shows it
  [
    'edit-an-open-request',
    `(async () => {
      await __t.esc(); await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses');
      await __t.open('GET with query parameters'); await __t.sleep(800);
      const url = [...document.querySelectorAll('main input[aria-label="Request URL"]')].find((x) => x.offsetParent);
      if (!url) return 'NO URL';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(url, '{{httpbin}}/get?edited=mine'); url.dispatchEvent(new Event('input', { bubbles: true }));
      await __t.sleep(500);
      return 'edited: ' + /edited=mine/.test(url.value);
    })()`,
  ],
  [
    'same-request-changes-on-disk',
    `main:
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const p = join(home, 'ws', 'collections', 'httpbin.json');
      const c = JSON.parse(readFileSync(p, 'utf8'));
      const walk = (items) => items.forEach((i) => (i.id === 'hb-get' ? (i.request.url = '{{httpbin}}/get?from=git') : i.items && walk(i.items)));
      walk(c.items);
      writeFileSync(p, JSON.stringify(c, null, 2));
      return 'written';`,
    false,
  ],
  [
    'asked-and-takes-the-new-version',
    `(async () => {
      const dialog = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /changed on disk/.test(d.textContent)), 6000);
      if (!dialog) return 'NO PROMPT';
      const named = /GET with query parameters/.test(dialog.textContent);
      [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Take the new version')?.click();
      await __t.sleep(800);
      const url = [...document.querySelectorAll('main input[aria-label="Request URL"]')].find((x) => x.offsetParent);
      return 'prompt names the request: ' + named + ' | url: ' + (url?.value ?? 'NONE');
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'opening-files-is-quiet': /^opened: 4 \| messages: 0$/,
  'change-files-outside': /^written$/,
  'app-shows-it': /^tree updated: true \| test file listed: true \| message: .*1 collection, 1 test file changed outside TestPion/,
  'own-save-is-quiet': /^new messages after own save: 0$/,
  'edit-an-open-request': /^edited: true$/,
  'same-request-changes-on-disk': /^written$/,
  'asked-and-takes-the-new-version': /^prompt names the request: true \| url: \{\{httpbin\}\}\/get\?from=git$/,
}, { prepare: ageAccessTimes });
