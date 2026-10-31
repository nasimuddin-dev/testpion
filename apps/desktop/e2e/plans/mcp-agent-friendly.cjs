// For AI agents: on a connected MCP server, Server info says how easy its tools are for an agent to use (the words of
// `testpion mcp --lint`): a summary line and the findings, read from the tool list the app already has. Offline: the weather mock server.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  ['open-the-mock-server', `(async () => { await __t.view('Collections'); await __t.sleep(600); await __t.open('Weather (offline mock)'); return 'opened'; })()`],
  ['connect', `(async () => { await __t.button('Connect'); await __t.sleep(3500); return 'connected'; })()`],
  [
    'server-info-says-how-agent-friendly-the-tools-are',
    `(async () => {
      await __t.tab('Server info'); await __t.sleep(800);
      const box = await __t.waitFor(() => document.querySelector('[data-mcp-lint]'), 6000); if (!box) return 'NO LINT';
      const summary = box.querySelector('[data-mcp-lint-text]')?.textContent.trim();
      const levels = [...new Set([...box.querySelectorAll('[data-mcp-lint-finding]')].map((f) => f.getAttribute('data-mcp-lint-finding')))].sort().join(',');
      return 'summary: ' + /^\\d+ tools?: \\d+ errors?, \\d+ warnings?, \\d+ tips?\\. The list takes about \\d+ tokens/.test(summary ?? '') + ' | findings or healthy: ' + (levels.length > 0 || /Every tool says/.test(box.textContent));
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'open-the-mock-server': /^opened$/,
  connect: /^connected$/,
  'server-info-says-how-agent-friendly-the-tools-are': /^summary: true \| findings or healthy: true$/,
});
