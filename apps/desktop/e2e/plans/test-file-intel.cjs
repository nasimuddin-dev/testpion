// The test-file editor knows the format: a misspelt key or an unknown check type gets a marker a moment after typing
// (the same lint as `testpion lint` and the lint_tests tool), keys complete with help, and a key's hover explains it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const editor = () => (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
  const markers = () => { const m = editor()?.getModel(); return m ? window.__monaco.editor.getModelMarkers({ resource: m.uri }).map((x) => x.severity + ':' + x.startLineNumber + ':' + x.message.split(':')[0]) : []; };
  const openFile = async (name) => { await __t.view('Tests'); await __t.sleep(800); const r = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name)); if (!r) return false; r.click(); await __t.sleep(1500); return !!editor(); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'markers-for-mistakes',
    `if (!(await openFile('httpbin.yaml'))) return 'NO EDITOR';
     await __t.sleep(1200);
     const clean = markers().length;
     const ed = editor(); const model = ed.getModel();
     const text = model.getValue();
     // a misspelt key and an unknown check type, typed into the first test
     const at = text.indexOf('    assertions:');
     model.applyEdits([{ range: new window.__monaco.Range(model.getPositionAt(at).lineNumber, 1, model.getPositionAt(at).lineNumber, 1), text: '    methd: GET\\n' }]);
     await __t.sleep(1500);
     const after = markers();
     model.setValue(text); await __t.sleep(1500);
     return 'clean: ' + clean + ' | after a typo: ' + after.join(' ; ') + ' | restored: ' + markers().length;`,
  ),
  step(
    'keys-complete-with-help',
    `const ed = editor(); if (!ed) return 'NO EDITOR';
     const model = ed.getModel(); const text = model.getValue();
     const at = text.indexOf('    assertions:');
     const line = model.getPositionAt(at).lineNumber;
     model.applyEdits([{ range: new window.__monaco.Range(line, 1, line, 1), text: '    \\n' }]);
     // the list is virtualised (a dozen rows drawn), so each key is asked for by its first letters
     const offered = async (prefix) => {
       model.applyEdits([{ range: new window.__monaco.Range(line, 1, line, 100), text: '    ' + prefix }]);
       ed.setPosition({ lineNumber: line, column: 5 + prefix.length }); ed.focus();
       ed.trigger('e2e', 'editor.action.triggerSuggest', {}); await __t.sleep(700);
       const items = [...document.querySelectorAll('.suggest-widget .monaco-list-row')].map((r) => r.querySelector('.label-name')?.textContent.trim()).filter(Boolean);
       ed.trigger('e2e', 'hideSuggestWidget', {});
       return items;
     };
     await offered('');
     const items = [];
     for (const k of ['headers', 'auth', 'extract', 'dependsOn', 'query']) if ((await offered(k.slice(0, 3))).includes(k)) items.push(k);
     model.setValue(text); await __t.sleep(600);
     return 'offers: ' + ['headers', 'auth', 'extract', 'dependsOn'].filter((k) => items.includes(k)).join(',') + ' | not a graphql key: ' + !items.includes('query');`,
  ),
  step(
    'hover-explains-a-key',
    `const ed = editor(); if (!ed) return 'NO EDITOR';
     const model = ed.getModel(); const text = model.getValue();
     const at = text.indexOf('dependsOn:') >= 0 ? text.indexOf('dependsOn:') : text.indexOf('assertions:');
     const pos = model.getPositionAt(at + 2);
     ed.setPosition(pos); ed.focus();
     ed.trigger('e2e', 'editor.action.showHover', {}); await __t.sleep(900);
     const hover = document.querySelector('.monaco-hover')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
     return 'hover: ' + hover.slice(0, 80);`,
  ),
];

module.exports = withExpect(steps, {
  'markers-for-mistakes': /^clean: 0 \| after a typo: 4:\d+:"methd" is not read \| restored: 0$/,
  'keys-complete-with-help': /^offers: headers,auth,extract,dependsOn \| not a graphql key: true$/,
  'hover-explains-a-key': /^hover: (dependsOn|assertions) · /,
});
