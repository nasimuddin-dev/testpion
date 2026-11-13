// An MCP server in a collection folder: a folder's New request ▸ New MCP server adds a server that is placed in that
// folder (it stays in the workspace's list of MCP servers), its row sits among the folder's requests, a real drag moves
// it to another folder, and Move to ▸ Out of the collection takes it out again without deleting the server.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const node = (id) => document.querySelector('aside [data-node-id="' + id + '"]');
  const toggleOf = (r) => (r?.hasAttribute('aria-expanded') ? r : r?.querySelector('[aria-expanded]'));
  const unfold = async (id) => { const r = await __t.waitFor(() => node(id), 4000); const t = toggleOf(r); if (t && t.getAttribute('aria-expanded') === 'false') { t.click(); await __t.sleep(400); } return r; };
  const placed = async () => (await window.aps.invoke('mcp.servers')).filter((s) => s.collectionId === 'e2e-mcpcol');
  const where = async () => (await placed()).map((s) => s.name + '@' + (s.folderId ?? 'top')).join(',') || 'none';
  const items = () => [...document.querySelectorAll('[role=menuitem]')];
  const openSub = async (row, label) => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
    const sub = await __t.waitFor(() => items().find((m) => m.textContent.trim().startsWith(label) && m.getAttribute('aria-haspopup')), 3000);
    if (!sub) return false;
    sub.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })); sub.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); sub.click();
    return true;
  };
`;

const steps = [
  step(
    'new-mcp-server-in-a-folder',
    `${H}
     await window.aps.invoke('col.save', { id: 'e2e-mcpcol', name: 'With a server', items: [
       { kind: 'folder', id: 'e2e-ma', name: 'A', items: [{ kind: 'http', id: 'e2e-m1', name: 'One', request: { method: 'GET', url: 'https://example.test/1', headers: [], params: [] } }] },
       { kind: 'folder', id: 'e2e-mb', name: 'B', items: [] },
     ] });
     await __t.requests(); await __t.sleep(800);
     await unfold('e2e-mcpcol'); await unfold('e2e-mcpcol:e2e-ma'); await unfold('e2e-mcpcol:e2e-mb');
     if (!(await openSub(node('e2e-mcpcol:e2e-ma'), 'New request'))) { await __t.esc(); return 'NO SUBMENU'; }
     const item = await __t.waitFor(() => items().find((m) => m.textContent.trim() === 'New MCP server'), 3000);
     if (!item) { await __t.esc(); return 'NO ITEM'; }
     item.click();
     // the MCP tab's own Save (next to Connect): every editor keeps a Save of its own while its tab is behind
     const seen = (b) => b.getBoundingClientRect().width > 0;
     const save = await __t.waitFor(() => { const c = [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Connect' && seen(b)); return c && [...c.parentElement.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save' && !b.disabled); }, 5000);
     if (!save) return 'NO SAVE BUTTON';
     save.click();
     await __t.waitFor(async () => ((await placed()).length ? true : null), 5000);
     const s = (await placed())[0]; if (!s) return 'NOT PLACED';
     const row = await __t.waitFor(() => node('e2e-mcpcol:mcp:' + s.id), 5000);
     const all = (await window.aps.invoke('mcp.servers')).some((x) => x.id === s.id);
     return 'placed: ' + (await where()) + ' | row: ' + !!row + ' | badge: ' + (row?.textContent.includes('MCP') ?? false) + ' | in the list of servers: ' + all;`,
  ),
  step(
    'a-server-dragged-onto-another-folder-moves-into-it',
    `${H}
     const s = (await placed())[0]; if (!s) return 'NO SERVER';
     const a = node('e2e-mcpcol:mcp:' + s.id); const b = node('e2e-mcpcol:e2e-mb'); if (!a || !b) return 'NO ROWS ' + !!a + '/' + !!b;
     const r = await __t.real.dnd(a, b); if (r !== 'ok') return 'DND: ' + r;
     await __t.waitFor(async () => ((await placed())[0]?.folderId === 'e2e-mb' ? true : null), 4000);
     return 'placed: ' + (await where());`,
  ),
  step(
    'move-out-of-the-collection-keeps-the-server',
    `${H}
     const s = (await placed())[0]; if (!s) return 'NO SERVER';
     if (!(await openSub(node('e2e-mcpcol:mcp:' + s.id), 'Move to'))) { const all = items().map((m) => m.textContent.trim()).join(' | '); await __t.esc(); return 'NO SUBMENU: ' + all; }
     const out = await __t.waitFor(() => items().find((m) => m.textContent.trim().startsWith('Out of the collection')), 3000);
     if (!out) { await __t.esc(); return 'NO ITEM'; }
     out.click();
     await __t.waitFor(async () => ((await placed()).length ? null : true), 4000);
     await __t.sleep(400);
     const kept = (await window.aps.invoke('mcp.servers')).some((x) => x.id === s.id);
     return 'placed: ' + (await where()) + ' | row: ' + !!node('e2e-mcpcol:mcp:' + s.id) + ' | kept: ' + kept;`,
  ),
  step(
    'clean-up',
    `const list = await window.aps.invoke('mcp.servers');
     await window.aps.invoke('mcp.saveServers', { servers: list.filter((s) => s.name !== 'New MCP server').map(({ connected, ...s }) => s) }).catch(() => undefined);
     await window.aps.invoke('col.delete', { id: 'e2e-mcpcol' }).catch(() => undefined);
     return 'done';`,
  ),
];

module.exports = withExpect(steps, {
  'new-mcp-server-in-a-folder': /^placed: New MCP server@e2e-ma \| row: true \| badge: true \| in the list of servers: true$/,
  'a-server-dragged-onto-another-folder-moves-into-it': /^placed: New MCP server@e2e-mb$/,
  'move-out-of-the-collection-keeps-the-server': /^placed: none \| row: false \| kept: true$/,
  'clean-up': /^done$/,
});
