// WF-12 One capture surface: three exchanges go through the HTTP Debugger, two are selected, "Save 2 selected to
// collection…" saves them as requests of a new collection (a folder per host), and the collection is in the explorer;
// the Capture menu has the reverse proxy for one API.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';
const H = `
  const send = (path) => window.aps.invoke('debug.selfTest', { url: '${API}' + path });
  const rowOf = (text) => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes(text));
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;

const steps = [
  step(
    'capture-three',
    `${H}
     await __t.view('Debugger');
     await window.aps.invoke('debug.start', {});
     await window.aps.invoke('debug.clear');
     await __t.sleep(300);
     for (const q of ['cap=1', 'cap=2', 'cap=3']) await send('/health?' + q);
     const shown = await __t.waitFor(() => rowOf('cap=1') && rowOf('cap=2') && rowOf('cap=3'), 6000);
     return 'rows: ' + !!shown;`,
  ),
  step(
    'select-two-and-save',
    `${H}
     rowOf('cap=1').dispatchEvent(new MouseEvent('click', { bubbles: true })); await __t.sleep(200);
     rowOf('cap=2').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await __t.sleep(250);
     const r = rowOf('cap=2').getBoundingClientRect();
     rowOf('cap=2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 5 }));
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Save 2 selected to collection/.test(m.textContent.trim())), 3000);
     if (!item) return 'NO MENU ITEM';
     item.click();
     const d = await __t.waitFor(() => document.querySelector('[data-save-to-collection-dialog]'), 3000); if (!d) return 'NO DIALOG';
     setInput(d.querySelector('input[aria-label="Collection name"]'), 'E2E captured');
     await __t.sleep(200);
     document.querySelector('[data-save-to-collection]').click();
     const col = await __t.waitFor(async () => (await window.aps.invoke('col.list')).find((c) => c.name === 'E2E captured'), 6000);
     const saved = (await window.aps.invoke('col.list')).find((c) => c.name === 'E2E captured');
     return 'saved: ' + !!saved + ' | folders: ' + (saved?.items ?? []).map((f) => f.name + '(' + (f.items ?? []).length + ')').join(',');`,
  ),
  step(
    'in-the-explorer',
    `await __t.requests();
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.querySelector('.truncate')?.textContent.trim() === 'E2E captured'), 5000);
     return 'in the explorer: ' + !!row;`,
  ),
  step(
    'capture-menu-has-reverse-proxy',
    `await __t.view('Debugger');
     const b = [...document.querySelectorAll('main button')].find((x) => /^Capture/.test(x.textContent.trim()));
     if (!b) return 'NO CAPTURE BUTTON';
     b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click();
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /Reverse proxy for one API/.test(m.textContent)), 3000);
     await __t.esc();
     return 'reverse proxy: ' + !!item;`,
  ),
];

module.exports = withExpect(steps, {
  'capture-three': /^rows: true$/,
  'select-two-and-save': /^saved: true \| folders: 127\.0\.0\.1:4010\(2\)$/,
  'in-the-explorer': /^in the explorer: true$/,
  'capture-menu-has-reverse-proxy': /^reverse proxy: true$/,
});
