// A monitor for every tenant from one definition: with environments in a group (Acme ▸ Staging, Acme ▸ Production), a monitor
// saved with environmentGroup appears once per environment in the list (its own id, name and environment), the editor of a tenant
// row shows "Every environment of Acme", and deleting a tenant row deletes the definition (so every tenant).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'one-definition-two-tenants-in-the-list',
    `await window.aps.invoke('env.save', { env: { id: 'e2e-ten-staging', name: 'Staging', group: 'Acme', variables: [] } });
     await window.aps.invoke('env.save', { env: { id: 'e2e-ten-prod', name: 'Production', group: 'Acme', variables: [] } });
     const cols = await window.aps.invoke('col.list'); if (!cols[0]) return 'NO COLLECTION';
     const saved = await window.aps.invoke('monitor.save', { monitor: { name: 'Tenant mon', collectionId: cols[0].id, everyMinutes: 60, enabled: true, environment: 'Staging', environmentGroup: 'Acme' } });
     window.__tenantMonitorId = saved.id;
     const rows = (await window.aps.invoke('monitor.list')).filter((m) => m.tenant && m.tenant.of === saved.id);
     return 'saved env: ' + saved.environment + ' | rows: ' + rows.map((m) => m.name + ' [' + m.environment + ']').sort().join(' | ') + ' | ids: ' + rows.every((m) => m.id.startsWith(saved.id + '@'));`,
  ),
  step(
    'the-editor-of-a-tenant-row-says-every-environment-of-the-group',
    `await __t.view('Monitors'); await __t.sleep(900);
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside *, main *')].find((e) => e.children.length === 0 && e.offsetParent && /^Tenant mon · Acme ▸ /.test(e.textContent.trim())), 8000); if (!row) return 'NO ROW';
     const names = [...document.querySelectorAll('aside *, main *')].filter((e) => e.children.length === 0 && e.offsetParent && /^Tenant mon · Acme ▸ /.test(e.textContent.trim())).map((e) => e.textContent.trim());
     await __t.real.click(row); await __t.sleep(800);
     const edit = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Edit'), 5000); if (!edit) return 'NO EDIT BUTTON';
     await __t.real.click(edit);
     const sel = await __t.waitFor(() => document.querySelector('[data-monitor-env-group]'), 6000); if (!sel) return 'NO GROUP SELECT';
     const chosen = sel.options[sel.selectedIndex].textContent.trim();
     const close = [...document.querySelectorAll('[role=dialog] button')].find((b) => /^(Cancel|Close)$/.test(b.textContent.trim())); if (close) close.click();
     return 'rows in the list: ' + [...new Set(names)].sort().join(' | ') + ' | editor: ' + chosen;`,
  ),
  step(
    'deleting-a-tenant-row-deletes-the-definition',
    `const rows = (await window.aps.invoke('monitor.list')).filter((m) => m.tenant && m.tenant.of === window.__tenantMonitorId);
     await window.aps.invoke('monitor.delete', { id: rows[0].id });
     const left = (await window.aps.invoke('monitor.list')).filter((m) => m.id.startsWith(window.__tenantMonitorId)).length;
     await window.aps.invoke('env.delete', { id: 'e2e-ten-staging' }).catch(() => undefined); await window.aps.invoke('env.delete', { id: 'e2e-ten-prod' }).catch(() => undefined);
     return 'deleted by tenant id ' + rows[0].id.replace(window.__tenantMonitorId, 'ID') + ' | monitors left: ' + left;`,
  ),
];

module.exports = withExpect(steps, {
  'one-definition-two-tenants-in-the-list': /^saved env: undefined \| rows: Tenant mon · Acme ▸ Production \[Production\] \| Tenant mon · Acme ▸ Staging \[Staging\] \| ids: true$/,
  'the-editor-of-a-tenant-row-says-every-environment-of-the-group': /^rows in the list: Tenant mon · Acme ▸ Production \| Tenant mon · Acme ▸ Staging \| editor: Every environment of Acme$/,
  'deleting-a-tenant-row-deletes-the-definition': /^deleted by tenant id ID@e2e-ten-\w+ \| monitors left: 0$/,
});
