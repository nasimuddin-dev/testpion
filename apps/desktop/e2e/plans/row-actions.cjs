// One ⋯ per row: its menu starts with what + did; collection, folder and request menus share one grouping.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder } = require('../lib.cjs');
const menu = `[...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()).slice(0, 6).join(' | ')`;
/** The open menu as groups: items joined by ' | ', groups by ' ‖ '. */
const groups = `(() => { const m = document.querySelector('[role=menu]'); if (!m) return 'NO MENU'; const out = [[]]; for (const el of m.querySelectorAll('[role=menuitem], [role=separator]')) { if (el.getAttribute('role') === 'separator') out.push([]); else out[out.length - 1].push(el.textContent.trim()); } return out.map((g) => g.join(' | ')).join(' ‖ '); })()`;
const rowMenu = (text) => `(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400); const r = [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().replace(/\\d+$/, '').endsWith(${JSON.stringify(text)})); if (!r) return 'NO ROW'; r.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); await __t.sleep(600); return ${groups}; })()`;
const steps = [
  ['explorer', `(async () => { await __t.requests(); await __t.sleep(800); const aside = document.querySelector('aside'); return 'plus buttons in rows: ' + [...aside.querySelectorAll('button[aria-label^="New HTTP request in"], button[aria-label^="Add an MCP"], button[aria-label^="Import an OpenAPI"]')].length + ' | ⋯ buttons: ' + aside.querySelectorAll('[aria-label^="More actions for"]').length; })()`],
  ['collection-menu', `(async () => { const r = [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('HTTP basics')); r.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); await __t.sleep(600); return ${menu}; })()`],
  ['collection-menu-groups', `(async () => ${groups})()`],
  ['folder-menu-groups', `(async () => { await __t.expand('HTTP basics'); return await ${rowMenu('Requests & responses')}; })()`],
  ['request-menu-groups', `(async () => { await __t.expand('Requests & responses'); return await ${rowMenu('Custom headers')}; })()`],
  ['mcp-menu', `(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400); const b = [...document.querySelectorAll('[aria-label="More actions for MCP servers"]')].find((x) => x.offsetParent); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(600); return ${menu}; })()`],
  ['new-from-menu', `(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(400); const before = document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]').length; const r = [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('HTTP basics')); r.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); await __t.sleep(600); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === 'New HTTP request').click(); await __t.sleep(1200); return 'tabs ' + before + ' -> ' + document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]').length; })()`],
  ['monitors-header', `(async () => { await __t.view('Monitors'); await __t.sleep(700); const b = [...document.querySelectorAll('[aria-label^="More actions for Monitors"]')].find((x) => x.offsetParent); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(600); return ${menu}; })()`],
];

module.exports = withExpect(steps, {
  explorer: /plus buttons in rows: 0/,
  'collection-menu': /^New HTTP request \| New GraphQL request/,
  // create · expand / collapse · run · test · configure · organize · delete
  'collection-menu-groups': /^New HTTP request \| New GraphQL request \| New SOAP request \| New gRPC request \| New WebSocket & MQTT request \| New folder ‖ Expand all \| Collapse all ‖ Run collection \| Monitor on a schedule… \| Run in CI… ‖ Create test file from collection… ‖ Settings, runner & docs \| Convert scripts to tp\.\* \| Convert scripts to pm\.\* ‖ Rename \| Duplicate ‖ Delete…$/,
  'folder-menu-groups': /^New HTTP request \| New folder ‖ Expand all \| Collapse all ‖ Run folder \| Monitor on a schedule… ‖ Create test file from folder… ‖ Edit folder \(scripts, variables, auth\) ‖ Rename \| Duplicate \| Move to… ‖ Delete…$/,
  'request-menu-groups': /^Open \| Open in new tab ‖ Save as test… ‖ Copy .* ‖ Rename \| Duplicate \| Move to… \| (Add to|Remove from) favorites ‖ Delete…$/,
  'mcp-menu': /^Add an MCP server \| New folder/,
  'new-from-menu': (r) => { const m = /tabs (\d+) -> (\d+)/.exec(r); return (m && +m[2] === +m[1] + 1) || 'a new tab should open'; },
  'monitors-header': /^New monitor \| New folder/,
});
