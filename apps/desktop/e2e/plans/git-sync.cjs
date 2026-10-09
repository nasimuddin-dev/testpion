// Git Pull & push: a teammate pushes a change to another request of the same collection while the app has a commit of
// its own; after Fetch the Git view shows "Pull 1", the "Your team pushed" strip, Pull & push instead of Push and a count
// on the rail's Git icon; Pull & push merges request by request and pushes, and the remote has both commits.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
const toast = (re) => `__t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => ${re}.test(t)), 15000)`;

// change one request of the httpbin collection in a clone's file (as saving it does)
const editRequest = `
  const editRequest = (file, id, patch) => {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    const walk = (nodes) => nodes.map((n) => (n.id === id ? { ...n, ...patch(n) } : n.kind === 'folder' ? { ...n, items: walk(n.items) } : n));
    writeFileSync(file, JSON.stringify({ ...c, items: walk(c.items) }, null, 2) + '\\n');
  };`;

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
    'shared',
    `(async () => {
      await __t.view('Git');
      const ws = await window.aps.invoke('ws.current');
      await window.aps.invoke('git.init', { remote: ws.path.replace(/[\\\\/]ws$/, '') + '/remote.git' });
      // the examples hold demo passwords: committed on purpose here
      const r = await window.aps.invoke('git.commit', { message: 'Start the API tests', paths: ['.'], force: true });
      await window.aps.invoke('git.push');
      const st = await window.aps.invoke('git.status');
      return 'committed: ' + r.committed + ' | upstream: ' + st.upstream;
    })()`,
  ],
  // the teammate renames one request and pushes; meanwhile the app commits a change to another request
  [
    'both-change',
    `main:
      const { execFileSync } = require('node:child_process');
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      ${editRequest}
      const clone = join(home, 'teammate');
      const tm = (...a) => execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.com', ...a], { cwd: clone });
      execFileSync('git', ['clone', join(home, 'remote.git'), clone]);
      editRequest(join(clone, 'collections', 'httpbin.json'), 'hb-post-json', () => ({ name: 'POST a JSON body (teammate)' }));
      tm('commit', '-am', 'Teammate renames the JSON post');
      tm('push');
      const ws = join(home, 'ws');
      editRequest(join(ws, 'collections', 'httpbin.json'), 'hb-get', (n) => ({ request: { ...n.request, url: '{{httpbin}}/get?mine=1' } }));
      execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-am', 'I change the GET'], { cwd: ws });
      return 'ready';`,
    false,
  ],
  [
    'behind-shown',
    `(async () => {
      await __t.view('Git'); await __t.sleep(800);
      ${button('Fetch')}?.click();
      const pull = await __t.waitFor(() => [...document.querySelectorAll('main button')].map((b) => b.textContent.trim()).find((t) => /^Pull 1$/.test(t)), 10000);
      const strip = await __t.waitFor(() => document.querySelector('[data-pull-first]')?.textContent.trim(), 5000);
      const header = !!${button('Pull & push')};
      const plainPush = !![...document.querySelectorAll('main button')].find((b) => b.offsetParent && /^Push\\b/.test(b.textContent.trim()));
      const rail = await __t.waitFor(() => document.querySelector('nav[aria-label="Main navigation"] button[aria-label="Git"] [data-rail-count]')?.textContent.trim(), 5000);
      return 'pull: ' + (pull ?? 'NONE') + ' | strip: ' + (strip ?? 'NONE') + ' | pull & push: ' + header + ' | push: ' + plainPush + ' | rail: ' + (rail ?? 'NONE');
    })()`,
  ],
  [
    'pull-and-push',
    `(async () => {
      ${button('Pull & push')}?.click();
      const done = await ${toast('/pushed|conflict/i')};
      await __t.sleep(1500);
      const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'httpbin');
      const text = JSON.stringify(c.items);
      const st = await window.aps.invoke('git.status');
      const strip = !!document.querySelector('[data-pull-first]');
      const rail = !!document.querySelector('nav[aria-label="Main navigation"] [data-rail-count]');
      return (done ?? 'NO TOAST') + ' | theirs: ' + text.includes('POST a JSON body (teammate)') + ' | mine: ' + text.includes('get?mine=1') + ' | ahead/behind: ' + st.ahead + '/' + st.behind + ' | strip: ' + strip + ' | rail: ' + rail;
    })()`,
  ],
  [
    'remote-has-both',
    `main:
      const { execFileSync } = require('node:child_process');
      const { join } = require('node:path');
      const log = execFileSync('git', ['--git-dir', join(home, 'remote.git'), 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim().split('\\n');
      return 'teammate: ' + log.includes('Teammate renames the JSON post') + ' | mine: ' + log.includes('I change the GET') + ' | merge: ' + log.some((s) => /^Merge/.test(s));`,
    false,
  ],
];

module.exports = withExpect(
  steps,
  {
    'bare-remote': /^remote ready$/,
    shared: /^committed: true \| upstream: origin\/main$/,
    'both-change': /^ready$/,
    'behind-shown': /^pull: Pull 1 \| strip: Your team pushed 1 commit\. Pull before pushing\..* \| pull & push: true \| push: false \| rail: 1$/,
    'pull-and-push': /^Pulled 1 commit, merged, and pushed [2-9] commits\. \| theirs: true \| mine: true \| ahead\/behind: 0\/0 \| strip: false \| rail: false$/,
    'remote-has-both': /^teammate: true \| mine: true \| merge: true$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
