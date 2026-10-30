// Team work in git: a teammate pushes a new test file; the Home card "Your team's changes" lists their commit with the item they
// changed in words (the app's own commits are left out), and the Git view's ⋯ menu offers "Invite a teammate…", a message with the
// clone address and the first steps, ready to copy.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

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
  // the examples hold demo passwords, which the commit's secret scan refuses: the base commit is made with git itself
  [
    'first-commit-and-push',
    `main:
      const { execFileSync } = require('node:child_process'); const cwd = require('node:path').join(home, 'ws');
      execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd }); execFileSync('git', ['config', 'user.name', 'E2E'], { cwd });
      execFileSync('git', ['add', '-A'], { cwd }); execFileSync('git', ['commit', '-m', 'Start the API tests'], { cwd });
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd });
      return 'pushed';`,
    false,
  ],
  // a teammate (another git identity) adds a request file in their own clone and pushes it
  [
    'teammate-pushes',
    `main:
      const { execFileSync } = require('node:child_process');
      const { writeFileSync, mkdirSync } = require('node:fs');
      const { join } = require('node:path');
      const mate = join(home, 'mate');
      execFileSync('git', ['clone', join(home, 'remote.git'), mate]);
      const who = { ...process.env, GIT_AUTHOR_NAME: 'Maya Teammate', GIT_AUTHOR_EMAIL: 'maya@example.com', GIT_COMMITTER_NAME: 'Maya Teammate', GIT_COMMITTER_EMAIL: 'maya@example.com' };
      const g = (...a) => execFileSync('git', a, { cwd: mate, env: who });
      mkdirSync(join(mate, 'tests', 'rest'), { recursive: true });
      writeFileSync(join(mate, 'tests', 'rest', 'maya-health.yaml'), 'name: Maya health check\\ntests:\\n  - id: ping\\n    name: Ping\\n    url: http://127.0.0.1:4010/health\\n');
      g('add', '-A'); g('commit', '-m', 'Add the health check');
      g('push', 'origin', 'main');
      return 'pushed';`,
    false,
  ],
  // the clone of this computer fetches and takes it (as the app does by itself); the Home card then shows it
  [
    'home-lists-the-team-commit',
    `(async () => {
      const ws = await window.aps.invoke('ws.current');
      await window.aps.invoke('git.pull');
      await __t.view('Git'); await __t.sleep(500);
      await __t.view('Home');
      const row = await __t.waitFor(() => [...document.querySelectorAll('[data-home-team-commit]')].find((r) => r.offsetParent), 10000);
      if (!row) return 'NO CARD';
      const t = row.textContent.replace(/\\s+/g, ' ').trim();
      return 'subject: ' + /Add the health check/.test(t) + ' | author: ' + /Maya Teammate/.test(t) + ' | item in words: ' + /Maya health check|maya-health/i.test(t) + ' | mine left out: ' + !/Start the API tests/.test(document.querySelector('[data-home-team]').textContent);
    })()`,
  ],
  [
    'invite-from-the-git-menu',
    `(async () => {
      await __t.view('Git');
      const more = await __t.waitFor(() => [...document.querySelectorAll('[aria-label="More actions"]')].find((b) => b.offsetParent), 6000); if (!more) return 'NO BUTTON';
      await __t.real.click(more);
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Invite a teammate')), 4000); if (!item) return 'NO MENU';
      await __t.real.click(item);
      const d = await __t.waitFor(() => document.querySelector('[data-invite]'), 6000); if (!d) return 'NO DIALOG';
      const text = document.querySelector('[data-invite-text]').textContent;
      const copy = document.querySelector('[data-invite-copy]');
      return 'install step: ' + /1\\. Install TestPion/.test(text) + ' | clone address: ' + /3\\. Paste this address: .*remote\\.git/.test(text) + ' | copy button: ' + !!copy + ' | guide link: ' + /start-here/.test(text);
    })()`,
  ],
];

module.exports = withExpect(
  steps,
  {
    'home-lists-the-team-commit': /^subject: true \| author: true \| item in words: true \| mine left out: true$/,
    'invite-from-the-git-menu': /^install step: true \| clone address: true \| copy button: true \| guide link: true$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
