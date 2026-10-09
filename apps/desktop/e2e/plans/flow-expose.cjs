// A flow as an MCP tool: Tests ▸ file menu ▸ Expose as MCP tool… writes the expose: block (name, description, inputs)
// into the YAML, Settings ▸ AI agents lists the flow, and Stop exposing removes the block again.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const row = (name) => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name));
  const openMenu = async (name) => { await __t.esc(); const r = row(name); if (!r) return false; r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); return !!(await __t.waitFor(() => document.querySelector('[role=menu]'), 2000)); };
  const menuItem = (label) => vis('[role=menuitem]').find((m) => m.textContent.trim() === label);
  const editorText = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)?.getValue() ?? 'NO EDITOR';
  const dialog = () => document.querySelector('[role=dialog]');
  const dlgInput = (label) => dialog()?.querySelector('[aria-label="' + label + '"]');
  const dlgButton = (label) => [...document.querySelectorAll('[role=dialog] button')].filter((b) => b.textContent.trim() === label).pop();
  const openExposeDialog = async (name) => { if (!(await openMenu(name))) return false; menuItem('Expose as MCP tool…')?.click(); return !!(await __t.waitFor(() => dlgInput('Tool name'), 3000)); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-file',
    `await __t.view('Tests'); await __t.sleep(1000); const r = row('httpbin.yaml'); if (!r) return 'NO ROW'; r.click(); await __t.sleep(1200); return 'open: ' + /httpbin/.test(editorText());`,
  ),
  step('menu-has-expose', `if (!(await openMenu('httpbin.yaml'))) return 'NO MENU'; return vis('[role=menuitem]').map((m) => m.textContent.trim()).join(' | ');`),
  step(
    'dialog-writes-expose',
    `menuItem('Expose as MCP tool…')?.click(); if (!(await __t.waitFor(() => dlgInput('Tool name'), 3000))) return 'NO DIALOG';
     setInput(dlgInput('Tool name'), 'httpbin_smoke'); setInput(dlgInput('Description'), 'Smoke-test httpbin');
     dlgButton('Add input')?.click(); await __t.sleep(200); if (!dlgInput('Input name')) return 'NO INPUT ROW';
     setInput(dlgInput('Input name'), 'who'); setInput(dlgInput('Input default'), 'tester'); await __t.sleep(200);
     dlgButton('Expose')?.click(); await __t.waitFor(() => !dialog(), 5000); await __t.sleep(800);
     return editorText();`,
  ),
  step(
    'agents-lists-flow',
    `await __t.view('Settings'); await __t.sleep(600); await __t.tab('AI agents'); await __t.sleep(1200); return document.querySelector('[data-exposed-flows]')?.innerText.replace(/\\s+/g, ' ') ?? 'NO SECTION';`,
  ),
  step(
    'stop-exposing',
    `await __t.view('Tests'); await __t.sleep(800); if (!(await openExposeDialog('httpbin.yaml'))) return 'NO DIALOG';
     const title = dialog().querySelector('h2')?.textContent.trim(); const value = dlgInput('Tool name').value;
     dlgButton('Stop exposing')?.click(); if (!(await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].filter((b) => b.textContent.trim() === 'Stop exposing').length >= 2, 3000))) return 'NO CONFIRM';
     dlgButton('Stop exposing')?.click(); await __t.waitFor(() => !dialog(), 5000); await __t.sleep(800);
     return title + ' / ' + value + ' / expose present: ' + /expose:/.test(editorText());`,
  ),
];

module.exports = withExpect(steps, {
  'open-file': /^open: true$/,
  'menu-has-expose': /Open \| Run \| Expose as MCP tool… \| Export as Arazzo… \| Rename/,
  'dialog-writes-expose': /expose:\r?\n\s+tool: httpbin_smoke\r?\n\s+description: Smoke-test httpbin\r?\n\s+inputs:\r?\n\s+- \{ name: who, default: tester \}/,
  'agents-lists-flow': /httpbin_smoke\s*\(who\)\s*tests\/rest\/httpbin\.yaml\s*Smoke-test httpbin/,
  'stop-exposing': /^Exposed as MCP tool \/ httpbin_smoke \/ expose present: false$/,
});
