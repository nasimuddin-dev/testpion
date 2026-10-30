// "Pull my team's commits by itself" (Settings ▸ Git) and "who last changed it" on hover. A teammate pushes a change to an MCP
// server; with the setting on and nothing of mine in the workspace, the background fetch pulls it by itself, the app shows the new
// version and says who changed what; hovering the server's row in the explorer says "Teammate, just now", the commit and what it
// changed. With a change of mine in the workspace the next push is left alone (the Git view offers Pull as before).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const toast = (re, ms = 15000) => `__t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => ${re}.test(t)), ${ms})`;
const server = `(await window.aps.invoke('mcp.servers')).find((x) => x.id === 'deepwiki')`;

// a clone of the remote as the teammate, and a commit there
const teammate = (url, message) => `
  const { execFileSync } = require('node:child_process');
  const { existsSync, readFileSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const clone = join(home, 'teammate');
  const tm = (...a) => execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.com', ...a], { cwd: clone, env: { ...process.env, GIT_AUTHOR_NAME: 'Teammate', GIT_AUTHOR_EMAIL: 'teammate@example.com', GIT_COMMITTER_NAME: 'Teammate', GIT_COMMITTER_EMAIL: 'teammate@example.com' } });
  if (!existsSync(clone)) execFileSync('git', ['clone', join(home, 'remote.git'), clone]);
  else tm('pull', '--ff-only');
  const file = join(clone, 'mcp-servers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.servers = doc.servers.map((s) => (s.id === 'deepwiki' ? { ...s, url: ${JSON.stringify(url)} } : s));
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\\n');
  tm('commit', '-am', ${JSON.stringify(message)});
  tm('push');`;

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
      return 'connected';
    })()`,
  ],
  // the examples hold demo passwords, which the commit's secret scan refuses for good: the base commit is made with git itself
  [
    'first-commit',
    `main:
      const { execFileSync } = require('node:child_process'); const cwd = require('node:path').join(home, 'ws');
      execFileSync('git', ['add', '-A'], { cwd }); execFileSync('git', ['commit', '-m', 'Start the API tests'], { cwd });
      return 'committed';`,
    false,
  ],
  [
    'first-push',
    `(async () => {
      await window.aps.invoke('git.push');
      const st = await window.aps.invoke('git.status');
      return 'upstream: ' + st.upstream;
    })()`,
  ],
  [
    'switch-it-on',
    `(async () => {
      const s = await window.aps.invoke('settings.get');
      await window.aps.invoke('settings.save', { ...s, git: { ...s.git, autoPull: true } });
      return 'on: ' + (await window.aps.invoke('settings.get')).git.autoPull;
    })()`,
  ],
  ['teammate-pushes', `main:${teammate('https://mcp.deepwiki.com/mcp?v=2', 'Point DeepWiki at v2')}\n      return 'pushed';`, false],
  [
    'pulled-by-itself',
    `(async () => {
      await window.aps.invoke('git.autoFetch');
      const t = await ${toast('/Pulled 1 commit from your team/')};
      const st = await window.aps.invoke('git.status');
      return (t ? t.replace(/\\s+/g, ' ').slice(0, 70) : 'NO TOAST') + ' | behind: ' + st.behind + ' | url: ' + (${server}).url;
    })()`,
  ],
  [
    'hover-says-who-changed-it',
    `(async () => {
      await __t.requests(); await __t.sleep(800);
      const row = await __t.waitFor(() => document.querySelector('[data-node-id="mcp:deepwiki"] [data-tree-row]'), 5000); if (!row) return 'NO ROW';
      row.scrollIntoView({ block: 'center' }); await __t.sleep(200);
      await __t.real.move(row);
      const card = await __t.waitFor(() => document.querySelector('[data-git-who]'), 4000); if (!card) return 'NO CARD';
      const text = [...card.children].map((c) => c.textContent.trim()).join(' | ');
      await __t.real.move(document.querySelector('main')); await __t.sleep(400);
      return text + ' | gone after leaving: ' + !document.querySelector('[data-git-who]');
    })()`,
  ],
  // a change of mine in the workspace (even a new file): the next push of the teammate is left for the Git view to offer
  [
    'my-change-and-another-push',
    `main:
      require('node:fs').writeFileSync(require('node:path').join(home, 'ws', 'notes.md'), 'my notes');
      ${teammate('https://mcp.deepwiki.com/mcp?v=3', 'Point DeepWiki at v3')}
      return 'pushed';`,
    false,
  ],
  [
    'left-alone',
    `(async () => {
      await window.aps.invoke('git.autoFetch');
      await __t.sleep(2500);
      const pulled = [...document.querySelectorAll('[data-sonner-toast]')].some((t) => /Pulled 1 commit from your team/.test(t.textContent) && /v3/.test(t.textContent));
      const st = await window.aps.invoke('git.status');
      return 'behind: ' + st.behind + ' | pulled: ' + pulled + ' | url: ' + (${server}).url;
    })()`,
  ],
];

module.exports = withExpect(
  steps,
  {
    'bare-remote': /^remote ready$/,
    shared: /^connected$/,
    'first-commit': /^committed$/,
    'first-push': /^upstream: origin\/main$/,
    'switch-it-on': /^on: true$/,
    'teammate-pushes': /^pushed$/,
    'pulled-by-itself': /^Pulled 1 commit from your team \(Teammate\): .Point DeepWiki at v2.[^|]*\| behind: 0 \| url: https:\/\/mcp\.deepwiki\.com\/mcp\?v=2$/,
    'hover-says-who-changed-it': /^Teammate, (just now|\dm ago) \| .Point DeepWiki at v2. \| Changed: URL \| gone after leaving: true$/,
    'my-change-and-another-push': /^pushed$/,
    'left-alone': /^behind: 1 \| pulled: false \| url: https:\/\/mcp\.deepwiki\.com\/mcp\?v=2$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
