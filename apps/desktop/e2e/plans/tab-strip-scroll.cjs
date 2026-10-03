// With more tabs than fit, the active tab is always fully in view: after "Open in tab" from a row's menu, and after
// choosing another tab (the strip scrolls only as far as needed).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const strip = () => document.querySelector('[role=tablist][aria-label="Open requests"]');
  const tabs = () => [...strip().querySelectorAll('[role=tab]')];
  /** How the active tab sits in the strip: fully shown, or cut by how many pixels on each side. */
  const view = () => {
    const s = strip().getBoundingClientRect(); const a = tabs().find((t) => t.getAttribute('aria-selected') === 'true'); if (!a) return 'no active tab';
    const r = a.getBoundingClientRect(); const cutLeft = Math.max(0, Math.round(s.left - r.left)); const cutRight = Math.max(0, Math.round(r.right - s.right));
    return a.textContent.trim() + ': ' + (cutLeft || cutRight ? 'cut ' + cutLeft + '/' + cutRight : 'fully shown');
  };
  const filter = async (v) => { const f = document.querySelector('aside input[placeholder^="Filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(700); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'many-tabs',
    `await __t.requests(); await filter('DummyJSON'); await __t.sleep(300);
     const rows = () => [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.offsetParent && b.getAttribute('aria-expanded') === null);
     await filter(''); await __t.expand('Public REST APIs (playground)');
     for (const f of ['DummyJSON', 'Restful-Booker', 'Postman Echo']) await __t.expand(f);
     for (const r of rows().filter((b) => /^(GET|POST|PUT|PATCH|DELETE)/.test(b.textContent.trim())).slice(0, 14)) { r.click(); await __t.sleep(350); }
     await __t.sleep(800);
     return 'tabs: ' + tabs().length + ' | overflows: ' + (strip().scrollWidth > strip().clientWidth) + ' | ' + view();`,
  ),
  step(
    'open-in-tab-from-menu',
    `const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('Custom headers'));
     if (!r) { await filter('Custom headers'); }
     const row = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('Custom headers'));
     if (!row) return 'NO ROW';
     row.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Open in tab'), 2000); if (!item) return 'NO MENU';
     item.click(); await __t.sleep(1200); await filter('');
     return view();`,
  ),
  step(
    'pick-first-tab',
    `const more = [...document.querySelectorAll('[aria-label="All open tabs"]')].find((b) => b.offsetParent);
     if (!more) return 'NO BUTTON';
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
     const first = await __t.waitFor(() => document.querySelectorAll('[role=menuitem]')[0], 2000); if (!first) return 'NO MENU';
     first.click(); await __t.sleep(1000);
     return view();`,
  ),
  // the leftmost tab on screen is never cut (it looked hidden behind the sidebar), and the strip says there is more
  step(
    'no-half-tab-at-the-left',
    `const s = strip(); const w = tabs()[1].getBoundingClientRect().width; s.scrollLeft = Math.round(w * 1.6); await __t.sleep(400); // between two tabs, as a wheel leaves it
     const r = s.getBoundingClientRect();
     const firstShown = tabs().find((t) => t.getBoundingClientRect().right - r.left > 8);
     const cut = Math.max(0, Math.round(r.left - firstShown.getBoundingClientRect().left));
     const earlier = document.querySelector('[aria-label="Earlier tabs"]'); const later = document.querySelector('[aria-label="Later tabs"]');
     const before = s.scrollLeft; earlier?.click(); await __t.sleep(300);
     return 'leftmost cut by: ' + cut + 'px | buttons: ' + (!!earlier) + '/' + (!!later) + ' | earlier scrolls back: ' + (s.scrollLeft < before) + ' | at start hides earlier: ' + (s.scrollLeft > 1 || !document.querySelector('[aria-label="Earlier tabs"]'));`,
  ),
];

module.exports = withExpect(steps, {
  'no-half-tab-at-the-left': /^leftmost cut by: 0px \| buttons: true\/true \| earlier scrolls back: true \| at start hides earlier: true$/,
  'many-tabs': /^tabs: (1[0-9]|[2-9]\d) \| overflows: true \| .*: fully shown$/,
  'open-in-tab-from-menu': /^GETCustom headers: fully shown$/,
  'pick-first-tab': /: fully shown$/,
});
