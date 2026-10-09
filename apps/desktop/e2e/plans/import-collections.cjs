// Importing other tools' collections the way a user does (Import ▸ Choose file… / Bruno folder…), then running them:
// a Postman, an Insomnia and a Bruno sample (e2e/fixtures), each with pre-request and post-response scripts and a
// token passed between requests, against the local demo server. Every request and every script test must pass.
// Postman's pm.* scripts come over as TestPion's tp.* (the toast says how many), and the script editor shows tp.test.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { withExpect } = require('../lib.cjs');

const FIX = join(__dirname, '..', 'fixtures');
const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [{ path: relative(dir, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }];
  });
const fixtureFiles = (sub) => files(join(FIX, sub));
// Bruno files are relative to the collection folder
const brunoFiles = files(join(FIX, 'bruno', 'vet-clinic')).map((f) => ({ ...f, path: f.path }));

/**
 * Import through the dialog: the next file picker gets these files (as if the user chose them), then press the
 * button. `folder`: a folder pick (Bruno), so each file carries its path inside the folder.
 */
const importVia = (button, picked, folder) => `
  const picked = ${JSON.stringify(picked)};
  const folder = ${JSON.stringify(folder ?? '')};
  const orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return orig.call(this);
    HTMLInputElement.prototype.click = orig;
    const list = picked.map((f) => {
      const file = new File([f.text], f.path.split('/').pop(), { type: f.path.endsWith('.json') ? 'application/json' : 'text/plain' });
      if (folder) Object.defineProperty(file, 'webkitRelativePath', { value: folder + '/' + f.path });
      return file;
    });
    Object.defineProperty(this, 'files', { value: list, configurable: true });
    this.dispatchEvent(new Event('change'));
  };
  await __t.requests();
  const before = (await window.aps.invoke('col.list')).map((c) => c.id);
  document.querySelector('[aria-label^="Import (OpenAPI"]').click();
  const btn = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === ${JSON.stringify(button)}), 3000);
  if (!btn) return 'NO BUTTON ' + ${JSON.stringify(button)};
  btn.click();
  let col;
  for (let i = 0; i < 40 && !col; i++) { await __t.sleep(150); col = (await window.aps.invoke('col.list')).find((x) => !before.includes(x.id)); }
  await __t.sleep(600);
  const toast = [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => /Imported/.test(t)) ?? 'no toast';
  await __t.esc();
`;

/** Run the imported collection (with the environment the import created, if any) and wait for its summary. */
const runIt = `
  if (!col) return 'NOT IMPORTED | ' + toast;
  const flat = (n) => n.flatMap((x) => (x.kind === 'folder' ? flat(x.items) : [x]));
  const reqs = flat(col.items);
  const scripted = reqs.filter((r) => r.preRequestScript || r.testScript).length;
  const envs = await window.aps.invoke('env.list');
  const env = envs.find((e) => /Vet clinic|Base Environment/i.test(e.name));
  const { runId } = await window.aps.invoke('col.run', { collectionId: col.id, environment: env?.name, keepVariableValues: false });
  let s = null;
  for (let i = 0; i < 60 && !s; i++) { await __t.sleep(250); s = await window.aps.invoke('runs.summary', { runId }); }
  if (!s) return 'NO SUMMARY';
  // the scripts' own tests ran and passed (a script that never ran would leave a request with nothing checked)
  const { items } = await window.aps.invoke('runs.results', { runId, limit: 50 });
  const checks = items.flatMap((r) => (r.checks ?? r.assertions ?? []).map((c) => (c.passed ? '✓' : '✗') + (c.name ?? c.type ?? '')));
  const scriptChecks = checks.filter((c) => /logged in|a list of patients|pre-request value was sent/.test(c));
  return 'collection: ' + col.name + ' | requests: ' + reqs.length + ' | with scripts: ' + scripted + ' | run: ' + s.passed + ' passed, ' + s.failed + ' failed, ' + (s.errors ?? 0) + ' errors | script tests: ' + scriptChecks.sort().join(', ');
`;

const step = (name, body) => [name, `(async () => { ${body} })()`];
const steps = [
  step('postman-file', importVia('Choose file…', fixtureFiles('postman')) + 'window.__importToast = toast;' + runIt),
  // the import converted the scripts to tp.* and said so; the request's post-response script reads tp.test, not pm.test
  step(
    'postman-scripts-tp',
    `const converted = /Converted \\d+ scripts? to tp\\.\\*/.exec(window.__importToast ?? '')?.[0] ?? 'no conversion in: ' + window.__importToast;
     await __t.requests(); await __t.expand('Vet clinic (Postman sample)');
     const opened = await __t.open('List patients (uses the token)'); if (opened !== 'ok') return opened;
     await __t.tab('Scripts');
     [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Post-response'))?.click();
     await __t.sleep(900);
     const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent && e.getDomNode().closest('[data-script-editor]'));
     if (!ed) return converted + ' | NO EDITOR';
     const code = ed.getValue();
     return converted + ' | editor has tp.test: ' + code.includes('tp.test(') + ' | pm.: ' + /\\bpm\\./.test(code);`,
  ),
  step('insomnia-file', importVia('Choose file…', fixtureFiles('insomnia')) + runIt),
  step('bruno-folder', importVia('Bruno folder…', brunoFiles, 'vet-clinic') + runIt),
];

module.exports = withExpect(steps, {
  'postman-file': /^collection: Vet clinic \(Postman sample\) \| requests: 3 \| with scripts: 3 \| run: 3 passed, 0 failed, 0 errors \| script tests: ✓a list of patients, ✓logged in, ✓the pre-request value was sent$/,
  'postman-scripts-tp': /^Converted [1-9]\d* scripts? to tp\.\* \| editor has tp\.test: true \| pm\.: false$/,
  'insomnia-file': /^collection: Vet clinic \(Insomnia sample\) \| requests: 3 \| with scripts: 3 \| run: 3 passed, 0 failed, 0 errors \| script tests: ✓a list of patients, ✓logged in, ✓the pre-request value was sent$/,
  'bruno-folder': /^collection: Vet clinic \(Bruno sample\) \| requests: 3 \| with scripts: 3 \| run: 3 passed, 0 failed, 0 errors \| script tests: ✓a list of patients, ✓logged in, ✓the pre-request value was sent$/,
});
