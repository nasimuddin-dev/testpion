// Settings ▸ AI agents: setup for each agent, Test connection starts the MCP server, AGENTS.md.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, allUnder } = require('../lib.cjs');
const btn = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(label)})`;
const steps = [
  ['agents-panel', `(async () => { await __t.view('Settings'); await __t.sleep(600); await __t.tab('AI agents'); await __t.sleep(1000); return [...document.querySelectorAll('main pre')].filter((x) => x.offsetParent).map((x) => x.textContent).join(' || '); })()`],
  ['agents-test', `(async () => { ${btn('Test connection')}?.click(); for (let i = 0; i < 40; i++) { await __t.sleep(1000); const t = document.querySelector('main')?.innerText ?? ''; if (/started in|did not start/.test(t)) break; } const t = document.querySelector('main').innerText; return (t.match(/.*started in.*|.*did not start.*/) ?? ['NO RESULT'])[0]; })()`],
  ['agents-vscode', `(async () => { await __t.tab('VS Code'); await __t.sleep(500); return [...document.querySelectorAll('main pre')].filter((x) => x.offsetParent).map((x) => x.textContent).join(' || '); })()`],
  ['agents-md', `(async () => { ${btn('Write AGENTS.md')}?.click(); await __t.sleep(1500); return [...document.querySelectorAll('li, [role=status], div')].filter((x) => x.children.length <= 2 && /AGENTS\\.md/.test(x.textContent) && x.textContent.length < 300).map((x) => x.textContent.trim())[0] ?? 'NO TOAST'; })()`],
  // the CLAUDE.md pointer beside it (a real click on the switch), and the report per file: AGENTS.md is already up to date
  [
    'agents-md-files',
    `(async () => {
      const sw = [...document.querySelectorAll('main [data-agent-targets] label')].find((l) => /Also CLAUDE\\.md/.test(l.textContent))?.querySelector('[role=switch]');
      if (!sw) return 'NO SWITCH';
      await __t.real.click(sw); await __t.sleep(300);
      await __t.real.click(${btn('Update AGENTS.md')} ?? ${btn('Write AGENTS.md')});
      const files = await __t.waitFor(() => { const l = [...document.querySelectorAll('main [data-agent-file]')]; return l.length === 2 ? l : null; }, 5000);
      return files ? files.map((f) => f.dataset.agentFile + '=' + f.dataset.status).join(' ') : 'NO FILES';
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'agents-panel': /claude mcp add testpion -- /,
  'agents-test': /started in [\d.]+ s: \d+ tools \(\d+ read-only\), \d+ resources, 5 prompts/,
  'agents-vscode': /"servers"/,
  'agents-md': /AGENTS\.md/,
  'agents-md-files': /^AGENTS\.md=unchanged CLAUDE\.md=created$/,
});
