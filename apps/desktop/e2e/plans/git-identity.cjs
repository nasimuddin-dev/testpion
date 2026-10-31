// Who are you? A computer that has never used git has no name and e-mail, and git refuses to commit. The Git view's commit then asks for
// them in a small dialog (kept for this workspace's repository only), and the commit that was refused runs again by itself.
// The plan runs with a git that knows nobody (no global config, no author variables).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
const toast = (re) => `__t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => ${re}.test(t)), 10000)`;

const steps = [
  [
    'a-repository-and-a-message',
    `(async () => {
      await __t.view('Git');
      await window.aps.invoke('git.init', {});
      const id = await window.aps.invoke('git.identity', {});
      // only a harmless file is staged: the examples' demo passwords would stop the commit at the secret guard
      await window.aps.invoke('tests.write', { path: 'rest/identity-check.yaml', content: 'name: Identity check\\ntests:\\n  - id: a\\n    name: A\\n    url: http://127.0.0.1:4010/health\\n' });
      await window.aps.invoke('git.stage', { paths: ['tests/rest/identity-check.yaml'] });
      await __t.view('Home'); await __t.view('Git'); await __t.sleep(800);
      const ta = await __t.waitFor(() => document.querySelector('textarea[aria-label="Commit message"]'), 8000); if (!ta) return 'NO MESSAGE BOX';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'First commit');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'identity known: ' + id.ok;
    })()`,
  ],
  [
    'commit-asks-who-you-are',
    `(async () => {
      await __t.sleep(300);
      ${button('Commit')}?.click();
      const dlg = await __t.waitFor(() => document.querySelector('[data-git-identity]'), 8000); if (!dlg) return 'NO DIALOG';
      const off = document.querySelector('[data-identity-save]')?.disabled;
      return 'dialog: true | save off until filled: ' + off;
    })()`,
  ],
  [
    'saving-the-identity-commits-again',
    `(async () => {
      await __t.real.click(document.querySelector('[data-identity-name]')); await __t.real.type('Ana Silva');
      await __t.real.click(document.querySelector('[data-identity-email]')); await __t.real.type('ana@example.com');
      await __t.sleep(300);
      await __t.real.click(document.querySelector('[data-identity-save]'));
      const done = await ${toast('/^Committed/')};
      const id = await window.aps.invoke('git.identity', {});
      return 'committed: ' + !!done + ' | identity: ' + id.name + ' <' + id.email + '>';
    })()`,
  ],
];

module.exports = withExpect(
  steps,
  {
    'a-repository-and-a-message': /^identity known: false$/,
    'commit-asks-who-you-are': /^dialog: true \| save off until filled: true$/,
    'saving-the-identity-commits-again': /^committed: true \| identity: Ana Silva <ana@example\.com>$/,
  },
  { env: { GIT_CONFIG_GLOBAL: join(tmpdir(), 'tp-no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } },
);
