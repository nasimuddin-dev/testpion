// Recently deleted ▸ Delete for good asks with a danger dialog that starts on Cancel: Enter pressed a moment too early
// keeps the item (Enter still answers a question dialog with its primary button); the Delete for good button removes it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step, OPEN_RECENTLY_DELETED } = require('../lib.cjs');

const H = `
  const dialogs = () => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')];
  const confirm = () => dialogs().find((d) => /Delete for good/.test(d.querySelector('h2, [id]')?.textContent ?? '') && /This cannot be undone/.test(d.textContent));
  const recently = () => dialogs().find((d) => /Recently deleted/.test(d.textContent) && !/This cannot be undone/.test(d.textContent));
  const rowOf = (name) => [...(recently()?.querySelectorAll('li') ?? [])].find((x) => x.textContent.includes(name));
  const focusedText = () => { const a = document.activeElement; return (a?.textContent?.trim() || a?.getAttribute('aria-label') || a?.tagName || '') + (a?.closest('[role=dialog]') ? '' : ' (outside a dialog)'); };
  /** Delete the DeepWiki MCP server from the sidebar (no question: Undo and Recently deleted). */
  const deleteDeepWiki = async () => {
    await __t.requests();
    const row = await __t.waitFor(() => document.querySelector('[data-node-id="mcp:deepwiki"] [data-tree-row]'), 3000); if (!row) return 'NO ROW';
    row.scrollIntoView({ block: 'center' }); await __t.sleep(200);
    await __t.real.rightClick(row);
    const del = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Delete…'), 2000); if (!del) return 'NO DELETE';
    await __t.real.click(del);
    await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].some((t) => /Deleted the MCP server "DeepWiki"/.test(t.textContent)), 3000);
    return 'ok';
  };
`;
const s = (name, body) => step(name, body, true, { extra: H + OPEN_RECENTLY_DELETED, short: 600 });

const steps = [
  s(
    'delete-for-good-starts-on-cancel',
    `const d = await deleteDeepWiki(); if (d !== 'ok') return d;
     const dlg = await openRecentlyDeleted(); if (typeof dlg === 'string') return dlg;
     const li = await __t.waitFor(() => rowOf('DeepWiki'), 3000); if (!li) return 'NOT LISTED: ' + dlg.innerText.slice(0, 200);
     const bin = li.querySelector('button[aria-label="Delete for good"]'); if (!bin) return 'NO BUTTON';
     await __t.real.click(bin);
     const c = await __t.waitFor(confirm, 3000); if (!c) return 'NO DIALOG';
     await __t.sleep(300);
     const buttons = [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' | ');
     return 'buttons: ' + buttons + ' | focused: ' + focusedText();`,
  ),
  s(
    'enter-keeps-the-item',
    `const c = confirm(); if (!c) return 'NO DIALOG';
     await __t.real.key('Enter'); await __t.sleep(600);
     return 'confirm open: ' + !!confirm() + ' | still listed: ' + !!rowOf('DeepWiki') + ' | in trash: ' + (await window.aps.invoke('trash.list')).some((t) => t.name === 'DeepWiki');`,
  ),
  s(
    'the-button-deletes-it',
    `const li = rowOf('DeepWiki'); if (!li) return 'NOT LISTED';
     await __t.real.click(li.querySelector('button[aria-label="Delete for good"]'));
     const c = await __t.waitFor(confirm, 3000); if (!c) return 'NO DIALOG';
     await __t.sleep(300);
     const ok = [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete for good'); if (!ok) return 'NO CONFIRM BUTTON';
     await __t.real.click(ok);
     await __t.waitFor(() => !confirm() && !rowOf('DeepWiki'), 4000);
     const gone = !(await window.aps.invoke('trash.list')).some((t) => t.name === 'DeepWiki');
     await __t.esc();
     return 'confirm open: ' + !!confirm() + ' | listed: ' + !!rowOf('DeepWiki') + ' | gone for good: ' + gone;`,
  ),
];

module.exports = withExpect(steps, {
  'delete-for-good-starts-on-cancel': /^buttons: Cancel \| Delete for good \| focused: Cancel$/,
  'enter-keeps-the-item': /^confirm open: false \| still listed: true \| in trash: true$/,
  'the-button-deletes-it': /^confirm open: false \| listed: false \| gone for good: true$/,
});
