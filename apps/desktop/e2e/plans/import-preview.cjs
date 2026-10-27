// Import compatibility, release A (B-23): the Import dialog previews before it writes (the tree of what will be created
// and the compatibility report), imports, and Undo takes it back; files and folders dropped on the window from the OS
// open the same dialog (real input: __t.real.dropFiles sends the drag events with file paths, as the file manager's
// drag does); Home's "Migrate from…" opens it with how to export from each tool.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { withExpect } = require('../lib.cjs');

// where the "files from the OS" are: made by prepare, before the app starts (a fixed folder: the runner and the harness load this plan in different processes)
const DROP = join(tmpdir(), `tp-e2e-import-drop`);
const POSTMAN = {
  info: { _postman_id: 'e2e-drop', name: 'Dropped sample', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    { name: 'Patients', item: [{ name: 'List', request: { method: 'GET', url: 'http://127.0.0.1:4010/health', auth: { type: 'asap', asap: [] } }, event: [{ listen: 'test', script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));"] } }] }] },
    { name: 'Health', request: { method: 'GET', url: 'http://127.0.0.1:4010/health' } },
  ],
};
const BRU = 'meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: http://127.0.0.1:4010/health\n  body: none\n  auth: none\n}\n';

function prepare() {
  mkdirSync(join(DROP, 'bruno-drop'), { recursive: true });
  writeFileSync(join(DROP, 'dropped.postman_collection.json'), JSON.stringify(POSTMAN));
  writeFileSync(join(DROP, 'bruno-drop', 'bruno.json'), JSON.stringify({ name: 'Dropped Bruno', version: '1' }));
  writeFileSync(join(DROP, 'bruno-drop', 'Ping.bru'), BRU);
}

const dialog = () => `const dlg = () => document.querySelector('[role=dialog]');
  const btn = (re) => [...document.querySelectorAll('[role=dialog] button')].find((b) => re.test(b.textContent.trim()) && b.getClientRects().length);
  const names = async () => (await window.aps.invoke('col.list')).map((c) => c.name);`;
const step = (name, body) => [name, `(async () => { ${dialog()} ${body} })()`];

const steps = [
  // every step of the dialog can be left; the common path (choose files) is the primary button; the busy line is announced
  step(
    'the-source-step-has-cancel-and-a-primary',
    `await __t.requests();
     document.querySelector('[aria-label^="Import (OpenAPI"]').click();
     const choose = await __t.waitFor(() => btn(/^Choose files/), 3000); if (!choose) return 'NO DIALOG';
     const cancel = btn(/^Cancel$/);
     const primary = choose.className.includes('primary-gradient') && !btn(/^Preview pasted/)?.className.includes('primary-gradient');
     const migrate = !!dlg().querySelector('[data-import-migrate]');
     if (!cancel) return 'NO BUTTON Cancel';
     await __t.real.click(cancel);
     const closed = await __t.waitFor(() => !dlg(), 3000);
     return 'cancel: true | choose files is the primary: ' + primary + ' | coming-from-another-tool link: ' + migrate + ' | closed by cancel: ' + !!closed;`,
  ),
  step(
    'preview-writes-nothing',
    `await __t.requests();
     const orig = HTMLInputElement.prototype.click;
     HTMLInputElement.prototype.click = function () {
       if (this.type !== 'file') return orig.call(this);
       HTMLInputElement.prototype.click = orig;
       Object.defineProperty(this, 'files', { value: [new File([${JSON.stringify(JSON.stringify(POSTMAN))}], 'sample.postman_collection.json', { type: 'application/json' })], configurable: true });
       this.dispatchEvent(new Event('change'));
     };
     const before = await names();
     document.querySelector('[aria-label^="Import (OpenAPI"]').click();
     (await __t.waitFor(() => btn(/^Choose files/), 3000)).click();
     const plan = await __t.waitFor(() => document.querySelector('[data-import-plan]'), 8000);
     if (!plan) return 'NO PREVIEW';
     const rows = [...plan.querySelectorAll('[data-import-node]')].map((n) => n.textContent.trim().replace(/\\s+/g, ' '));
     const groups = [...plan.querySelectorAll('[data-import-group]')].map((g) => g.getAttribute('data-import-group'));
     const after = await names();
     return 'title: ' + dlg().querySelector('h2,[role=heading]')?.textContent.trim() + ' | nodes: ' + rows.length + ' | changed marks: ' + plan.querySelectorAll('[data-import-node=changed]').length + ' | groups: ' + groups.join(',') + ' | written: ' + (after.length !== before.length) + ' | button: ' + btn(/^Import/)?.textContent.trim();`,
  ),
  step(
    'import-then-undo',
    `const before = await names();
     btn(/^Import$/).click();
     await __t.waitFor(() => document.querySelector('[data-import-done]'), 8000);
     const added = (await names()).filter((n) => !before.includes(n));
     const report = document.querySelector('[data-import-done] [data-import-summary]')?.textContent.replace(/\\s+/g, ' ').trim();
     const undo = btn(/^Undo import$/);
     if (!undo) return 'NO BUTTON Undo import';
     await __t.real.click(undo);
     await __t.waitFor(() => /Undone/.test(document.querySelector('[data-import-done]')?.textContent ?? ''), 5000);
     const gone = (await names()).filter((n) => added.includes(n));
     return 'added: ' + added.join(',') + ' | report: ' + report + ' | after undo still there: ' + gone.length + ' | undone text: ' + /Recently deleted/.test(document.querySelector('[data-import-done]')?.textContent ?? '');`,
  ),
  step(
    'drop-a-file-from-the-os',
    `await __t.esc();
     const before = await names();
     const r = await __t.real.dropFiles('main', [${JSON.stringify(join(DROP, 'dropped.postman_collection.json'))}], { over: [{ x: 400, y: 300 }] });
     if (r !== 'ok') return r;
     const plan = await __t.waitFor(() => document.querySelector('[data-import-plan]'), 8000);
     if (!plan) return 'NO DIALOG after the drop';
     const text = plan.textContent.replace(/\\s+/g, ' ');
     const overlay = !!document.querySelector('[data-import-drop-overlay]');
     btn(/^Import$/).click();
     await __t.waitFor(() => document.querySelector('[data-import-done]'), 8000);
     await __t.esc();
     const added = (await names()).filter((n) => !before.includes(n));
     return 'plan names the collection: ' + /Dropped sample/.test(text) + ' | overlay gone: ' + !overlay + ' | added: ' + added.join(',');`,
  ),
  step(
    'import-again-updates',
    `const before = await names();
     const r = await __t.real.dropFiles('main', [${JSON.stringify(join(DROP, 'dropped.postman_collection.json'))}]);
     if (r !== 'ok') return r;
     const plan = await __t.waitFor(() => document.querySelector('[data-import-plan]'), 8000);
     if (!plan) return 'NO DIALOG after the drop';
     const upd = document.querySelector('[data-import-update]');
     const said = !!upd && /imported before/.test(upd.textContent);
     btn(/^Import$/).click();
     await __t.waitFor(() => document.querySelector('[data-import-done]'), 8000);
     const updated = document.querySelector('[data-import-updated]')?.textContent.replace(/\\s+/g, ' ').trim();
     await __t.esc();
     const after = await names();
     return 'update offered: ' + said + ' | result: ' + /^Updated Dropped sample: \\d+ replaced, \\d+ added, \\d+ left as they are\\.$/.test(updated ?? '') + ' | no second collection: ' + (after.length === before.length);`,
  ),
  step(
    'drop-a-folder-from-the-os',
    `const before = await names();
     const r = await __t.real.dropFiles('main', [${JSON.stringify(join(DROP, 'bruno-drop'))}]);
     if (r !== 'ok') return r;
     const plan = await __t.waitFor(() => document.querySelector('[data-import-plan]'), 8000);
     if (!plan) return 'NO DIALOG after the drop';
     const text = plan.textContent.replace(/\\s+/g, ' ');
     btn(/^Import$/).click();
     await __t.waitFor(() => document.querySelector('[data-import-done]'), 8000);
     await __t.esc();
     const added = (await names()).filter((n) => !before.includes(n));
     return 'plan: ' + /collection "Dropped Bruno": 1 request/.test(text) + ' | added: ' + added.join(',');`,
  ),
  step(
    'drag-of-something-else-is-left-alone',
    `await __t.esc();
     const r = await __t.real.dropFiles('main', []);
     await __t.sleep(400);
     return 'dialog opened: ' + !!dlg();`,
  ),
  step(
    'migrate-from-on-home',
    `await __t.esc();
     await __t.view('Home');
     const card = [...document.querySelectorAll('main button, main [role=button], main a')].find((b) => b.textContent.includes('Migrate from…') && b.getClientRects().length);
     if (!card) return 'NO BUTTON Migrate from…';
     await __t.real.click(card);
     await __t.waitFor(() => dlg(), 3000);
     const title = dlg()?.textContent.slice(0, 40);
     const tools = [...dlg().querySelectorAll('[aria-label="Migrate from"] button')].map((b) => b.textContent.trim());
     (await __t.waitFor(() => [...dlg().querySelectorAll('[aria-label="Migrate from"] button')].find((b) => b.textContent.trim() === 'Bruno'), 2000)).click();
     await __t.sleep(300);
     const how = /bruno\\.json/.test(dlg().textContent);
     await __t.esc();
     return 'tools: ' + tools.join(',') + ' | bruno guide: ' + how + ' | title: ' + /Migrate from/.test(title);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'the-source-step-has-cancel-and-a-primary': /^cancel: true \| choose files is the primary: true \| coming-from-another-tool link: true \| closed by cancel: true$/,
    'preview-writes-nothing': /^title: Import: preview \| nodes: [3-9] \| changed marks: [1-9] \| groups: [A-Z_,]*AUTH_UNSUPPORTED[A-Z_,]* \| written: false \| button: Import$/,
    'import-then-undo': /^added: Dropped sample \| report: .*2 requests in 1 folder.* \| after undo still there: 0 \| undone text: true$/,
    'drop-a-file-from-the-os': /^plan names the collection: true \| overlay gone: true \| added: Dropped sample$/,
    'import-again-updates': /^update offered: true \| result: true \| no second collection: true$/,
    'drop-a-folder-from-the-os': /^plan: true \| added: Dropped Bruno$/,
    'drag-of-something-else-is-left-alone': /^dialog opened: false$/,
    'migrate-from-on-home': /^tools: Postman,Insomnia,Bruno,Hoppscotch,Thunder Client,Yaak,HTTPie,Apidog,Another tool \| bruno guide: true \| title: true$/,
  },
  { prepare },
);
