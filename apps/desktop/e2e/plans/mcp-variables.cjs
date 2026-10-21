// An MCP server's environment variables: a value can be typed before its name; {{ suggestions say where variables come
// from (no collection here) and lead to copying a collection's variables into the environment.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.setSelectionRange(v.length, v.length); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const filter = async (v) => { const f = document.querySelector('aside input[placeholder^="Filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(800); };
  const envTable = () => [...document.querySelectorAll('main label, main div')].find((d) => d.offsetParent && d.textContent.trim().startsWith('Environment variables') && d.querySelector('table'))?.querySelector('table');
`;
const step = stepOf(H);

const steps = [
  step(
    'value-before-key',
    `await __t.requests(); await filter('Everything'); const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('Everything')); if (!r) return 'NO ROW'; r.click(); await __t.sleep(1500); await filter('');
     [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim() === 'Settings')?.click(); await __t.sleep(800);
     const t = envTable(); if (!t) return 'NO TABLE';
     const value = [...t.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === 'Value' || i.placeholder === 'Value'); if (!value) return 'NO INPUT value';
     value.focus(); setVal(value, 'abc'); await __t.sleep(400);
     const kept = [...envTable().querySelectorAll('input')].some((i) => i.value === 'abc');
     const key = [...envTable().querySelectorAll('input')].find((i) => i.getAttribute('aria-label')?.startsWith('Key') && !i.value); setVal(key, 'MY_TOKEN'); await __t.sleep(400);
     return 'value kept before a key: ' + kept + ' | rows: ' + [...envTable().querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('input:not([type=checkbox])')].map((i) => i.value).join('=')).filter((x) => x !== '=').join(', ');`,
  ),
  step(
    'suggestions-say-where-from',
    `const t = envTable(); const value = [...t.querySelectorAll('input')].find((i) => i.value === 'abc'); value.focus(); setVal(value, '{{'); await __t.sleep(500);
     const note = document.querySelector('[data-suggest-note]'); const items = [...document.querySelectorAll('[role=listbox] [role=option]')].length;
     const r = 'options: ' + (items > 0) + ' | note: ' + (note?.textContent.replace(/\\s+/g, ' ').trim() ?? 'none');
     setVal(value, 'abc'); return r;`,
  ),
  step(
    'copy-collection-variables',
    `await __t.view('Environments'); await __t.sleep(900);
     [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Collection variables'))?.click(); await __t.sleep(800);
     [...document.querySelectorAll('main [aria-label="Collections"] button')].find((b) => b.textContent.includes('JSONPlaceholder'))?.click(); await __t.sleep(600);
     [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Copy to environment')?.click();
     const dlg = await __t.waitFor(() => document.querySelector('[role=alertdialog], [role=dialog]'), 2000); if (!dlg) return 'NO DIALOG';
     const msg = dlg.textContent.replace(/\\s+/g, ' ').slice(0, 120);
     [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Copy')?.click(); await __t.sleep(1200);
     const env = (await window.aps.invoke('env.list')).find((e) => e.name === 'Public APIs');
     return msg + ' | environment now has userId: ' + env.variables.some((v) => v.key === 'userId');`,
  ),
];

module.exports = withExpect(steps, {
  'value-before-key': /^value kept before a key: true \| rows: MY_TOKEN=abc$/,
  'suggestions-say-where-from': /^options: true \| note: From the active environment, the workspace and the globals\. Collection variables only apply to that collection's requests: copy them to an environment to use them here\.$/,
  'copy-collection-variables': /Copy 1 variable of "Scripts & chaining \(JSONPlaceholder\)" to the environment "Public APIs"\?.* \| environment now has userId: true$/,
});
