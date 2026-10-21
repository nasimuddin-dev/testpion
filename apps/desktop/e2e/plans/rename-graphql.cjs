// Rename a GraphQL request in place (menu, F2, tab): never the old dialog.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.offsetParent);
  const row = (txt) => vis('aside button[data-tree-row]').find((b) => b.textContent.includes(txt));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const dialog = () => !!document.querySelector('[role=dialog]');
  const editing = () => document.activeElement?.tagName === 'INPUT' && /name/i.test(document.activeElement.getAttribute('aria-label') ?? '') ? document.activeElement : null;
`;
const step = stepOf(H);
const steps = [
  step('setup', `await __t.requests(); await __t.sleep(600); for (const t of ['GraphQL (public', 'GraphQL12', 'Countries3']) { await __t.expand(t); await __t.sleep(250); } return vis('aside button[data-tree-row]').filter((b) => /Country/.test(b.textContent)).map((b) => b.textContent.trim()).join(' / ');`),
  step('menu-rename', `row('Country by code').parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 })); await __t.sleep(600); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Rename').click(); await __t.sleep(700); const i = editing(); const r = 'dialog: ' + dialog() + ' | inline: ' + !!i; if (!i) return r; setVal(i, 'Country by code X'); key(i, 'Enter'); await __t.sleep(900); return r + ' | ' + (row('Country by code X')?.textContent.trim() ?? 'NOT RENAMED');`),
  step('f2-back', `const r = row('Country by code X'); r.focus(); key(r, 'F2'); await __t.sleep(500); const i = editing(); const out = 'dialog: ' + dialog() + ' | inline: ' + !!i; if (!i) return out; setVal(i, 'Country by code'); key(i, 'Enter'); await __t.sleep(900); return out + ' | ' + (row('Country by code')?.textContent.trim() ?? 'NOT RENAMED');`),
  step('tab-rename', `row('Country by code').click(); await __t.sleep(1500); const t = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].find((x) => x.textContent.includes('Country by code')); t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(600); const i = document.activeElement?.getAttribute('aria-label') === 'Tab name' ? document.activeElement : null; const out = 'dialog: ' + dialog() + ' | inline: ' + !!i; if (!i) return out; key(i, 'Escape'); await __t.sleep(400); return out + ' | Esc: still ' + t.textContent.trim();`),
];

module.exports = withExpect(steps, {
  'menu-rename': /dialog: false \| inline: true \| GQLCountry by code X/,
  'f2-back': /dialog: false \| inline: true \| GQLCountry by code$/,
  'tab-rename': /dialog: false \| inline: true/,
});
