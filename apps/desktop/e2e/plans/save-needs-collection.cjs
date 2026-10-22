// A saved request always belongs to a collection: the sidebar has no "Not in a collection"; a new WebSocket tab's
// Save opens the same collection dialog as a REST request, and saving puts the connection under that collection.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const dialog = () => document.querySelector('[role=dialog]');
  const aside = () => document.querySelector('aside[aria-label="Collections explorer"]');
`;
const step = stepOf(H);

const steps = [
  step('no-loose-section', `await __t.requests(); await __t.sleep(400); return 'not in a collection: ' + (aside()?.innerText ?? '').includes('Not in a collection');`),
  step(
    'save-opens-collection-dialog',
    `// a request opens first, so the tab strip (and its New tab button) is there on a fresh start
     if (!document.querySelector('[aria-label="New tab"]')) { await __t.find('Custom headers'); await __t.waitFor(() => document.querySelector('[aria-label="New tab"]'), 5000); }
     const r = await __t.newTab('WebSocket'); if (r !== 'ok') return r;
     const url = vis('main input[aria-label="WebSocket URL"]')[0];
     if (!url) return 'NO URL FIELD';
     setValue(url, 'ws://127.0.0.1:4010/e2e-save'); await __t.sleep(200);
     const save = vis('main button').find((b) => b.textContent.trim() === 'Save (Ctrl+S)');
     if (!save) return 'NO SAVE';
     save.click();
     const d = await __t.waitFor(() => dialog(), 3000);
     if (!d) return 'NO DIALOG';
     const title = d.querySelector('h2')?.textContent ?? '';
     const sel = d.querySelector('select');
     await __t.sleep(300);
     // the dialog opens with the focus in its first field (never on Close)
     const focused = document.activeElement === d.querySelector('input') ? 'name field' : (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
     return title + ' | collections: ' + (sel ? [...sel.options].some((o) => o.textContent === 'WebSocket & MQTT') : 'none') + ' | new: ' + !![...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New') + ' | focus: ' + focused;`,
  ),
  step(
    'save-into-collection',
    `const d = dialog(); if (!d) return 'NO DIALOG';
     const name = d.querySelector('input');
     setValue(name, 'E2E saved echo'); await __t.sleep(100);
     const sel = d.querySelector('select'); const opt = [...sel.options].find((o) => o.textContent === 'WebSocket & MQTT');
     setValue(sel, opt.value); await __t.sleep(200);
     // Enter in the name field is Save (the dialog's main button), like in every dialog
     name.focus(); name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
     if (!(await __t.waitFor(() => !dialog(), 3000))) return 'ENTER DID NOT SAVE';
     await __t.sleep(800);
     const crumb = vis('main nav[aria-label="Where this request is saved"]').map((n) => n.textContent.trim()).join(' | ');
     await __t.requests(); await __t.expand('WebSocket & MQTT'); await __t.sleep(300);
     const rows = [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])].map((b) => b.textContent.trim());
     for (const t of rows.filter((t) => /^WebSocket & MQTT\\d+$/.test(t))) { await __t.expand(t); await __t.sleep(300); }
     const after = [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])].map((b) => b.textContent.trim());
     return 'breadcrumb: ' + crumb + ' | in tree: ' + after.some((t) => t.endsWith('E2E saved echo'));`,
  ),
  step(
    'move-dialog-focuses-first-field',
    `// a dialog with no autoFocus of its own (an HTTP request's Move to…) opens with the focus in its first field, a Select here
     await __t.requests(); await __t.expand('HTTP basics'); await __t.expand('Requests & responses'); await __t.sleep(400);
     const row = [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])].find((b) => b.textContent.trim().endsWith('Custom headers'));
     if (!row) return 'NO ROW';
     row.scrollIntoView({ block: 'center' }); await __t.real.rightClick(row);
     if (!(await __t.waitFor(() => document.querySelector('[role=menu]'), 2000))) return 'NO MENU';
     const item = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Move to…');
     if (!item) return 'NO MOVE ITEM: ' + [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()).join(' | ');
     await __t.real.click(item);
     const d = await __t.waitFor(() => dialog(), 3000); if (!d) return 'NO DIALOG';
     await __t.sleep(300);
     const el = document.activeElement;
     const out = 'focus: ' + el?.tagName + (el?.getAttribute('aria-label') === 'Close' ? ' (Close)' : '') + ' | help: ' + !!document.querySelector('header [data-help]');
     d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
     await __t.waitFor(() => !dialog(), 3000);
     return out;`,
  ),
];

module.exports = withExpect(steps, {
  'no-loose-section': /^not in a collection: false$/,
  'save-opens-collection-dialog': /^Save connection \| collections: true \| new: true \| focus: name field$/,
  'save-into-collection': /^breadcrumb: WebSocket & MQTT.*E2E saved echo \| in tree: true$/,
  'move-dialog-focuses-first-field': /^focus: SELECT \| help: true$/,
});
