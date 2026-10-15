// WF-07 Save as test, the same action everywhere (a request's and a folder's menu in Collections, the request editor's
// ⋯ next to its breadcrumb, History's right-click menu), and WF-04: the toast after saving has Run now and Open test
// file, and a failing monitor's toast opens its run.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

/** A collection whose request cannot connect, for a monitor that fails. */
function prepare(ws) {
  const items = [{ kind: 'http', id: 'down-1', name: 'Down', request: { method: 'GET', url: 'http://127.0.0.1:9/down', headers: [] } }];
  writeFileSync(
    join(ws, 'collections', 'e2e-down.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-down', name: 'E2E down', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const items = () => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.textContent.trim());
  const rightClick = async (text) => {
    await __t.esc();
    const r = [...document.querySelectorAll('button[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().replace(/\\d+$/, '').endsWith(text));
    if (!r) return false;
    r.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    return !!(await __t.waitFor(() => document.querySelector('[role=menu]'), 2000));
  };
  const pick = (label) => [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((m) => m.textContent.trim() === label);
  // the name prompt: type a name, Save; then the toast
  const nameAndSave = async (name) => {
    const d = await __t.waitFor(() => vis('[role=dialog], [role=alertdialog]').find((x) => x.querySelector('input, textarea')), 3000);
    if (!d) return 'NO DIALOG';
    const input = d.querySelector('input, textarea');
    setVal(input, name);
    [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save')?.click();
    // this save's toast (an earlier one may still be up): it names the file, the name as a slug
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const t = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].find((x) => x.textContent.includes('Saved tests/') && x.textContent.includes(slug)), 6000);
    if (!t) return 'NO TOAST';
    return short(t.querySelector('[data-title]')?.textContent ?? t.textContent, 120) + ' | buttons: ' + [...t.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' / ');
  };
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });

const steps = [
  s(
    'request-menu',
    `await __t.requests(); await __t.expand('HTTP basics'); await __t.expand('Requests & responses');
     if (!(await rightClick('Custom headers'))) return 'NO MENU';
     const all = items();
     pick('Save as test…')?.click();
     return 'has: ' + all.includes('Save as test…') + ' | ' + (await nameAndSave('E2E custom headers'));`,
  ),
  s(
    'open-test-file',
    `const t = [...document.querySelectorAll('[data-sonner-toast]')].reverse().find((x) => /Saved tests\\//.test(x.textContent));
     const b = t && [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Open test file');
     if (!b) return 'NO BUTTON Open test file';
     b.click();
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'tests' && /e2e-custom-headers/.test(document.querySelector('main')?.innerText ?? ''), 6000);
     return 'view: ' + localStorage.getItem('aps.view') + ' | shows the file: ' + /e2e-custom-headers/.test(document.querySelector('main')?.innerText ?? '');`,
  ),
  s(
    'folder-menu',
    `await __t.requests(); await __t.expand('HTTP basics');
     if (!(await rightClick('Requests & responses'))) return 'NO MENU';
     pick('Create test file from folder…')?.click();
     return await nameAndSave('E2E requests and responses');`,
  ),
  s(
    'editor-menu',
    `await __t.requests();
     const r = await __t.find('Custom headers'); if (r !== 'ok') return r;
     const more = await __t.waitFor(() => vis('main [aria-label="More actions for Custom headers"]')[0], 4000);
     if (!more) return 'NO BUTTON ⋯';
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
     await __t.waitFor(() => document.querySelector('[role=menu]'), 2000);
     const all = items();
     pick('Save as test…')?.click();
     return 'menu: ' + all.join(' | ') + ' | ' + (await nameAndSave('E2E from the editor'));`,
  ),
  s(
    'history-menu',
    `await window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:4010/health', headers: [] }, name: 'E2E history entry' }).catch(() => undefined);
     await __t.view('History'); await __t.sleep(800);
     const row = await __t.waitFor(() => vis('main button').find((b) => /127\\.0\\.0\\.1:4010\\/health/.test(b.textContent)), 5000);
     if (!row) return 'NO ROW';
     row.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
     await __t.waitFor(() => document.querySelector('[role=menu]'), 2000);
     const all = items();
     pick('Save as test…')?.click();
     return 'menu: ' + all.join(' | ') + ' | ' + (await nameAndSave('E2E from history'));`,
  ),
  s(
    'monitor-toast-opens-run',
    `await __t.esc();
     const m = await window.aps.invoke('monitor.save', { monitor: { name: 'E2E down monitor', collectionId: 'e2e-down', everyMinutes: 60, enabled: false } });
     await window.aps.invoke('monitor.run', { id: m.id }).catch(() => undefined);
     const t = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].find((x) => /E2E down monitor/.test(x.textContent)), 8000);
     if (!t) return 'NO TOAST';
     const b = [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Open run');
     const text = short(t.textContent, 80);
     b?.click();
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'tests', 5000);
     return text + ' | button: ' + (b ? 'Open run' : 'none') + ' | view: ' + localStorage.getItem('aps.view');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'request-menu': /^has: true \| Saved tests\/rest\/e2e-custom-headers\.yaml.* \| buttons: (Open test file \/ Run now|Run now \/ Open test file)$/,
    'open-test-file': /^view: tests \| shows the file: true$/,
    'folder-menu': /^Saved tests\/http-basics[\w-]*\/e2e-requests-and-responses\.yaml \(\d+ tests\) \| buttons: (Open test file \/ Run now|Run now \/ Open test file)$/,
    'editor-menu': /^menu: Save as test… \| Saved tests\/rest\/e2e-from-the-editor\.yaml/,
    'history-menu': /^menu: Open \| (Open request \| )?Open trace \| Save as test… \| Delete… \| Saved tests\/rest\/e2e-from-history\.yaml/,
    'monitor-toast-opens-run': /^Monitor "E2E down monitor" .* \| button: Open run \| view: tests$/,
  },
  { prepare },
);
