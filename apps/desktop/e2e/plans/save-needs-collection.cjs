// A saved request always belongs to a collection: the sidebar has no "Not in a collection"; a new WebSocket tab's
// Save opens the same collection dialog as a REST request, and saving puts the connection under that collection.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const dialog = () => document.querySelector('[role=dialog]');
  const aside = () => document.querySelector('aside[aria-label="Collections explorer"]');
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

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
     return title + ' | collections: ' + (sel ? [...sel.options].some((o) => o.textContent === 'WebSocket & MQTT') : 'none') + ' | new: ' + !![...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New');`,
  ),
  step(
    'save-into-collection',
    `const d = dialog(); if (!d) return 'NO DIALOG';
     setValue(d.querySelector('input'), 'E2E saved echo'); await __t.sleep(100);
     const sel = d.querySelector('select'); const opt = [...sel.options].find((o) => o.textContent === 'WebSocket & MQTT');
     setValue(sel, opt.value); await __t.sleep(200);
     [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save')?.click();
     await __t.waitFor(() => !dialog(), 3000); await __t.sleep(800);
     const crumb = vis('main nav[aria-label="Where this request is saved"]').map((n) => n.textContent.trim()).join(' | ');
     await __t.requests(); await __t.expand('WebSocket & MQTT'); await __t.sleep(300);
     const rows = [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])].map((b) => b.textContent.trim());
     for (const t of rows.filter((t) => /^WebSocket & MQTT\\d+$/.test(t))) { await __t.expand(t); await __t.sleep(300); }
     const after = [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])].map((b) => b.textContent.trim());
     return 'breadcrumb: ' + crumb + ' | in tree: ' + after.some((t) => t.endsWith('E2E saved echo'));`,
  ),
];

module.exports = withExpect(steps, {
  'no-loose-section': /^not in a collection: false$/,
  'save-opens-collection-dialog': /^Save connection \| collections: true \| new: true$/,
  'save-into-collection': /^breadcrumb: WebSocket & MQTT.*E2E saved echo \| in tree: true$/,
});
