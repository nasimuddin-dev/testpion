// The Debugger's Filter panel: "Remove all" is a labelled button (not a bin icon next to Reset hits); it takes the whole list in one
// click, the message counts the rules and has Undo, and Undo puts them back in order. It is off while the search box has text,
// and says why.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const list = () => document.querySelector('main [data-rule-list]');
  const ruleRows = () => [...(list()?.querySelectorAll('[data-rule]') ?? [])];
  const removeAll = () => document.querySelector('main [data-clear-rules]');
  const mine = async () => (await window.aps.invoke('debug.rules')).rules.filter((r) => /^e2e clear /.test(r.name));
`;
const step = stepOf(H);

const steps = [
  step(
    'three-filter-rules-in-the-panel',
    `await __t.view('Debugger'); await __t.sleep(600);
     for (const r of (await mine())) await window.aps.invoke('debug.deleteRule', { id: r.id });
     for (const n of ['one', 'two', 'three']) await window.aps.invoke('debug.saveRule', { rule: { kind: 'ignore', name: 'e2e clear ' + n, enabled: true, match: { host: n + '.example.test' } } });
     const rail = document.querySelector('[data-tool-rail] button[aria-label="Filter"]'); if (!rail) return 'NO RAIL';
     if (!list()) { await __t.real.click(rail); await __t.sleep(600); }
     await __t.waitFor(() => (ruleRows().length >= 3 ? true : null), 4000);
     return 'rules listed: ' + ruleRows().filter((r) => /e2e clear/.test(r.textContent)).length + ' | store: ' + (await mine()).length;`,
  ),
  step(
    'remove-all-is-a-labelled-button',
    `const b = removeAll(); if (!b) return 'NO BUTTON';
     const text = b.textContent.trim(); const icon = !!b.querySelector('svg');
     const neighbours = [...b.parentElement.children].map((c) => c.getAttribute('aria-label') || c.textContent.trim()).join(' | ');
     return 'label: ' + text + ' | icon: ' + icon + ' | disabled: ' + b.disabled + ' | beside: ' + neighbours;`,
  ),
  step(
    'disabled-with-a-reason-while-searching',
    `const box = document.querySelector('main [data-rule-list] input[aria-label="Filter rules"]'); if (!box) return 'NO SEARCH';
     const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
     setter.call(box, 'two'); box.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(400);
     const b = removeAll();
     const out = 'disabled while searching: ' + b.disabled + ' | reason: ' + /Clear the search box first/.test(b.title + ' ' + (b.closest('[data-disabled-reason]')?.getAttribute('aria-label') ?? ''));
     setter.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     return out;`,
  ),
  step(
    'remove-all-then-undo',
    `const before = (await window.aps.invoke('debug.rules')).rules.map((r) => r.id);
     const total = before.length;
     await __t.real.click(removeAll()); await __t.sleep(800);
     const after = (await window.aps.invoke('debug.rules')).rules.filter((r) => r.kind === 'ignore' || r.kind === 'only').length;
     const toast = [...document.querySelectorAll('[data-sonner-toast], [role=status], [role=alert]')].map((t) => t.textContent).find((t) => /Undo/.test(t)) ?? '';
     const counted = new RegExp('all ' + total + ' rules').test(toast) || /rules of this list/.test(toast);
     const undo = [...document.querySelectorAll('[data-sonner-toast] button, [role=status] button, button')].find((x) => x.textContent.trim() === 'Undo'); if (!undo) return 'NO UNDO (' + toast.slice(0, 80) + ')';
     await __t.real.click(undo); await __t.sleep(1200);
     const back = (await mine()).map((r) => r.name);
     return 'removed: ' + (after === 0) + ' | message has the count: ' + counted + ' | undo brings back: ' + back.join(',');`,
  ),
  step(
    'clean-up',
    `for (const r of (await mine())) await window.aps.invoke('debug.deleteRule', { id: r.id });
     return 'left: ' + (await mine()).length;`,
  ),
];

module.exports = withExpect(steps, {
  'three-filter-rules-in-the-panel': /^rules listed: 3 \| store: 3$/,
  'remove-all-is-a-labelled-button': /^label: Remove all \| icon: true \| disabled: false \| beside: .*Reset hits.* \| .*Add$/,
  'disabled-with-a-reason-while-searching': /^disabled while searching: true \| reason: true$/,
  'remove-all-then-undo': /^removed: true \| message has the count: true \| undo brings back: e2e clear one,e2e clear two,e2e clear three$/,
  'clean-up': /^left: 0$/,
});
