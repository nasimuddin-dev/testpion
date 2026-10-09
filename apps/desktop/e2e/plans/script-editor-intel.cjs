// The script editor knows the sandbox: console and the timers are declared (no "unknown" squiggle), tp.* completes,
// and {{braces}} in a script are never flagged as missing variables (a visualizer template uses them for its own
// fields), while a {{variable}} nobody defined still shows as missing in a URL or body.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const openRow = async (name) => { await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses'); const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)); if (!r) return false; r.click(); await __t.sleep(1200); return true; };
  const subTab = async (label) => { [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith(label))?.click(); await __t.sleep(900); };
  const setEditor = async (text) => { const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent); if (!ed) return false; ed.setValue(text); await __t.sleep(2500); return true; };
  const markers = () => [...document.querySelectorAll('main .monaco-editor .squiggly-error, main .monaco-editor .squiggly-warning')].length;
  const missing = () => [...document.querySelectorAll('main .monaco-editor .editor-var-missing')].map((s) => s.textContent.trim());
  const defined = () => [...document.querySelectorAll('main .monaco-editor .editor-var')].map((s) => s.textContent.trim());
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'console-and-template-in-a-script',
    `if (!(await openRow('POST a JSON body'))) return 'NO ROW'; await subTab('Scripts'); await __t.sleep(600);
     const ok = await setEditor(['console.log(tp.variables.toObject());', 'setTimeout(() => console.warn("later"), 0);', 'const template = "<td>{{email}}</td>{{httpbin}}";', 'tp.visualizer.set(template, { response: tp.response.json() });', ''].join(String.fromCharCode(10)));
     if (!ok) return 'NO EDITOR';
     return 'squiggles: ' + markers() + ' | missing: ' + JSON.stringify(missing()) + ' | defined: ' + JSON.stringify(defined());`,
  ),
  // tp is the API's name: "tp." offers the tp.test snippet, and "pm." (Postman habits) offers the same tp.* snippets, never pm.*
  step(
    'tp-completions',
    `const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent); if (!ed) return 'NO EDITOR';
     const offered = async (text) => {
       ed.setValue(text); const model = ed.getModel(); ed.setPosition(model.getPositionAt(text.length)); ed.focus();
       ed.trigger('e2e', 'editor.action.triggerSuggest', {}); await __t.sleep(1200);
       const items = [...document.querySelectorAll('.suggest-widget .monaco-list-row')].map((r) => r.querySelector('.label-name')?.textContent.trim()).filter(Boolean);
       ed.trigger('e2e', 'hideSuggestWidget', {});
       return items;
     };
     const tp = await offered('tp.te');
     const pm = await offered('pm.te');
     ed.setValue(''); await __t.sleep(300);
     return 'tp. offers tp.test: ' + tp.includes('tp.test') + ' | pm. offers tp.test: ' + pm.includes('tp.test') + ' | pm.* offered: ' + [...tp, ...pm].some((l) => l.startsWith('pm.'));`,
  ),
  // the Script packages dialog tells you how to load a package, with tp
  step(
    'packages-footer-says-tp',
    `const btn = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Packages…'); if (!btn) return 'NO BUTTON';
     btn.click(); await __t.sleep(1200);
     const dlg = document.querySelector('[role=dialog]'); if (!dlg) return 'NO DIALOG';
     const hint = [...dlg.querySelectorAll('span')].find((s) => s.textContent.trim().startsWith('In a script:'))?.textContent.trim() ?? '';
     dlg.querySelector('button[aria-label=Close]')?.click(); await __t.sleep(500);
     return 'footer: ' + hint.slice(0, 48);`,
  ),
  step(
    'missing-variable-in-a-body-still-shows',
    `await subTab('Body'); await __t.sleep(600);
     const ok = await setEditor('{ "url": "{{httpbin}}", "who": "{{nobodyDefinedThis}}" }');
     if (!ok) return 'NO EDITOR';
     return 'missing: ' + JSON.stringify(missing()) + ' | defined: ' + JSON.stringify(defined());`,
  ),
];

module.exports = withExpect(steps, {
  'console-and-template-in-a-script': /^squiggles: 0 \| missing: \[\] \| defined: \["\{\{httpbin\}\}"\]$/,
  'tp-completions': /^tp\. offers tp\.test: true \| pm\. offers tp\.test: true \| pm\.\* offered: false$/,
  'packages-footer-says-tp': /^footer: In a script: const auth = tp\.require\('name'\);/,
  'missing-variable-in-a-body-still-shows': /^missing: \["\{\{nobodyDefinedThis\}\}"\] \| defined: \["\{\{httpbin\}\}"\]$/,
});
