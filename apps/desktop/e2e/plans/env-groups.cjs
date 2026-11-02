// Environment groups (a tenant, a customer, a deployment): the editor's Group field; the Environments list and the active-environment
// picker show "Acme ▸ Staging" and keep the group's environments together; the CLI carries the group.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'grouped-environments-in-the-picker',
    `await window.aps.invoke('env.save', { env: { id: 'e2e-acme-staging', name: 'Staging', group: 'Acme', variables: [{ key: 'baseUrl', value: 'https://acme.example.com', enabled: true }] } });
     await window.aps.invoke('env.save', { env: { id: 'e2e-acme-prod', name: 'Production', group: 'Acme', isProduction: true, variables: [] } });
     await __t.sleep(800);
     const pill = [...document.querySelectorAll('button[aria-label="Environment"]')].find((b) => b.offsetParent); if (!pill) return 'NO PICKER';
     await __t.real.click(pill);
     const items = await __t.waitFor(() => { const m = [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()); return m.some((t) => /Acme/.test(t)) ? m : null; }, 5000); if (!items) return 'NO ITEMS';
     await __t.real.key('Escape'); await __t.sleep(200);
     return 'picker: ' + items.filter((t) => /Acme/.test(t)).sort().join(' | ');`,
  ),
  step(
    'the-list-and-the-editor-show-the-group',
    `await __t.view('Environments'); await __t.sleep(900);
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((r) => /Acme ▸/.test(r.textContent) && /Staging/.test(r.textContent)), 8000); if (!row) return 'NO ROW';
     row.click(); await __t.sleep(900);
     const field = await __t.waitFor(() => document.querySelector('[data-env-group]'), 6000); if (!field) return 'NO FIELD';
     return 'row: ' + row.textContent.replace(/\s+/g, ' ').trim().slice(0, 30) + ' | field: ' + field.value;`,
  ),
  // the Info panel of a grouped environment names its tenant (RPC ref.info carries `tenant`)
  step(
    'the-info-panel-names-the-tenant',
    `const host = () => document.querySelector('[data-pinnable-panel="right"]');
     const h = await __t.waitFor(host, 5000); if (!h) return 'NO HOST';
     if (!h.querySelector('[data-context-info]')) h.querySelector('button[aria-expanded]')?.click();
     const info = await __t.waitFor(() => h.querySelector('[data-context-info="environment"]'), 6000); if (!info) return 'NO INFO: ' + (h.querySelector('[data-context-info]')?.getAttribute('data-context-info') ?? 'none');
     const t = await __t.waitFor(() => info.querySelector('[data-context-tenant]'), 6000);
     const viaRpc = await window.aps.invoke('ref.info', { ref: { kind: 'environment', environmentId: 'e2e-acme-staging' } });
     return 'panel: ' + (t ? t.textContent.trim() : 'none') + ' | rpc: ' + viaRpc.tenant;`,
  ),
  // a new tenant: the editor of a grouped environment offers to copy the whole group; the copies keep names and variables
  step(
    'a-new-tenant-from-the-group',
    `const btn = await __t.waitFor(() => document.querySelector('[data-env-duplicate-group]'), 6000); if (!btn) return 'NO BUTTON';
     const label = btn.textContent.trim();
     const made = await window.aps.invoke('env.duplicateGroup', { group: 'Acme', newGroup: 'Globex' });
     await __t.sleep(800);
     const list = await window.aps.invoke('env.list');
     const globex = list.filter((e) => e.group === 'Globex').map((e) => e.name + ':' + e.variables.length).sort().join(',');
     for (const e of [...made, { id: 'e2e-acme-staging' }, { id: 'e2e-acme-prod' }]) await window.aps.invoke('env.delete', { id: e.id }).catch(() => undefined);
     return 'button: ' + label + ' | copies: ' + made.length + ' | globex: ' + globex;`,
  ),
];

module.exports = withExpect(steps, {
  'grouped-environments-in-the-picker': /^picker: Acme ▸ Production {2}\(production\) \| Acme ▸ Staging$/,
  'the-list-and-the-editor-show-the-group': /^row: Acme ▸ Staging.* \| field: Acme$/,
  'the-info-panel-names-the-tenant': /^panel: Tenant Acme \| rpc: Acme$/,
  'a-new-tenant-from-the-group': /^button: New tenant from Acme… \| copies: 2 \| globex: Production:0,Staging:1$/,
});
