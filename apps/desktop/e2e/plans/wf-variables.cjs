// WF-14 Variables: where a variable comes from shows on hover in any text field, and a variable added to one
// environment is offered to the others ("Also add to"): in the variable popover, and after saving new variables in
// the Environments view.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

/** A second environment, so there is another one to add to. */
function prepare(ws) {
  writeFileSync(
    join(ws, 'environments', 'e2e-other.json'),
    JSON.stringify({ id: 'e2e-other', name: 'E2E other', variables: [{ key: 'httpbin', value: 'http://127.0.0.1:4010', enabled: true }] }, null, 2),
  );
}

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const envVars = async (name) => (await window.aps.invoke('env.list')).find((e) => e.name === name)?.variables.map((v) => v.key + '=' + (v.value ?? '')) ?? [];
  const toast = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });

const steps = [
  s(
    'popover-also-add',
    `await __t.newTab('HTTP request');
     const url = vis('main input[aria-label="Request URL"]')[0]; if (!url) return 'NO INPUT url';
     setVal(url, '{{wfAlso}}/x'); await __t.sleep(600);
     url.focus(); url.setSelectionRange(4, 4); url.dispatchEvent(new MouseEvent('click', { bubbles: true })); await __t.sleep(800);
     const pop = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Variable wfAlso"]'), 3000);
     if (!pop) return 'NO POPOVER';
     const chips = [...pop.querySelectorAll('[data-also-add] label')].map((l) => l.textContent.trim());
     // the other environment (whichever one is active, the other is offered)
     const chip = pop.querySelector('[data-also-add] label'); const other = chip?.textContent.trim();
     chip?.click(); await __t.sleep(200);
     setVal(pop.querySelector('input.field'), 'v1'); await __t.sleep(200);
     [...pop.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add')?.click();
     const t = await __t.waitFor(() => toast(/wfAlso/), 5000);
     return 'chips: ' + chips.length + ' | toast names the other: ' + (t ?? '').includes('and ' + other) + ' | other: ' + (await envVars(other)).filter((x) => x.startsWith('wfAlso')).join(',');`,
  ),
  s(
    'hover-shows-source',
    `const el = document.createElement('input');
     el.value = 'see {{httpbin}} and {{nopeVar}}'; el.title = 'Own tip';
     document.querySelector('main').appendChild(el);
     el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
     const title = await __t.waitFor(() => (el.title !== 'Own tip' ? el.title : undefined), 4000);
     el.remove();
     return short(title, 300);`,
  ),
  s(
    'environments-view-offers',
    `await __t.view('Environments'); await __t.sleep(800);
     const env = await __t.waitFor(() => vis('main *').find((x) => x.children.length === 0 && x.textContent.trim() === 'E2E other'), 3000);
     if (!env) return 'NO ENV ROW';
     (env.closest('[draggable]') ?? env).click(); await __t.sleep(800);
     const key = vis('main input[aria-label="New variable"]')[0]; if (!key) return 'NO NEW ROW';
     setVal(key, 'wfFromView'); await __t.sleep(300);
     vis('main button').find((b) => b.textContent.trim() === 'Save' && !b.disabled)?.click();
     const d = await __t.waitFor(() => vis('[role=dialog]').find((x) => /New in E2E other/.test(x.textContent)), 4000);
     if (!d) return 'NO DIALOG';
     const chips = [...d.querySelectorAll('[data-also-add] label')].map((l) => l.textContent.trim());
     [...d.querySelectorAll('[data-also-add] label')][0]?.click(); await __t.sleep(200);
     [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add')?.click();
     const t = await __t.waitFor(() => toast(/Added to 1 environment/), 5000);
     return 'title: ' + short(d.querySelector('h2, [role=heading]')?.textContent ?? d.textContent, 40) + ' | chips: ' + chips.join(' | ') + ' | toast: ' + short(t, 60);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'popover-also-add': /^chips: 1 \| toast names the other: true \| other: wfAlso=$/,
    'hover-shows-source': /^Own tip httpbin = .+ \(environment\) nopeVar: not defined in the current environment \(double-click a variable to see or edit it\)$/,
    'environments-view-offers': /^title: New in E2E other: wfFromView.* \| chips: .+ \| toast: Added to 1 environment: .+/,
  },
  { prepare },
);
