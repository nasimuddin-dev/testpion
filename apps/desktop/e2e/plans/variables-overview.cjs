// Seeing variables: the popover of a collection variable leads to the collection's variables (not the environments),
// and the quick look (eye) lists every variable the request on screen can use: collection, environment, workspace,
// globals, with a filter.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const pop = () => document.querySelector('[role=dialog][aria-label^="Variable "]');
  const filterTree = async (v) => { const f = document.querySelector('aside input[placeholder^="Filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(800); };
  const openRow = async (name) => { await filterTree(name); const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name) && b.getAttribute('aria-expanded') === null); r?.click(); await __t.sleep(1500); await filterTree(''); return !!r; };
  const clickVar = (input, name) => { const i = input.value.indexOf('{{' + name); input.focus(); input.setSelectionRange(i + 3, i + 3); input.click(); };
  const quick = () => document.querySelector('[aria-label="Variables quick look"][role=dialog], [role=dialog][aria-label="Variables quick look"]') ?? [...document.querySelectorAll('[data-radix-popper-content-wrapper] [aria-label="Variables quick look"]')][0];
  const sections = () => [...(quick()?.querySelectorAll('section') ?? [])].map((s) => s.querySelector('h3')?.textContent.trim() + ' ' + (s.querySelector('h3 + span, h3 ~ span')?.textContent.trim() ?? '') + ' [' + [...s.querySelectorAll('tbody tr')].map((r) => r.dataset.variable).join(',') + ']').join(' / ');
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'collection-variable-popover',
    `await __t.requests(); if (!(await openRow('List posts of a user'))) return 'NO ROW';
     const cell = [...document.querySelectorAll('main input')].find((x) => x.offsetParent && x.value.includes('{{userId}}')); if (!cell) return 'NO INPUT';
     clickVar(cell, 'userId'); const p = await __t.waitFor(pop, 2500); if (!p) return 'NO DIALOG';
     return 'scope: ' + p.querySelector('.text-\\\\[0\\\\.7rem\\\\]')?.textContent.trim() + ' | buttons: ' + [...p.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' / ');`,
  ),
  step(
    'go-to-collection-variables',
    `const b = [...pop().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Collection variables'); if (!b) return 'NO BUTTON'; b.click(); await __t.sleep(1500);
     const tab = [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.getAttribute('aria-selected') === 'true')?.textContent.trim();
     const keys = [...document.querySelectorAll('main input')].filter((i) => i.offsetParent).map((i) => i.value).filter((v) => v === 'userId');
     return 'popover open: ' + !!pop() + ' | tab: ' + tab + ' | userId row: ' + (keys.length > 0);`,
  ),
  step(
    'quick-look-all-scopes',
    `await __t.requests(); await openRow('List posts of a user');
     document.querySelector('button[aria-label="Variables quick look"]').click(); await __t.sleep(1200);
     if (!quick()) return 'NO DIALOG';
     return sections();`,
  ),
  step(
    'quick-look-filter',
    `const f = quick().querySelector('input[aria-label="Filter variables"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'userid'); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(400);
     const s = sections(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300); return s;`,
  ),
  step(
    'popover-all-button',
    `await __t.sleep(300); const cell = [...document.querySelectorAll('main input')].find((x) => x.offsetParent && x.value.includes('{{userId}}')); if (!cell) return 'NO INPUT';
     clickVar(cell, 'userId'); const p = await __t.waitFor(pop, 2500); if (!p) return 'NO DIALOG';
     [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === "Where it's set").click(); await __t.sleep(1200);
     const ok = !!quick(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300);
     return 'quick look open: ' + ok + ' | popover closed: ' + !pop();`,
  ),
];

module.exports = withExpect(steps, {
  'collection-variable-popover': /^scope: collection \| buttons: .*Copy \/ Collection variables \/ Where it's set$/,
  'go-to-collection-variables': /^popover open: false \| tab: Variables.* \| userId row: true$/,
  // in the order they win, each with its variables
  'quick-look-all-scopes': /^Collection: Scripts & chaining \(JSONPlaceholder\) 1 \[userId\] \/ Environment: Public APIs \d+ \[.*httpbin.*\] \/ Workspace 1 \[appName\] \/ Globals 0 \[\]$/,
  'quick-look-filter': /^Collection: Scripts & chaining \(JSONPlaceholder\) 1 \[userId\] \/ Environment: Public APIs \d+ \[\] \/ Workspace 1 \[\] \/ Globals 0 \[\]$/,
  'popover-all-button': /^quick look open: true \| popover closed: true$/,
});
