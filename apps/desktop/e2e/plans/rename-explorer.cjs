// Rename in place in the explorer: requests, folders and collections (F2, menu, Enter, Esc, click away, blank).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const row = (txt) => [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().includes(txt));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const input = () => document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest('aside') ? document.activeElement : null;
  const names = (re) => [...document.querySelectorAll('button[data-tree-row]')].filter((b) => b.offsetParent && re.test(b.textContent)).map((b) => b.textContent.trim().replace(/^(GET|POST)/, '')).join(' / ');
`;
const step = stepOf(H);
const steps = [
  step('setup', `await __t.requests(); await __t.sleep(500); for (const t of ['HTTP basics', 'REST17', 'Requests & responses10']) { await __t.expand(t); await __t.sleep(300); } return names(/Custom headers|Requests & responses|HTTP basics/);`),
  step('f2-request', `const r = row('Custom headers'); r.focus(); key(r, 'F2'); await __t.sleep(400); const i = input(); if (!i) return 'NO INPUT'; return 'input=' + JSON.stringify(i.value) + ' selected=' + (i.selectionStart === 0 && i.selectionEnd === i.value.length) + ' label=' + i.getAttribute('aria-label');`),
  step('enter-saves', `const i = input(); setVal(i, 'Custom headers renamed'); key(i, 'Enter'); await __t.sleep(600); const back = document.activeElement?.textContent?.trim(); return 'row: ' + names(/Custom headers/) + ' | focus back on: ' + back;`),
  step('esc-cancels', `const r = row('Custom headers renamed'); r.focus(); key(r, 'F2'); await __t.sleep(400); const i = input(); setVal(i, 'SHOULD NOT SAVE'); key(i, 'Escape'); await __t.sleep(500); return 'row: ' + names(/Custom headers|SHOULD NOT/) + ' | input gone: ' + !input();`),
  step('blank-refused', `const r = row('Custom headers renamed'); if (!r) return 'NO ROW: ' + names(/Custom/); r.focus(); key(r, 'F2'); await __t.sleep(400); const i = input(); if (!i) return 'NO INPUT after F2; active=' + document.activeElement?.tagName + ' ' + (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 40)); setVal(i, '   '); key(i, 'Enter'); await __t.sleep(400); if (!input()) return 'INPUT GONE after Enter; active=' + document.activeElement?.tagName + ' ' + (document.activeElement?.textContent?.slice(0, 40)); const alert = document.querySelector('aside [role=alert]')?.textContent; const still = !!input(); key(input(), 'Escape'); await __t.sleep(400); return 'alert=' + alert + ' still editing=' + still + ' | row: ' + names(/Custom headers/);`),
  step('menu-rename-collection', `const r = row('HTTP basics'); r.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); await __t.sleep(600); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'Rename')?.click(); await __t.sleep(700); const i = input(); if (!i) return 'NO INPUT'; setVal(i, 'HTTP basics X'); document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await __t.sleep(600); return 'collections: ' + names(/HTTP basics/);`),
  step('f2-folder', `const r = row('Requests & responses'); r.focus(); key(r, 'F2'); await __t.sleep(400); const i = input(); if (!i) return 'NO INPUT'; setVal(i, 'Req & resp'); key(i, 'Enter'); await __t.sleep(600); return 'folders: ' + names(/Req & resp|Requests & responses/);`),
  step('restore', `for (const [from, to] of [['Custom headers renamed', 'Custom headers'], ['Req & resp', 'Requests & responses']]) { const r = row(from); r.focus(); key(r, 'F2'); await __t.sleep(400); setVal(input(), to); key(input(), 'Enter'); await __t.sleep(500); }
    const c = row('HTTP basics X'); c.focus(); key(c, 'F2'); await __t.sleep(400); setVal(input(), 'HTTP basics (httpbin)'); key(input(), 'Enter'); await __t.sleep(600); return names(/Custom headers|Requests & responses|HTTP basics/);`),
  step('open-still-works', `const r = row('Custom headers'); r.click(); await __t.sleep(1200); return [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')].map((t) => t.textContent.trim()).join('');`),
];

module.exports = withExpect(steps, {
  'f2-request': /input="Custom headers" selected=true/,
  'enter-saves': /row: Custom headers renamed \| focus back on: GETCustom headers renamed/,
  'esc-cancels': /^row: Custom headers renamed \| input gone: true$/,
  'blank-refused': /alert=A name is required still editing=true/,
  'menu-rename-collection': /collections: HTTP basics X/,
  'f2-folder': /Req & resp10/,
  restore: /HTTP basics \(httpbin\) \/ Requests & responses10 \/ Custom headers/,
  'open-still-works': /GETCustom headers/,
});
