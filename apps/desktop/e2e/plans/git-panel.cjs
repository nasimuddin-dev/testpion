// Git, phase 2 (GIT-201 … GIT-210): the Git view with a local bare repository as the remote. Initialize, commit (the
// secret guard first), push, a change shown by meaning (Git view, explorer mark, status bar), another clone's change
// pulled in, and a request's history in git.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
const toast = (re) => `__t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => ${re}.test(t)), 8000)`;
const typeMessage = (text) => `(() => {
  const ta = document.querySelector('textarea[aria-label="Commit message"]');
  if (!ta) return false;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
// Commit; the examples hold demo passwords, so the secret guard stops it first: then "Commit anyway"
const commit = (message) => `(async () => {
  if (!${typeMessage(message)}) return 'NO INPUT commit message';
  await __t.sleep(300);
  ${button('Commit')}?.click();
  // either the guard stops it (then Commit anyway), or it is committed at once: whichever shows first
  const committed = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => /^Committed/.test(t));
  const first = await __t.waitFor(() => [...document.querySelectorAll('[role=alert]')].find((a) => /Not committed/.test(a.textContent)) || committed(), 8000);
  if (typeof first === 'string') return 'not blocked | ' + first;
  const blocked = first ? first.textContent.match(/Not committed: \\d+ secrets?/)?.[0] : 'not blocked';
  ${button('Commit anyway')}?.click();
  const done = await ${toast('/^Committed/')};
  return blocked + ' | ' + (done ?? 'NO TOAST');
})()`;

const steps = [
  [
    'bare-remote',
    `main:
      const { execFileSync } = require('node:child_process');
      const { join } = require('node:path');
      execFileSync('git', ['init', '--bare', '-b', 'main', join(home, 'remote.git')]);
      return 'remote ready';`,
    false,
  ],
  [
    'initialize',
    `(async () => {
      await __t.view('Git');
      const empty = await __t.waitFor(() => /not in git yet/.test(document.querySelector('main')?.innerText ?? ''), 4000);
      ${button('Initialize repository')}?.click();
      const ready = await __t.waitFor(() => document.querySelector('[aria-label="Changes"]'), 8000);
      return 'offered: ' + !!empty + ' | changes listed: ' + !!ready;
    })()`,
  ],
  // the secret guard's list is something to act on: each finding opens where it is, and Fix all moves every typed value
  // to a secret variable of the active environment and leaves {{references}} in the files
  [
    'secrets-fix-all',
    `(async () => {
      if (!${typeMessage('Start the API tests')}) return 'NO INPUT commit message';
      await __t.sleep(300);
      ${button('Commit')}?.click();
      const guard = await __t.waitFor(() => [...document.querySelectorAll('[role=alert]')].find((a) => /Not committed/.test(a.textContent)), 5000);
      if (!guard) return 'NO ALERT';
      const before = Number((guard.textContent.match(/Not committed: (\\d+)/) || [])[1]);
      const rows = guard.querySelectorAll('li').length;
      const opens = guard.querySelectorAll('li button').length;
      [...guard.querySelectorAll('button')].find((b) => /^Fix all/.test(b.textContent.trim()))?.click();
      const done = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => /moved to secret variable|left to do/.test(t)), 15000);
      await __t.sleep(800);
      const after = await window.aps.invoke('git.check');
      if (after.length) return 'LEFT: ' + after.map((f) => f.kind + ':' + f.where + ':' + f.field).join(' ; ') + ' | toast: ' + done;
      const env = (await window.aps.invoke('env.list')).find((e) => e.name === 'Public APIs');
      const secretVars = env.variables.filter((v) => v.secret).map((v) => v.key);
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      const wrong = JSON.stringify(c.items).match(/"password":"[^{][^"]*"/);
      return 'before: ' + before + ' | rows: ' + rows + ' | per-row buttons: ' + (opens >= rows) + ' | fixed: ' + /moved/.test(done ?? '') + ' | left: ' + after.length + ' | secret vars: ' + secretVars.length + ' | plain password left: ' + !!wrong;
    })()`,
  ],
  ['first-commit', commit('Start the API tests')],
  [
    'connect-and-push',
    `(async () => {
      const ws = await window.aps.invoke('ws.current');
      await window.aps.invoke('git.init', { remote: ws.path.replace(/[\\\\/]ws$/, '') + '/remote.git' });
      await __t.sleep(1500);
      ${button('Push')}?.click();
      const pushed = await ${toast('/^Pushed/')};
      const st = await window.aps.invoke('git.status');
      return (pushed ?? 'NO TOAST') + ' | upstream: ' + st.upstream + ' | changes: ' + st.files.length;
    })()`,
  ],
  [
    'change-by-meaning',
    `(async () => {
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      const walk = (nodes) => nodes.map((n) => n.id === 'hb-get' ? { ...n, request: { ...n.request, url: '{{httpbin}}/anything' } } : n.kind === 'folder' ? { ...n, items: walk(n.items) } : n);
      await window.aps.invoke('col.save', { ...c, items: walk(c.items) });
      const line = await __t.waitFor(() => [...document.querySelectorAll('[aria-label="Changes"] li li')].map((l) => l.textContent.trim()).find((t) => /GET with query parameters/.test(t)), 6000);
      // the status bar refreshes on its own (shortly after the save)
      const bar = await __t.waitFor(() => [...document.querySelectorAll('footer button')].map((b) => b.textContent.trim()).find((t) => /^main.*•/.test(t)), 4000);
      await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses');
      const row = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('GET with query parameters'));
      const mark = row?.querySelector('[title="Changed"]')?.textContent;
      return 'git view: ' + (line ?? 'NONE') + ' | status bar: ' + (bar ?? 'NONE') + ' | explorer mark: ' + (mark ?? 'NONE');
    })()`,
  ],
  [
    'second-commit-and-push',
    `(async () => {
      await __t.view('Git');
      const r = await ${commit('Call /anything')};
      ${button('Push')}?.click();
      return r + ' | ' + ((await ${toast('/^Pushed/')}) ?? 'NO TOAST');
    })()`,
  ],
  // a teammate changes another request in their own clone and pushes
  [
    'teammate-pushes',
    `main:
      const { execFileSync } = require('node:child_process');
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const clone = join(home, 'teammate');
      const git = (...a) => execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.com', ...a], { cwd: clone });
      execFileSync('git', ['clone', join(home, 'remote.git'), clone]);
      const p = join(clone, 'collections', 'httpbin.json');
      const c = JSON.parse(readFileSync(p, 'utf8'));
      const walk = (nodes) => nodes.map((n) => n.id === 'hb-post-json' ? { ...n, name: 'POST a JSON body (teammate)' } : n.kind === 'folder' ? { ...n, items: walk(n.items) } : n);
      writeFileSync(p, JSON.stringify({ ...c, items: walk(c.items) }, null, 2) + '\\n');
      git('commit', '-am', 'Rename the JSON post');
      git('push');
      return 'pushed';`,
    false,
  ],
  [
    'pull',
    `(async () => {
      await __t.view('Git');
      ${button('Fetch')}?.click(); await __t.sleep(2000);
      ${button('Pull')}?.click();
      const pulled = await ${toast('/Up to date with the remote|conflicts/')};
      await __t.sleep(1500);
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      const names = JSON.stringify(c.items);
      const log = await window.aps.invoke('git.log', { limit: 5 });
      return (pulled ?? 'NO TOAST') + ' | teammate change: ' + names.includes('POST a JSON body (teammate)') + ' | commits: ' + log.map((x) => x.subject).join(' / ');
    })()`,
  ],
  [
    'request-history',
    `(async () => {
      await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses');
      const items = await __t.menu('GET with query parameters');
      const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'History in git…');
      if (!item) return 'NO MENU ' + items;
      item.click();
      const list = await __t.waitFor(() => document.querySelector('[aria-label="Versions"]'), 6000);
      const versions = list ? [...list.querySelectorAll('li')].map((l) => l.querySelector('div')?.textContent.trim()) : [];
      await __t.esc();
      return 'versions: ' + versions.join(' / ');
    })()`,
  ],
  [
    'compare-a-change',
    `(async () => {
      // a request changed (as another editor would): the Git view's Compare shows it part by part
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      const walk = (nodes) => nodes.map((n) => (n.id === 'hb-get' ? { ...n, request: { ...n.request, url: '{{httpbin}}/get?compare=1' } } : n.kind === 'folder' ? { ...n, items: walk(n.items) } : n));
      await window.aps.invoke('col.save', { ...c, items: walk(c.items) });
      await __t.view('Git'); await __t.sleep(1500);
      const link = await __t.waitFor(() => [...document.querySelectorAll('main ul[aria-label=Changes] button')].find((b) => b.offsetParent && b.textContent.trim() === 'Compare'), 6000);
      if (!link) return 'NO COMPARE';
      link.click();
      const table = await __t.waitFor(() => document.querySelector('[role=dialog] [data-item-diff] [data-part=Request]'), 6000);
      const text = table?.textContent ?? '';
      await __t.esc(); await __t.sleep(300);
      await window.aps.invoke('git.discard', { files: [{ path: 'collections/httpbin.json', state: 'modified', staged: false }] }); await __t.sleep(800);
      return 'request part: ' + /get\?compare=1/.test(text);
    })()`,
  ],
  [
    'collection-history',
    `(async () => {
      await __t.requests(); await __t.sleep(500);
      await __t.menu('HTTP basics (httpbin)');
      const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'History in git…');
      if (!item) return 'NO MENU';
      item.click();
      const list = await __t.waitFor(() => document.querySelector('[aria-label="Versions"]'), 6000);
      const n = list ? list.querySelectorAll('li').length : 0;
      const diff = await __t.waitFor(() => document.querySelector('[role=dialog] [data-history-diff] table'), 6000);
      await __t.esc();
      return 'versions: ' + (n >= 2) + ' | compared with now: ' + !!diff;
    })()`,
  ],
  [
    'conflicting-changes',
    `main:
      const { execFileSync } = require('node:child_process');
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const setUrl = (file, url) => {
        const c = JSON.parse(readFileSync(file, 'utf8'));
        const walk = (nodes) => nodes.map((n) => (n.id === 'hb-get' ? { ...n, request: { ...n.request, url } } : n.kind === 'folder' ? { ...n, items: walk(n.items) } : n));
        writeFileSync(file, JSON.stringify({ ...c, items: walk(c.items) }, null, 2) + '\\n');
      };
      const clone = join(home, 'teammate');
      const tm = (...a) => execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.com', ...a], { cwd: clone });
      tm('pull');
      setUrl(join(clone, 'collections', 'httpbin.json'), '{{httpbin}}/get?side=theirs');
      tm('commit', '-am', 'Teammate changes the GET');
      tm('push');
      const ws = join(home, 'ws');
      setUrl(join(ws, 'collections', 'httpbin.json'), '{{httpbin}}/get?side=mine');
      execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-am', 'I change the GET'], { cwd: ws });
      return 'ready';`,
    false,
  ],
  [
    'conflict-compared-and-resolved',
    `(async () => {
      await __t.view('Git'); await __t.sleep(1000);
      ${button('Pull')}?.click();
      const compare = await __t.waitFor(() => [...document.querySelectorAll('main section[role=alert] button')].find((b) => b.textContent.trim() === 'Compare…'), 10000);
      if (!compare) return 'NO CONFLICT';
      compare.click();
      const item = await __t.waitFor(() => document.querySelector('[role=dialog] [data-conflict="item:hb-get"]'), 8000);
      if (!item) return 'NO CONFLICT ITEM';
      const parts = [...item.querySelectorAll('[data-part]')].map((r) => r.getAttribute('data-part'));
      [...item.querySelectorAll('[role=radio]')].find((r) => r.textContent.trim() === 'Theirs')?.click(); await __t.sleep(200);
      [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Resolve with these choices')?.click();
      await __t.waitFor(() => !document.querySelector('main section[role=alert]'), 8000);
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      return 'differing parts: ' + parts.join(',') + ' | url: ' + (JSON.stringify(c.items).match(/get\?side=\w+/)?.[0] ?? 'NONE');
    })()`,
  ],
  [
    'branch-renamed',
    `(async () => {
      await __t.view('Git'); await __t.sleep(800);
      ${button('main')}?.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Rename main/.test(m.textContent.trim()))?.click();
      const field = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] input')].find((i) => i.value === 'main'), 4000);
      if (!field) return 'NO PROMPT';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, 'trunk'); field.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Rename')?.click();
      await __t.sleep(1500);
      const b = await window.aps.invoke('git.branches');
      return 'current: ' + b.current;
    })()`,
  ],
];

module.exports = withExpect(
  steps,
  {
    'bare-remote': /^remote ready$/,
    initialize: /^offered: true \| changes listed: true$/,
    'secrets-fix-all': /^before: [1-9]\d* \| rows: [1-9]\d* \| per-row buttons: true \| fixed: true \| left: 0 \| secret vars: [1-9]\d* \| plain password left: false$/,
    'first-commit': /^not blocked \| Committed [0-9a-f]{7}/,
    'connect-and-push': /^Pushed \| upstream: origin\/main \| changes: 0$/,
    'change-by-meaning': /^git view: .*GET with query parameters.*URL.* \| status bar: main.*• 1 \| explorer mark: M$/,
    'second-commit-and-push': /^not blocked \| Committed [0-9a-f]{7} \| Pushed/,
    'teammate-pushes': /^pushed$/,
    pull: /^Up to date with the remote \| teammate change: true \| commits: Rename the JSON post \/ Call \/anything \/ Start the API tests$/,
    'request-history': /^versions: Call \/anything \/ Start the API tests$/,
    'compare-a-change': /^request part: true$/,
    'collection-history': /^versions: true \| compared with now: true$/,
    'conflicting-changes': /^ready$/,
    'conflict-compared-and-resolved': /^differing parts: Request \| url: get\?side=theirs$/,
    'branch-renamed': /^current: trunk$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
