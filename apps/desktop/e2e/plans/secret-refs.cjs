// Secret manager references in an environment: a variable whose value is op://… shows under the variables as coming
// from 1Password and not allowed yet; Allow… shows the exact command before anything runs (cancelled here: no op CLI).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'reference-shown-as-not-allowed',
    `(async () => {
      await window.aps.invoke('env.save', { env: { id: 'e2e-refs', name: 'E2E refs', variables: [{ key: 'apiKey', value: 'op://Clinic/API/credential' }] } });
      await __t.view('Environments'); await __t.sleep(800);
      [...document.querySelectorAll('main button, main [role=option], main li')].find((b) => b.textContent.trim().startsWith('E2E refs'))?.click();
      const line = await __t.waitFor(() => document.querySelector('main [data-secret-refs]'), 6000);
      return (line?.textContent ?? 'NO LINE').replace(/\s+/g, ' ').trim();
    })()`,
  ],
  [
    'allow-shows-the-command-first',
    `(async () => {
      [...document.querySelectorAll('main [data-secret-refs] button')].find((b) => b.textContent.trim() === 'Allow…')?.click();
      const dialog = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /Read secrets from 1Password/.test(d.textContent)), 4000);
      const cmd = /op read --no-newline op:\/\/Clinic\/API\/credential/.test(dialog?.textContent ?? '');
      [...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')?.click(); await __t.sleep(300);
      await window.aps.invoke('env.delete', { id: 'e2e-refs' }).catch(() => undefined);
      return 'dialog: ' + !!dialog + ' | command shown: ' + cmd;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'reference-shown-as-not-allowed': /^From 1Password: apiKey \(not allowed yet\) Allow… Read again$/,
  'allow-shows-the-command-first': /^dialog: true \| command shown: true$/,
});
