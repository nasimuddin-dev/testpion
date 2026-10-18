// WF-13 One vocabulary and one menu order: History and Traces rows have the same right-click menu as their ⋯, a
// request's menu says Open / Open in new tab and Delete…, Ctrl+Alt+n follows the rail's shown views (3 = Tests) and the shortcuts
// list says so in the rail's order.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const items = () => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.textContent.trim());
  const rightClick = async (el) => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); return !!(await __t.waitFor(() => document.querySelector('[role=menu]'), 2000)); };
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });

const steps = [
  s(
    'history-row',
    `await window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:4010/health?menus=1', headers: [] }, name: 'E2E menus' }).catch(() => undefined);
     await __t.view('History'); await __t.sleep(800);
     const row = await __t.waitFor(() => vis('main button').find((b) => /menus=1/.test(b.textContent)), 5000); if (!row) return 'NO ROW';
     if (!(await rightClick(row.parentElement))) return 'NO MENU';
     const r = items().join(' | '); await __t.esc(); return r;`,
  ),
  s(
    'traces-row',
    `await __t.view('Traces'); await __t.sleep(1000);
     const row = await __t.waitFor(() => vis('main button').find((b) => /menus=1|E2E menus|health/.test(b.textContent)), 5000); if (!row) return 'NO ROW';
     if (!(await rightClick(row.parentElement))) return 'NO MENU';
     const r = items().join(' | '); await __t.esc(); return r;`,
  ),
  s(
    'rail-shortcut',
    `await __t.esc();
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, altKey: true, bubbles: true })); await __t.sleep(1000);
     return 'view: ' + localStorage.getItem('aps.view');`,
  ),
  s(
    'shortcuts-list',
    `document.body.focus();
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
     const d = await __t.waitFor(() => vis('[role=dialog]').find((x) => /Keyboard shortcuts/.test(x.textContent)), 3000); if (!d) return 'NO DIALOG';
     const line = [...d.querySelectorAll('dd, div')].map((x) => x.textContent).find((t) => /rail's order/.test(t) && t.length < 300) ?? '';
     const terminal = /New terminal/.test(d.textContent);
     await __t.esc();
     return short(line.replace(/^.*?Go to/, 'Go to'), 200) + ' | terminal listed: ' + terminal;`,
  ),
];

module.exports = withExpect(steps, {
  // one menu function (lib/node-menu.ts): open · share (Copy link) · tools · danger
  'history-row': /^Open \| Open trace \| Copy link \| Save as test… \| Delete…$/,
  'traces-row': /^Open( \| Open run)? \| Copy link$/,
  'rail-shortcut': /^view: tests$/,
  'shortcuts-list': /^Go to a view in the rail's order: 1 Home, 2 Collections, 3 Tests, 4 Environments, 5 History \| terminal listed: true$/,
});
