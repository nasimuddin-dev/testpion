// New tabs have one kind of name; saved ones keep theirs.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder } = require('../lib.cjs');
const tabs = `[...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].map((t) => t.textContent.trim()).join(' | ')`;
const newOf = (label) => `(async () => { await __t.requests(); await __t.sleep(300); const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500); const m = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!m) return 'NO ITEM ${label}'; m.click(); await __t.sleep(1500); return ${tabs}; })()`;
const steps = [
  ['close-all', `(async () => { await __t.requests(); const t = document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab]'); if (t) { t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 60 })); await __t.sleep(400); [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('Close all'))?.click(); await __t.sleep(1200); } return ${tabs}; })()`],
  ['new-http', newOf('HTTP request')],
  ['new-graphql', newOf('GraphQL request')],
  ['new-grpc', newOf('gRPC request')],
  ['new-ws', newOf('WebSocket')],
  ['new-mcp', newOf('MCP server')],
  ['saved-ws', `(async () => { await __t.expand('WebSocket & MQTT'); await __t.sleep(300); await __t.expand('Echo servers'); await __t.sleep(300); const r = [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('Postman echo')); r?.click(); await __t.sleep(1500); return ${tabs}; })()`],
];

module.exports = withExpect(steps, {
  'new-http': /GETNew HTTP request/,
  'new-graphql': /GQLNew GraphQL request/,
  'new-grpc': /gRPCNew gRPC request/,
  'new-ws': /WSNew WebSocket request/,
  'new-mcp': /MCPNew MCP server/,
  'saved-ws': /WSPostman echo \(JSON\)/,
});
