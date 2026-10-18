// "Close all tabs" closes every kind of tab (HTTP, GraphQL, WebSocket …), from whichever tab it is chosen on.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const tabs = () => [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
  const titles = () => tabs().map((t) => t.textContent.trim()).join(' / ');
  const openRow = async (name) => { const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes(name) && b.getAttribute('aria-expanded') === null); if (!r) return false; r.click(); await __t.sleep(1500); return true; };
  const filter = async (v) => { const f = document.querySelector('aside input[placeholder^="Filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(800); };
  const closeAllFrom = async (match) => {
    const t = tabs().find((x) => x.textContent.includes(match)); if (!t) return 'NO TAB ' + match;
    t.click(); await __t.sleep(800);
    const menu = await __t.tabMenu(); if (!/Close all tabs/.test(menu)) return 'NO MENU: ' + menu;
    [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.includes('Close all tabs')).click(); await __t.sleep(1500);
    return 'tabs left: ' + tabs().length + (tabs().length ? ' (' + titles() + ') | view: ' + document.querySelector('nav [aria-current="page"]')?.getAttribute('aria-label') + ' | docs: ' + localStorage.getItem('aps.docs') : '');
  };
  const openMixed = async () => {
    await __t.requests();
    for (const n of ['Custom headers', 'Country by code', 'Postman echo']) { await filter(n); if (!(await openRow(n))) return 'NO ROW ' + n; }
    await filter('');
    return titles();
  };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step('open-mixed', `return await openMixed();`),
  step('close-all-from-websocket', `return await closeAllFrom('Postman echo');`),
  step('open-mixed-again', `return await openMixed();`),
  step('close-all-from-http', `return await closeAllFrom('Custom headers');`),
  // a new WebSocket tab, connected, next to an HTTP tab
  step(
    'open-new-connected-websocket',
    `await __t.requests(); await filter('Custom headers'); await openRow('Custom headers'); await filter('');
     const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500);
     [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('WebSocket'))?.click(); await __t.sleep(1500);
     const url = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && /url|ws:/i.test((i.getAttribute('aria-label') ?? '') + i.placeholder));
     if (!url) return 'NO INPUT url';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, 'ws://127.0.0.1:4013'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Connect')?.click(); await __t.sleep(1500);
     return titles() + ' | connected: ' + [...document.querySelectorAll('main button')].some((b) => b.offsetParent && b.textContent.trim() === 'Disconnect');`,
  ),
  step('close-all-from-connected-websocket', `return await closeAllFrom('WebSocket');`),
  // every kind of tab at once: HTTP, GraphQL, gRPC, WebSocket, MCP server, API definition
  step(
    'open-every-kind',
    `await __t.requests();
     for (const n of ['Custom headers', 'Country by code', 'Add two numbers', 'Postman echo', 'Weather (offline mock)', 'petstore.json']) { await filter(n); if (!(await openRow(n))) return 'NO ROW ' + n; }
     await filter('');
     return titles();`,
  ),
  // the strip's count button is the same overflow control as every tab strip's: it lists every open tab, the active one ticked
  step(
    'all-open-tabs-menu',
    `const more = [...document.querySelectorAll('[data-tab-overflow][aria-label="All open tabs"]')].find((b) => b.offsetParent); if (!more) return 'NO BUTTON';
     const active = tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent.trim();
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
     await __t.waitFor(() => document.querySelector('[role=menuitem]'), 2000); await __t.sleep(200);
     const items = [...document.querySelectorAll('[role=menuitem]')];
     const ticked = items.filter((m) => m.querySelector('svg.lucide-check')).map((m) => m.textContent.trim());
     const first = items[0]; const firstLabel = first.textContent.trim(); first.click(); await __t.sleep(800);
     const now = tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent.trim();
     return 'count: ' + more.textContent.trim() + ' of ' + tabs().length + ' | items: ' + items.length + ' | ticked: ' + ticked.join(',') + ' | active was: ' + active + ' | picked: ' + firstLabel + ' | active now: ' + now;`,
  ),
  step('close-all-from-websocket-again', `return await closeAllFrom('Postman echo');`),
  step('reopen-websocket-only', `await __t.requests(); await filter('Postman echo'); await openRow('Postman echo'); await filter(''); return titles();`),
];

module.exports = withExpect(steps, {
  'open-mixed': /Custom headers.*Country by code.*Postman echo/,
  'close-all-from-websocket': /^tabs left: 0$/,
  'open-mixed-again': /Custom headers.*Country by code.*Postman echo/,
  'close-all-from-http': /^tabs left: 0$/,
  'open-new-connected-websocket': /Custom headers.*WSNew WebSocket request \| connected: true$/,
  'close-all-from-connected-websocket': /^tabs left: 0$/,
  'open-every-kind': /Custom headers.*Country by code.*Add two numbers.*Postman echo.*Weather.*petstore/,
  'all-open-tabs-menu': (r) => {
    const m = /^count: (\d+) of (\d+) \| items: (\d+) \| ticked: (.*) \| active was: (.*) \| picked: (.*) \| active now: (.*)$/.exec(r);
    if (!m) return 'no count button or menu: ' + r;
    const [, count, open, items, ticked, was, picked, now] = m;
    if (count !== open || items !== open) return 'the menu does not list every open tab: ' + r;
    // a tab's text is its badge (GET, GQL …) then its title; the ticked row is the title alone, the other rows badge then title
    if (ticked.includes(',') || !ticked || !was.includes(ticked)) return 'the active tab is not the one ticked: ' + r;
    return now && now.includes(picked) ? true : 'picking a row did not select its tab: ' + r;
  },
  'close-all-from-websocket-again': /^tabs left: 0$/,
  // a closed tab doesn't come back with the next one
  'reopen-websocket-only': /^WSPostman echo \(JSON\)$/,
});
