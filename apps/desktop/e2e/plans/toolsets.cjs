// Toolsets: a mock MCP server's Tools tab designs the tools an agent will see (the mock file is the source of truth):
// the file's tools are listed, Try answers a call from the unsaved definition, a tool can answer with a script run on
// the arguments, Save writes the YAML (the YAML view edits it raw), the Serve box has the commands for an agent's
// configuration, and Generate with AI asks for the agent's job then opens the assistant (AI-generated, reviewed first).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setVal = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const toolNames = () => vis('[data-toolset-tool]').map((b) => b.getAttribute('data-toolset-tool')).join(', ');
  const model = (part) => (window.__monaco?.editor.getModels() ?? []).find((m) => m.uri.path.includes(part));
  const badge = () => vis('main [data-toolset] span').find((s) => /^(success|isError)$/.test(s.textContent.trim()))?.textContent.trim() ?? 'NO RESULT';
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'mock-tools-are-listed',
    `await __t.requests();
     const f = document.querySelector('aside input[placeholder^="Filter"]'); setVal(f, 'Weather'); await __t.sleep(800);
     const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('Weather (offline mock)')); if (!r) return 'NO ROW';
     r.click(); await __t.sleep(1500); setVal(f, '');
     tab('Tools')?.click(); await __t.sleep(1200);
     const box = await __t.waitFor(() => vis('[data-toolset]')[0], 5000); if (!box) return 'NO TOOLSET';
     return 'file: ' + box.getAttribute('data-toolset') + ' | tools: ' + toolNames() + ' | tabs: ' + vis('main [role=tab]').map((t) => t.textContent.trim()).filter((t) => /^(Tools|Call tools|Resources)/.test(t)).join(', ');`,
  ),
  s(
    'try-answers-from-the-definition',
    `vis('[data-toolset-tool="get_forecast"]')[0]?.click(); await __t.sleep(800);
     const city = vis('main [data-toolset] label').find((l) => l.textContent.trim().startsWith('city'))?.querySelector('input'); if (!city) return 'NO CITY FIELD';
     setVal(city, 'Paris'); await __t.sleep(200);
     vis('[data-toolset-try]')[0]?.click();
     const ok = await __t.waitFor(() => badge() !== 'NO RESULT', 8000);
     const text = vis('main [data-toolset]').map((d) => d.innerText).join(' ');
     return 'result: ' + badge() + ' | mentions Paris: ' + /Paris/.test(text) + ' | celsius: ' + /celsius/.test(text);`,
  ),
  s(
    'a-script-tool-computes-its-answer',
    `vis('[data-toolset-add]')[0]?.click(); await __t.sleep(600);
     const name = vis('[data-toolset-name]')[0]; if (!name) return 'NO NAME FIELD';
     setVal(name, 'ping'); await __t.sleep(200);
     setVal(vis('[data-toolset-description]')[0], 'Answers pong with the number given.'); await __t.sleep(200);
     const kind = vis('[data-toolset-response="0"] select')[0]; if (!kind) return 'NO RESPONSE';
     setVal(kind, 'script'); await __t.sleep(1500);
     const m = await __t.waitFor(() => model('script.js'), 5000); if (!m) return 'NO SCRIPT EDITOR';
     m.setValue('(args) => ({ pong: true, n: (args.n ?? 0) * 2 })'); await __t.sleep(600);
     const schema = model('schema.json'); if (!schema) return 'NO SCHEMA EDITOR';
     schema.setValue(JSON.stringify({ type: 'object', properties: { n: { type: 'number', description: 'A number' } }, required: ['n'] })); await __t.sleep(800);
     const n = await __t.waitFor(() => vis('main [data-toolset] label').find((l) => l.textContent.trim().startsWith('n'))?.querySelector('input'), 3000); if (!n) return 'NO N FIELD';
     setVal(n, '21'); await __t.sleep(200);
     vis('[data-toolset-try]')[0]?.click();
     await __t.waitFor(() => badge() !== 'NO RESULT', 8000);
     const text = vis('main [data-toolset]').map((d) => d.innerText).join(' ');
     return 'tools: ' + toolNames() + ' | result: ' + badge() + ' | pong 42: ' + /42/.test(text) + ' | script badge: ' + vis('[data-toolset-tool="ping"] span').some((x) => x.textContent.trim() === 'script');`,
  ),
  s(
    'save-writes-the-yaml',
    `const save = vis('[data-toolset-save]')[0]; if (!save) return 'NO SAVE'; const before = save.disabled;
     save.click(); await __t.sleep(1500);
     const r = await window.aps.invoke('mcp.mock.read', { file: 'mocks/weather.mcp-mock.yaml' });
     const ping = r.definition.tools.find((t) => t.name === 'ping');
     return 'was enabled: ' + !before + ' | now disabled: ' + vis('[data-toolset-save]')[0].disabled + ' | tools in file: ' + r.definition.tools.map((t) => t.name).join(', ') + ' | script saved: ' + (ping?.responses?.[0]?.script ?? '').includes('pong') + ' | yaml has script: ' + /script:/.test(r.text);`,
  ),
  s(
    'serve-box-has-the-commands',
    `vis('[data-toolset-serve]')[0]?.click(); await __t.sleep(600);
     const cmds = vis('[data-toolset-command]').map((c) => c.textContent.trim());
     return 'stdio: ' + cmds[0] + ' | http: ' + cmds[1] + ' | config: ' + /"mcpServers"/.test(cmds[2] ?? '') + ' | copy buttons: ' + vis('[data-toolset-serve-box] button[aria-label^="Copy"]').length;`,
  ),
  s(
    'yaml-view-edits-the-raw-file',
    `vis('[data-toolset-serve]')[0]?.click(); await __t.sleep(300);
     vis('main [role=radiogroup][aria-label="Edit as"] [role=radio]').find((r) => r.textContent.trim() === 'YAML')?.click(); await __t.sleep(1500);
     const m = await __t.waitFor(() => model('weather.mcp-mock.yaml'), 5000); if (!m) return 'NO YAML EDITOR';
     const text = m.getValue();
     m.setValue(text.replace('Answers pong with the number given.', 'Answers pong (edited raw).')); await __t.sleep(500);
     vis('[data-toolset-save]')[0]?.click(); await __t.sleep(1500);
     const r = await window.aps.invoke('mcp.mock.read', { file: 'mocks/weather.mcp-mock.yaml' });
     vis('main [role=radiogroup][aria-label="Edit as"] [role=radio]').find((r) => r.textContent.trim() === 'Form')?.click(); await __t.sleep(1000);
     return 'language: ' + m.getLanguageId() + ' | has ping: ' + /name: ping/.test(text) + ' | raw edit saved: ' + r.definition.tools.find((t) => t.name === 'ping').description + ' | back to form: ' + toolNames();`,
  ),
  s(
    'generate-with-ai-asks-then-opens-the-assistant',
    `vis('[data-toolset-generate]')[0]?.click();
     const d = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find((x) => x.getClientRects().length && /Design a toolset with AI/.test(x.textContent)), 3000); if (!d) return 'NO DIALOG';
     const input = d.querySelector('input[aria-label="Design a toolset with AI"]') ?? d.querySelector('input'); setVal(input, 'a support agent that looks up orders and refunds small amounts'); await __t.sleep(200);
     [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Design tools')?.click();
     const panel = await __t.waitFor(() => document.querySelector('aside[aria-label="AI assistant"]'), 5000); if (!panel) return 'NO ASSISTANT';
     await __t.sleep(1500);
     const text = panel.innerText.replace(/\\s+/g, ' ');
     return 'title: ' + /Design a toolset/.test(text) + ' | ai-generated notice: ' + /AI-generated/.test(text) + ' | asked about: ' + /support agent/.test(text) + ' | not saved yet: ' + vis('[data-toolset-save]')[0]?.disabled;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'mock-tools-are-listed': /^file: mocks\/weather\.mcp-mock\.yaml \| tools: get_forecast, get_alerts \| tabs: Tools, Resources$/,
    'try-answers-from-the-definition': /^result: success \| mentions Paris: true \| celsius: true$/,
    'a-script-tool-computes-its-answer': /^tools: get_forecast, get_alerts, ping \| result: success \| pong 42: true \| script badge: true$/,
    'save-writes-the-yaml': /^was enabled: true \| now disabled: true \| tools in file: get_forecast, get_alerts, ping \| script saved: true \| yaml has script: true$/,
    'serve-box-has-the-commands':
      /^stdio: testpion mock-mcp mocks\/weather\.mcp-mock\.yaml \| http: testpion mock-mcp mocks\/weather\.mcp-mock\.yaml --http -p 3333 \| config: true \| copy buttons: 3$/,
    'yaml-view-edits-the-raw-file': /^language: yaml \| has ping: true \| raw edit saved: Answers pong \(edited raw\)\. \| back to form: get_forecast, get_alerts, ping$/,
    'generate-with-ai-asks-then-opens-the-assistant': /^title: true \| ai-generated notice: true \| asked about: true \| not saved yet: true$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' } },
);
