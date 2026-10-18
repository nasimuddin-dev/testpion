// Deleting an MCP server from the sidebar (EX-G6): no "Are you sure?" first; the server goes at once and the message
// has Undo, which brings it back with its id, its folder and its place in the list. Deleted again, it is in Collections
// ▸ Recently deleted (the sidebar's Recently deleted button: an "MCP server" row) and restores from there. The MCP tab's
// ⋯ ▸ Delete… is the same Delete (Undo, Recently deleted). Real input throughout.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step, OPEN_RECENTLY_DELETED } = require('../lib.cjs');

const H = `
  // the toasts on screen (one on its way out, data-removed, is not: a delete repeated replaces its message)
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')];
  const toastText = (re) => toasts().map((t) => t.textContent.trim()).find((t) => re.test(t));
  const toastButton = (re, label) => toasts().find((t) => re.test(t.textContent))?.querySelector('button[data-button]:not([data-cancel])') ?? toasts().flatMap((t) => [...t.querySelectorAll('button')]).find((b) => b.textContent.trim() === label);
  const dialogs = () => document.querySelectorAll('[role=dialog], [role=alertdialog]').length;
  const order = async () => (await window.aps.invoke('mcp.servers')).map((s) => s.id + (s.folder ? '@' + s.folder : '')).join(',');
  const serverRow = () => document.querySelector('[data-node-id="mcp:deepwiki"] [data-tree-row]');
  /** Right-click the DeepWiki row and choose Delete… from its menu (real input). */
  const deleteDeepWiki = async () => {
    const row = await __t.waitFor(serverRow, 3000); if (!row) return 'NO ROW';
    row.scrollIntoView({ block: 'center' }); await __t.sleep(200);
    await __t.real.rightClick(row);
    const del = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Delete…'), 2000); if (!del) return 'NO DELETE';
    await __t.real.click(del); await __t.sleep(1000);
    return 'ok';
  };
  /** Open DeepWiki's tab (a click on its row) and choose Delete… from the tab's ⋯ menu (real input): the same Delete. */
  const deleteFromTab = async () => {
    const row = await __t.waitFor(serverRow, 3000); if (!row) return 'NO ROW';
    row.scrollIntoView({ block: 'center' });
    await __t.real.click(row);
    const more = await __t.waitFor(() => [...document.querySelectorAll('button[aria-label="More server actions"]')].find((x) => x.offsetParent), 4000); if (!more) return 'NO ⋯ BUTTON';
    await __t.real.click(more);
    const del = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Delete…'), 2000); if (!del) return 'NO DELETE';
    await __t.real.click(del);
    return 'ok';
  };
`;
const s = (name, body) => step(name, body, true, { extra: H + OPEN_RECENTLY_DELETED, short: 600 });

const steps = [
  s(
    'delete-without-a-question',
    `await __t.requests(); window.__mcpBefore = await order();
     const d = await deleteDeepWiki(); if (d !== 'ok') return d;
     const msg = await __t.waitFor(() => toastText(/Deleted the MCP server "DeepWiki"/), 3000);
     const now = await order();
     return 'dialogs: ' + dialogs() + ' | message: ' + (msg ? msg.replace(/Undo.*$/, '').trim() : 'NONE') + ' | gone: ' + !now.includes('deepwiki') + ' | row: ' + !!serverRow();`,
  ),
  s(
    'undo-puts-it-back-in-place',
    `const b = await __t.waitFor(() => toastButton(/Deleted the MCP server "DeepWiki"/, 'Undo'), 3000); if (!b) return 'NO UNDO BUTTON';
     await __t.real.click(b);
     const back = await __t.waitFor(() => toastText(/Restored the MCP server "DeepWiki"/), 4000);
     await __t.waitFor(serverRow, 3000);
     return 'restored: ' + !!back + ' | same place, id and folder: ' + ((await order()) === window.__mcpBefore) + ' | row: ' + !!serverRow();`,
  ),
  s(
    'recently-deleted-lists-it',
    `const d = await deleteDeepWiki(); if (d !== 'ok') return d;
     await __t.waitFor(() => toastText(/Deleted the MCP server "DeepWiki"/), 3000);
     const dlg = await openRecentlyDeleted(); if (typeof dlg === 'string') return dlg;
     const li = await __t.waitFor(() => [...dlg.querySelectorAll('li')].find((x) => /DeepWiki/.test(x.textContent)), 3000); if (!li) return 'NOT LISTED: ' + dlg.innerText.slice(0, 200);
     const line = li.querySelector('.text-xs')?.textContent.trim().replace(/ · deleted.*$/, '');
     const restore = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Restore');
     await __t.real.click(restore);
     await __t.waitFor(async () => (await order()).includes('deepwiki'), 4000);
     await __t.esc();
     return 'listed as: ' + line + ' | restored to its place: ' + ((await order()) === window.__mcpBefore);`,
  ),
  // the MCP tab's ⋯ ▸ Delete… is the same Delete as the sidebar's: Recently deleted, Undo back in its place
  s(
    'mcp-tab-delete-undo',
    `const before = new Set(toasts());
     const d = await deleteFromTab(); if (d !== 'ok') return d;
     // this delete's own message (the last step's may still be on screen until this one replaces it)
     const mine = () => toasts().find((t) => !before.has(t) && /Deleted the MCP server "DeepWiki"/.test(t.textContent));
     const msg = (await __t.waitFor(mine, 3000))?.textContent.trim();
     const gone = await __t.waitFor(async () => !(await order()).includes('deepwiki'), 3000);
     const b = await __t.waitFor(() => mine()?.querySelector('button[data-button]:not([data-cancel])'), 3000); if (!b) return 'NO UNDO BUTTON';
     await __t.sleep(400); // the message has settled (it slides in): the click lands on its Undo
     await __t.real.click(b);
     const back = await __t.waitFor(() => toastText(/Restored the MCP server "DeepWiki"/), 4000);
     await __t.waitFor(serverRow, 3000);
     return 'dialogs: ' + dialogs() + ' | message: ' + (msg ? msg.replace(/Undo.*$/, '').trim() : 'NONE') + ' | gone: ' + !!gone + ' | restored: ' + !!back + ' | same place: ' + ((await order()) === window.__mcpBefore);`,
  ),
  s(
    'mcp-tab-delete-in-recently-deleted',
    `const d = await deleteFromTab(); if (d !== 'ok') return d;
     await __t.waitFor(() => toastText(/Deleted the MCP server "DeepWiki"/), 3000);
     const dlg = await openRecentlyDeleted(); if (typeof dlg === 'string') return dlg;
     const li = await __t.waitFor(() => [...dlg.querySelectorAll('li')].find((x) => /DeepWiki/.test(x.textContent)), 3000); if (!li) return 'NOT LISTED: ' + dlg.innerText.slice(0, 200);
     const restore = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Restore');
     await __t.real.click(restore);
     await __t.waitFor(async () => (await order()).includes('deepwiki'), 4000);
     await __t.esc();
     return 'listed: true | restored to its place: ' + ((await order()) === window.__mcpBefore);`,
  ),
];

module.exports = withExpect(steps, {
  'delete-without-a-question': /^dialogs: 0 \| message: Deleted the MCP server "DeepWiki"\. Recently deleted keeps it for 30 days \| gone: true \| row: false$/,
  'undo-puts-it-back-in-place': /^restored: true \| same place, id and folder: true \| row: true$/,
  'recently-deleted-lists-it': /^listed as: MCP server \| restored to its place: true$/,
  'mcp-tab-delete-undo': /^dialogs: 0 \| message: Deleted the MCP server "DeepWiki"\. Recently deleted keeps it for 30 days \| gone: true \| restored: true \| same place: true$/,
  'mcp-tab-delete-in-recently-deleted': /^listed: true \| restored to its place: true$/,
});
