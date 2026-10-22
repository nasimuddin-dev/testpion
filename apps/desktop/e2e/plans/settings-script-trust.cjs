// Settings ▸ Privacy & security ▸ Script trust: what the open workspace was allowed (hosts, secret reads) is listed, each row has a
// Forget button that asks first, and Forget everything empties the list. A decision made while a script was refused shows up here.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const panel = () => vis('[data-script-trust]')[0];
  const rows = () => [...(panel()?.querySelectorAll('[data-trust-row]') ?? [])].map((r) => r.getAttribute('data-trust-row') + ':' + r.textContent.replace(/\\s+/g, ' ').trim().replace(/ \\(since.*$/, '').replace(/Forget$/, '').trim());
  const confirmYes = async () => { const d = await __t.waitFor(() => vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Forget'), 3000); if (!d) return false; d.click(); await __t.sleep(600); return true; };
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'decisions-are-listed',
    `await window.aps.invoke('scripts.allow', { host: 'api.e2e-trust.test' });
     await window.aps.invoke('scripts.allow', { secrets: true });
     await __t.view('Settings'); await __t.tab('Privacy & security');
     if (!(await __t.waitFor(() => panel(), 3000))) return 'NO PANEL';
     return rows().join(' | ');`,
  ),
  s(
    'forget-one-host',
    `const btn = vis('[data-trust-row=host] button')[0]; if (!btn) return 'NO BUTTON';
     btn.click(); await __t.sleep(300);
     if (!(await confirmYes())) return 'NO CONFIRM';
     const t = await window.aps.invoke('scripts.trust');
     return rows().join(' | ') + ' || hosts: ' + t.hosts.length + ' secrets: ' + !!t.secretReads;`,
  ),
  s(
    'forget-everything',
    `const btn = [...panel().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Forget everything'); if (!btn) return 'NO BUTTON';
     btn.click(); await __t.sleep(300);
     if (!(await confirmYes())) return 'NO CONFIRM';
     const t = await window.aps.invoke('scripts.trust');
     return 'rows: ' + rows().length + ' || hosts: ' + t.hosts.length + ' secrets: ' + !!t.secretReads + ' | says: ' + (panel().textContent.includes('Nothing is allowed yet') ? 'nothing' : 'something');`,
  ),
];

module.exports = withExpect(steps, {
  'decisions-are-listed': /^secrets:Scripts may read secret variables \| host:Scripts may send to api\.e2e-trust\.test$/,
  'forget-one-host': /^secrets:Scripts may read secret variables \|\| hosts: 0 secrets: true$/,
  'forget-everything': /^rows: 0 \|\| hosts: 0 secrets: false \| says: nothing$/,
});
