// Environments ▸ every variable scope: Collection variables (every collection's, editable here), Workspace and Global
// variables, each explaining itself, and an empty one pointing to where imported variables are.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  // the scope tabs (not the open environments' tab strip below them)
  const tabs = () => [...document.querySelectorAll('main [role=tab]')].filter((t) => t.offsetParent && !t.closest('[aria-label="Open environments"]'));
  const tab = async (label) => { const t = tabs().find((x) => x.textContent.trim().startsWith(label)); if (!t) return false; t.click(); await __t.sleep(800); return true; };
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const step = stepOf(H);

const steps = [
  step('tabs', `await __t.view('Environments'); await __t.sleep(1000); return tabs().map((t) => t.textContent.trim()).join(' / ');`),
  step(
    'collection-variables',
    `if (!(await tab('Collection variables'))) return 'NO TAB';
     const list = [...document.querySelectorAll('main [aria-label="Collections"] button')].map((b) => b.textContent.trim());
     const chaining = [...document.querySelectorAll('main [aria-label="Collections"] button')].find((b) => b.textContent.includes('JSONPlaceholder'));
     chaining.click(); await __t.sleep(600);
     const keys = [...document.querySelectorAll('main input')].filter((i) => i.offsetParent).map((i) => i.value).filter((v) => v === 'userId');
     return 'collections with counts: ' + list.filter((t) => /\\d$/.test(t)).length + ' | heading: ' + [...document.querySelectorAll('main h2')].find((h) => h.offsetParent)?.textContent.trim() + ' | userId row: ' + (keys.length === 1);`,
  ),
  step(
    'edit-and-save',
    `const key = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && i.value === 'userId');
     const row = key.closest('tr') ?? key.parentElement.parentElement;
     const value = [...row.querySelectorAll('input')].find((i) => i !== key && i.type !== 'checkbox');
     setVal(value, '7'); await __t.sleep(300);
     [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Save' && !b.disabled)?.click(); await __t.sleep(1200);
     const c = (await window.aps.invoke('col.list')).find((x) => x.id === 'jsonplaceholder');
     return 'saved userId: ' + c.variables.find((v) => v.key === 'userId')?.value;`,
  ),
  step('workspace-hint', `await tab('Workspace variables'); const h = document.querySelector('[data-scope-hint]'); return h ? h.textContent.trim().slice(0, 60) + ' | empty: ' + /None yet/.test(h.textContent) : 'NO HINT';`),
  step(
    'empty-globals-point-to-collections',
    `const clicked = await tab('Global variables'); const h = [...document.querySelectorAll('[data-scope-hint]')].find((x) => x.offsetParent);
     if (!h) return 'NO HINT | clicked: ' + clicked + ' | active: ' + tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent.trim() + ' | hints: ' + document.querySelectorAll('[data-scope-hint]').length;
     const link = [...h.querySelectorAll('button')].find((b) => /collection variables/.test(b.textContent));
     const text = h.textContent.replace(/\\s+/g, ' ').trim();
     link?.click(); await __t.sleep(800);
     return text.slice(-90) + ' | now on: ' + tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent.trim();`,
  ),
];

module.exports = withExpect(steps, {
  tabs: /^Environments\d+ \/ Collection variables\d+ \/ Workspace variables\d+ \/ Global variables$/,
  'collection-variables': /^collections with counts: \d+ \| heading: Scripts & chaining \(JSONPlaceholder\) \| userId row: true$/,
  'edit-and-save': /^saved userId: 7$/,
  'workspace-hint': /^Workspace variables are shared by every collection .* \| empty: false$/,
  'empty-globals-point-to-collections': /collections keep their variables in the collection: see the \d+ collection variables\. \| now on: Collection variables\d+$/,
});
