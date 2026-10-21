// Rename tabs in place (double-click, F2, tab menu); saved items are renamed where they are saved.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const tabs = () => [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
  const tab = (txt) => tabs().find((t) => t.textContent.includes(txt));
  const titles = () => tabs().map((t) => t.textContent.trim()).join(' | ');
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const input = () => (document.activeElement?.getAttribute('aria-label') === 'Tab name' ? document.activeElement : null);
  const rows = (re) => [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.offsetParent && re.test(b.textContent)).map((b) => b.textContent.trim()).join(' / ');
  const type = async (v, k = 'Enter') => { const i = input(); if (!i) return false; setVal(i, v); key(i, k); await __t.sleep(1000); return true; };
  const menuRename = async (txt) => { tab(txt).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 60 })); await __t.sleep(500); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('Rename'))?.click(); await __t.sleep(600); };
  const openRow = async (txt) => { const r = [...document.querySelectorAll('aside button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes(txt)); r?.click(); await __t.sleep(1500); };
`;
const step = stepOf(H);
const steps = [
  step('setup', `await __t.requests(); await __t.sleep(500); for (const t of ['HTTP basics', 'REST17', 'Requests & responses10', 'WebSocket & MQTT', 'WebSocket & MQTT3', 'MCP servers', 'GraphQL (Countries']) { await __t.expand(t); await __t.sleep(250); } return titles();`),
  step('dblclick-new-http', `const t = tab('New HTTP request'); if (!t) return 'NO TAB: ' + titles(); t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(500); if (!(await type('My HTTP'))) return 'NO INPUT'; return titles();`),
  step('f2-saved-request', `await openRow('GET with query'); const t = tab('GET with query'); t.focus(); key(t, 'F2'); await __t.sleep(500); if (!(await type('GET with query X'))) return 'NO INPUT'; return titles() + ' || tree: ' + rows(/GET with query/);`),
  step('menu-back', `await menuRename('GET with query X'); if (!(await type('GET with query parameters'))) return 'NO INPUT'; return 'tree: ' + rows(/GET with query/);`),
  step('esc', `const t = tab('My HTTP'); t.click(); await __t.sleep(300); t.focus(); key(t, 'F2'); await __t.sleep(400); await type('NOPE', 'Escape'); return titles();`),
  step('ws-saved', `await openRow('Postman echo'); await menuRename('Postman echo'); if (!(await type('Echo X'))) return 'NO INPUT'; const a = rows(/Echo X|Postman echo/); await menuRename('Echo X'); await type('Postman echo (JSON)'); return a + ' -> ' + rows(/Echo X|Postman echo/);`),
  step('mcp-saved', `await openRow('Weather'); await menuRename('Weather'); if (!(await type('Weather X'))) return 'NO INPUT'; const a = rows(/Weather/); await menuRename('Weather X'); await type('Weather (offline mock)'); return a + ' -> ' + rows(/Weather/);`),
  step('graphql-new', `const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('GraphQL request')).click(); await __t.sleep(1500); await menuRename('New GraphQL request'); if (!(await type('My GQL'))) return 'NO INPUT'; return titles();`),
];

module.exports = withExpect(steps, {
  'dblclick-new-http': /GETMy HTTP/,
  'f2-saved-request': /tree: GETGET with query X/,
  'menu-back': /tree: GETGET with query parameters/,
  esc: (r) => (!/NOPE/.test(r) && /GETMy HTTP/.test(r)) || 'Esc should keep the name',
  'ws-saved': /WSEcho X -> WSPostman echo/,
  'mcp-saved': /Weather Xmock -> MCPWeather \(offline mock\)/,
  'graphql-new': /GQLMy GQL/,
});
