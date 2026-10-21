// Response layout: Auto / Below / Side by side for every editor; switching keeps what you typed; tabs that do not fit stay reachable.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.offsetParent);
  // the request/response separator of the editor on screen: vertical separator = side by side
  const layout = () => { const seps = vis('main [role=separator]').filter((s) => s.parentElement.parentElement.className.includes('flex-col') || true); const s = seps.find((x) => x.parentElement.querySelector('[role=tablist]')); return seps.map((x) => x.getAttribute('aria-orientation') === 'vertical' ? 'side' : 'below').join(','); };
  const pick = async (label) => { const b = document.querySelector('[aria-label^="Response layout"]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(400); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.includes(label))?.click(); await __t.sleep(900); };
  const url = () => vis('main input[aria-label="Request URL"]')[0];
  const urlText = () => url()?.value ?? '';
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const step = stepOf(H);
const steps = [
  step('auto-default', `await __t.requests(); await __t.sleep(600); for (const t of ['HTTP basics', 'REST17', 'Requests & responses10']) { await __t.expand(t); await __t.sleep(200); } const r = vis('aside button[data-tree-row]').find((b) => b.textContent.includes('Custom headers')); r.click(); await __t.sleep(1500); const w = Math.round(document.querySelector('main').getBoundingClientRect().width); return 'button: ' + document.querySelector('[aria-label^="Response layout"]')?.getAttribute('aria-label') + ' | editor width ' + w + ' | REST separators: ' + layout();`),
  step('type-then-below', `setVal(url(), 'http://127.0.0.1:4010/health?keep=1'); await __t.sleep(400); await pick('Response below'); return 'REST: ' + layout() + ' | url kept: ' + urlText();`),
  step('side', `await pick('Side by side'); const more = vis('main [aria-label^="All tabs ("]')[0]; return 'REST: ' + layout() + ' | url kept: ' + urlText() + ' | tabs overflow button: ' + (more?.getAttribute('aria-label') ?? 'none');`),
  step('overflow-menu', `const more = vis('main [aria-label^="All tabs ("]')[0]; if (!more) return 'NO OVERFLOW BUTTON'; more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500); const items = [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.includes('Settings'))?.click(); await __t.sleep(700); return items.join(' | ') + ' || selected now: ' + vis('main [role=tab][aria-selected="true"]').map((t) => t.textContent.trim()).join(',');`),
  step('graphql-follows', `const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(400); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('GraphQL request')).click(); await __t.sleep(1500); const a = layout(); await pick('Response below'); return 'GraphQL side: ' + a + ' | after Below: ' + layout();`),
  step('auto-again', `await pick('Auto'); return 'GraphQL: ' + layout() + ' | setting: ' + document.querySelector('[aria-label^="Response layout"]')?.getAttribute('aria-label');`),
];

module.exports = withExpect(steps, {
  'auto-default': /REST separators: side/,
  'type-then-below': /REST: below \| url kept: http:\/\/127\.0\.0\.1:4010\/health\?keep=1/,
  side: /REST: side .*tabs overflow button: All tabs \(\d+ not shown\)/,
  'overflow-menu': /selected now: .*Settings/,
  'graphql-follows': /after Below: below,below/,
  'auto-again': /GraphQL: below,side/,
});
