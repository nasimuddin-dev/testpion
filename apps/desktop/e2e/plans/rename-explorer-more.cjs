// Rename in place: MCP servers, their folders and saved gRPC calls in a collection.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder, stepOf } = require('../lib.cjs');
const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const row = (txt) => [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().includes(txt));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const input = () => (document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('aside') ? document.activeElement : null);
  const names = (re) => [...document.querySelectorAll('button[data-tree-row]')].filter((b) => b.offsetParent && re.test(b.textContent)).map((b) => b.textContent.trim()).join(' / ');
  const f2 = async (txt) => { const r = row(txt); if (!r) return null; r.focus(); key(r, 'F2'); await __t.sleep(400); return input(); };
  const menuRename = async (txt, label) => { const r = row(txt); r.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 })); await __t.sleep(600); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim() === label)?.click(); await __t.sleep(700); return input(); };
  const type = async (i, v, k = 'Enter') => { setVal(i, v); key(i, k); await __t.sleep(800); };
`;
const step = stepOf(H);
const steps = [
  step('setup', `await __t.requests(); await __t.sleep(500); await __t.expand('MCP servers'); await __t.expand('gRPC (grpcb.in)'); await __t.sleep(300); await __t.expand('gRPC3'); await __t.sleep(300); await __t.expand('grpcb.in3'); await __t.sleep(400); return names(/DeepWiki|Public servers|Add two numbers|Petstore MCP/);`),
  step('server-f2', `const i = await f2('DeepWiki'); if (!i) return 'NO INPUT'; const sel = i.selectionStart === 0 && i.selectionEnd === i.value.length; await type(i, 'DeepWiki 2'); return 'selected=' + sel + ' | ' + names(/DeepWiki/) + ' | focus: ' + document.activeElement?.textContent?.trim().slice(0, 20);`),
  step('server-esc', `const i = await f2('Petstore MCP'); setVal(i, 'NOPE'); key(i, 'Escape'); await __t.sleep(500); return names(/Petstore MCP|NOPE/) + ' | editing: ' + !!input();`),
  step('folder-f2', `const i = await f2('Public servers'); if (!i) return 'NO INPUT'; await type(i, 'Public 2'); await __t.sleep(500); return names(/Public|DeepWiki|Petstore MCP/);`),
  step('folder-menu-back', `const i = await menuRename('Public 2', 'Rename folder'); if (!i) return 'NO INPUT'; await type(i, 'Public servers'); await __t.sleep(500); return names(/Public|DeepWiki|Petstore MCP/);`),
  step('grpc-f2', `const i = await f2('Add two numbers'); if (!i) return 'NO INPUT'; await type(i, 'Add numbers'); return names(/Add numbers|Add two/);`),
  step('grpc-menu-back', `const i = await menuRename('Add numbers', 'Rename'); if (!i) return 'NO INPUT'; await type(i, 'Add two numbers'); return names(/Add numbers|Add two/);`),
  step('server-back-and-open', `const i = await menuRename('DeepWiki 2', 'Rename'); if (!i) return 'NO INPUT'; await type(i, 'DeepWiki'); row('Add two numbers').click(); await __t.sleep(1500); return names(/DeepWiki/) + ' | open tab: ' + [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')].map((t) => t.textContent.trim()).join('');`),
];

module.exports = withExpect(steps, {
  'server-f2': /selected=true \| MCPDeepWiki 2/,
  'server-esc': /Petstore MCPhttp \| editing: false/,
  'folder-f2': /Public 23/,
  'folder-menu-back': /Public servers3/,
  'grpc-f2': /Add numbers/,
  'grpc-menu-back': /gRPCAdd two numbers$/,
  'server-back-and-open': /DeepWikihttp \| open tab: gRPCAdd two numbers/,
});
