// Importing an OpenAPI document whose name is taken by a different one (EX-G3): both are kept, the new one as `-2`, and
// the message offers "Replace instead"; Replace puts the new document in the old one's place and the old one goes to
// Recently deleted (listed there as an API definition). The same document imported again reuses its file.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step, OPEN_RECENTLY_DELETED } = require('../lib.cjs');

const doc = (version, path) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'E2E Keep Both', version },
    servers: [{ url: 'http://127.0.0.1:4010' }],
    paths: { [path]: { get: { operationId: path.replace(/\W/g, '') || 'root', responses: { 200: { description: 'ok' } } } } },
  });
const FIRST = doc('1.0.0', '/health');
const SECOND = doc('2.0.0', '/pets');

const H = `
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const toastButton = (re, label) => [...document.querySelectorAll('[data-sonner-toast]')].find((t) => re.test(t.textContent))?.querySelectorAll('button') ?? [];
  const specs = async () => (await window.aps.invoke('openapi.specs')).map((s) => (typeof s === 'string' ? s : s.path)).filter((p) => /e2e-keep-both/.test(p)).sort().join(',');
  /** Import a file through Import ▸ Choose file… as a user picks one. */
  const importText = async (text) => {
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return orig.call(this);
      HTMLInputElement.prototype.click = orig;
      Object.defineProperty(this, 'files', { value: [new File([text], 'keep-both.json', { type: 'application/json' })], configurable: true });
      this.dispatchEvent(new Event('change'));
    };
    await __t.requests();
    await __t.real.click('[aria-label^="Import (OpenAPI"]');
    const btn = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Choose file…'), 3000);
    if (!btn) return false;
    await __t.real.click(btn);
    return true;
  };
`;
const s = (name, body) => step(name, body, true, { extra: H + OPEN_RECENTLY_DELETED, short: 600 });

const steps = [
  s(
    'first-import',
    `if (!(await importText(${JSON.stringify(FIRST)}))) return 'NO IMPORT BUTTON';
     await __t.waitFor(() => toastText(/Imported/), 6000); await __t.sleep(500); await __t.esc();
     return 'specs: ' + (await specs());`,
  ),
  s(
    'same-name-different-document-keeps-both',
    `for (const t of document.querySelectorAll('[data-sonner-toast] [aria-label="Close toast"]')) t.click();
     if (!(await importText(${JSON.stringify(SECOND)}))) return 'NO IMPORT BUTTON';
     const t = await __t.waitFor(() => toastText(/^Saved as specs\\//), 6000); await __t.sleep(400);
     const action = [...toastButton(/^Saved as specs\\//)].map((b) => b.textContent.trim()).filter((x) => x && x !== '×');
     await __t.esc();
     return 'message: ' + (t ? t.replace(/Replace instead.*$/, '').trim() : 'NONE') + ' | action: ' + action.join(',') + ' | specs: ' + (await specs());`,
  ),
  s(
    'replace-instead-moves-the-old-to-recently-deleted',
    `const b = [...toastButton(/^Saved as specs\\//)].find((x) => x.textContent.trim() === 'Replace instead'); if (!b) return 'NO REPLACE BUTTON';
     await __t.real.click(b);
     const done = await __t.waitFor(() => toastText(/^Replaced specs\\//), 5000);
     const list = await specs();
     const path = list.split(',')[0];
     const got = await window.aps.invoke('openapi.spec.get', { path }).catch((e) => ({ text: 'ERR ' + e.message }));
     const version = /"version":"([^"]+)"/.exec(got.text)?.[1] ?? got.text.slice(0, 80);
     const dlg = await openRecentlyDeleted(); if (typeof dlg === 'string') return dlg;
     const li = await __t.waitFor(() => [...dlg.querySelectorAll('li')].find((x) => /e2e-keep-both/.test(x.textContent)), 3000);
     const line = li?.querySelector('.text-xs')?.textContent.trim().replace(/ KB.*$/, ' KB');
     await __t.esc();
     return 'message: ' + (done ?? 'NONE') + ' | specs: ' + list + ' | there now: ' + version + ' | in Recently deleted: ' + (li ? li.querySelector('.font-medium')?.textContent.trim() + ' (' + line + ')' : 'NO');`,
  ),
];

module.exports = withExpect(steps, {
  'first-import': /^specs: specs\/e2e-keep-both\.openapi\.json$/,
  'same-name-different-document-keeps-both':
    /^message: Saved as specs\/e2e-keep-both-2\.openapi\.json: specs\/e2e-keep-both\.openapi\.json holds a different document and was kept \| action: Replace instead \| specs: specs\/e2e-keep-both-2\.openapi\.json,specs\/e2e-keep-both\.openapi\.json$/,
  'replace-instead-moves-the-old-to-recently-deleted':
    /^message: Replaced specs\/e2e-keep-both\.openapi\.json; the earlier document is in Recently deleted \(30 days\) \| specs: specs\/e2e-keep-both\.openapi\.json \| there now: 2\.0\.0 \| in Recently deleted: e2e-keep-both\.openapi\.json \(API definition · [\d.]+ KB\)$/,
});
