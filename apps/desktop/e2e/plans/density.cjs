// Compact density (Settings ▸ Appearance): the design tokens shrink spacing, fields, small text and list rows
// everywhere; no control's text overflows in either density, in light and dark; the choice is kept for this computer
// and applied before the first paint (localStorage).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const VIEWS = ['Home', 'Collections', 'Tests', 'Environments', 'History', 'Settings'];
  // controls whose text is taller than the control (cut off): buttons, tabs, fields, labels of the views on screen
  const clipped = () => vis('button, [role=tab], .field, label, nav a').filter((e) => {
    const cs = getComputedStyle(e);
    return e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && !/auto|scroll/.test(cs.overflowY);
  }).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30));
  const tour = async () => { const out = []; for (const v of VIEWS) { await __t.view(v); await __t.sleep(300); const c = clipped(); out.push(v + ':' + c.length + (c.length ? '(' + c.slice(0, 3).join('/') + ')' : '')); } return out.join(' '); };
  // a standard form field (the toolbar and search fields are small by design: field-sm, h-7)
  const fieldH = () => Math.round(vis('.field').find((e) => !/field-sm|(^|\\s)h-\\d/.test(e.className))?.getBoundingClientRect().height ?? 0);
  const pickSettings = async (labelText) => {
    await __t.view('Settings'); await __t.tab('Appearance');
    vis('main button').find((b) => b.textContent.trim() === labelText)?.click(); await __t.sleep(200);
    vis('main button').find((b) => b.textContent.trim() === 'Save settings')?.click(); await __t.sleep(900);
  };
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s('comfortable', `const r = await tour(); return 'density: ' + document.documentElement.dataset.density + ' | field ' + fieldH() + ' | ' + r;`),
  s(
    'switch-to-compact',
    `await pickSettings('Compact');
     return 'density: ' + document.documentElement.dataset.density + ' | stored: ' + localStorage.getItem('aps.density') + ' | saved: ' + (await window.aps.invoke('settings.get')).density + ' | field ' + fieldH();`,
  ),
  s('compact-dark', `const r = await tour(); return r;`),
  s(
    'compact-light',
    `await __t.view('Settings'); await __t.tab('Appearance');
     const sel = vis('main select')[0]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'light'); sel.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(200);
     vis('main button').find((b) => b.textContent.trim() === 'Save settings')?.click(); await __t.sleep(900);
     const r = await tour(); return 'theme: ' + document.documentElement.dataset.theme + ' | ' + r;`,
  ),
  s(
    'compact-rows',
    `await __t.requests(); await __t.find('Custom headers'); await __t.sleep(500);
     const row = vis('aside[aria-label="Collections explorer"] [data-tree-row]')[0];
     const h = Math.round(row?.parentElement?.getBoundingClientRect().height ?? row?.getBoundingClientRect().height ?? 0);
     return 'tree row: ' + h + ' | tab strip: ' + Math.round(vis('main [role=tablist]')[0]?.getBoundingClientRect().height ?? 0);`,
  ),
  s('back-to-comfortable', `await pickSettings('Comfortable'); return 'density: ' + document.documentElement.dataset.density + ' | field ' + fieldH();`),
];

module.exports = withExpect(steps, {
  comfortable: /^density: comfortable \| field 32 \| Home:0 Collections:0 Tests:0 Environments:0 History:0 Settings:0$/,
  'switch-to-compact': /^density: compact \| stored: compact \| saved: compact \| field 28$/,
  'compact-dark': /^Home:0 Collections:0 Tests:0 Environments:0 History:0 Settings:0$/,
  'compact-light': /^theme: light \| Home:0 Collections:0 Tests:0 Environments:0 History:0 Settings:0$/,
  'compact-rows': /^tree row: 2[0-9] \| tab strip: \d+$/,
  'back-to-comfortable': /^density: comfortable \| field 32$/,
});
