// Rename environments in place: the active one stays active; a name in use is refused.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder } = require('../lib.cjs');
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.offsetParent);
  const row = (txt) => visible('main [data-tree-row]').find((b) => b.querySelector('.truncate')?.textContent.trim() === txt);
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const input = () => (document.activeElement?.tagName === 'INPUT' && document.activeElement.getAttribute('aria-label') === 'Environment name' ? document.activeElement : null);
  const names = () => visible('main [data-tree-row]').map((b) => b.textContent.trim()).join(' / ');
  const active = () => { const e = document.querySelector('header button[aria-label="Environment"]'); if (!e) return 'NO PICKER'; const t = e.textContent.trim(); return t === 'No environment' ? '(none)' : t; };
  const f2 = async (txt) => { const r = row(txt); if (!r) return null; r.focus(); key(r, 'F2'); await __t.sleep(400); return input(); };
  const menu = async (txt, label) => { row(txt).parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); await __t.sleep(600); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === label)?.click(); await __t.sleep(900); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];
const steps = [
  step('envs', `await __t.view('Environments'); await __t.sleep(800); return names() + ' | active: ' + active();`),
  step('f2-active', `const i = await f2('Public APIs'); if (!i) return 'NO INPUT'; setVal(i, 'Public APIs 2'); key(i, 'Enter'); await __t.sleep(1200); return names() + ' | active: ' + active() + ' | name field: ' + visible('main input')[0]?.value;`),
  step('duplicate-refused', `await menu('Public APIs 2', 'Duplicate'); const i = await f2('Public APIs 2 copy'); if (!i) return 'NO INPUT: ' + names(); setVal(i, 'public apis 2'); key(i, 'Enter'); await __t.sleep(400); const alert = document.querySelector('main [role=alert]')?.textContent; key(input(), 'Escape'); await __t.sleep(500); return 'alert: ' + alert + ' | ' + names();`),
  step('menu-rename-back', `await menu('Public APIs 2', 'Rename'); const i = input(); if (!i) return 'NO INPUT'; setVal(i, 'Public APIs'); key(i, 'Enter'); await __t.sleep(1200); return names() + ' | active: ' + active();`),
  step('cleanup', `await menu('Public APIs 2 copy', 'Delete'); const ok = [...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find((b) => b.textContent.trim() === 'Delete environment'); ok?.click(); await __t.sleep(1200); return names() + ' | active: ' + active();`),
];

module.exports = withExpect(steps, {
  'f2-active': /active: Public APIs 2/,
  'duplicate-refused': /alert: Another environment has this name/,
  'menu-rename-back': /active: Public APIs$/,
  cleanup: /^Public APIs34 \| active: Public APIs$/,
});
