// Changes since you approved it, and Protocol: on a connected MCP server, Server info says whether the server follows the
// protocol where a client can see it and what changed since its tools were approved (the words of `testpion mcp --check`).
// Never approved at first; Approve keeps what it offers now (mcp-snapshots/), then nothing has changed. Offline: the weather mock.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  ['open-the-mock-server', `(async () => { await __t.view('Collections'); await __t.sleep(600); await __t.open('Weather (offline mock)'); return 'opened'; })()`],
  ['connect', `(async () => { await __t.button('Connect'); await __t.sleep(3500); return 'connected'; })()`],
  [
    'not-approved-yet-and-the-protocol-checks-pass',
    `(async () => {
      await __t.tab('Server Info'); await __t.sleep(800);
      const box = await __t.waitFor(() => document.querySelector('[data-mcp-drift]'), 8000); if (!box) return 'NO CHECK';
      const proto = document.querySelector('[data-mcp-conformance]');
      return 'state: ' + box.getAttribute('data-mcp-drift') + ' | says: ' + /Not approved yet/.test(box.textContent) + ' | protocol: ' + proto?.getAttribute('data-mcp-conformance') + ' | ' + /Protocol: \\d+ checks passed\\. The server speaks MCP \\d{4}-\\d{2}-\\d{2}\\./.test(proto?.querySelector('[data-mcp-conformance-text]')?.textContent ?? '');
    })()`,
  ],
  [
    'approve-keeps-what-it-offers-now',
    `(async () => {
      document.querySelector('[data-mcp-approve]').click();
      const same = await __t.waitFor(() => document.querySelector('[data-mcp-drift="same"]'), 8000); if (!same) return 'NOT APPROVED';
      const button = document.querySelector('[data-mcp-approve]');
      return 'says: ' + /^Nothing changed since it was approved on \\d{4}-\\d{2}-\\d{2}\\.$/.test(same.querySelector('[data-mcp-drift-text]').textContent.trim()) + ' | button off with a reason: ' + (button.disabled && /Nothing changed/.test(button.title));
    })()`,
  ],
  [
    'which-tool-each-model-picks-starts-without-cases',
    `(async () => {
      const box = await __t.waitFor(() => document.querySelector('[data-mcp-selection]'), 8000); if (!box) return 'NO SECTION';
      return 'state: ' + box.getAttribute('data-mcp-selection') + ' | file: ' + /datasets\/mcp-selection-[a-z0-9-]+\.jsonl/.test(box.querySelector('[data-mcp-selection-text]').textContent) + ' | write button: ' + box.querySelector('[data-mcp-selection-write]').textContent.trim() + ' | run button: ' + !!box.querySelector('[data-mcp-selection-run]');
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'open-the-mock-server': /^opened$/,
  connect: /^connected$/,
  'not-approved-yet-and-the-protocol-checks-pass': /^state: never \| says: true \| protocol: ok \| true$/,
  'approve-keeps-what-it-offers-now': /^says: true \| button off with a reason: true$/,
  'which-tool-each-model-picks-starts-without-cases': /^state: empty \| file: true \| write button: Write cases with AI \| run button: false$/,
});
