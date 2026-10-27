// The finishing touches of Settings and the request tabs: the scope line under each tab, the search box that jumps to a
// tab, Export / Import / Reset in About, Ctrl+T as a window command, the question before a data-changing request goes out
// with a variable that has no value, and the Save dialog's default collection.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const scope = () => document.querySelector('[data-settings-scope]')?.textContent.trim();
  const tabs = () => vis('[role=tab]').filter((t) => !t.closest('header, nav')).length;
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'scope-lines',
    `await __t.view('Settings'); await __t.tab('Appearance'); await __t.sleep(300);
     const a = scope(); await __t.tab('Storage'); await __t.sleep(300); const st = scope();
     return a + ' || ' + st;`,
  ),
  s(
    'search-jumps-to-the-tab',
    `await __t.tab('Appearance');
     const box = vis('input[aria-label="Search settings"]')[0]; if (!box) return 'NO INPUT';
     setVal(box, 'timeout'); await __t.sleep(300);
     const row = vis('[role=option] button')[0]; if (!row) return 'NO ROW';
     const label = row.textContent.trim(); await __t.real.click(row); await __t.sleep(400);
     return label + ' || field: ' + !!vis('input[placeholder="30000"]')[0] + ' | box cleared: ' + (vis('input[aria-label="Search settings"]')[0]?.value === '');`,
  ),
  s(
    'ask-before-sending-toggle',
    `await __t.tab('Requests');
     const t = vis('label, [role=switch], button').find((x) => /Ask before sending a request that changes data/.test(x.textContent + (x.getAttribute('aria-label') ?? '')));
     return 'toggle: ' + !!t + ' | default on: ' + ((await window.aps.invoke('settings.get')).confirmUnresolvedSend !== false);`,
  ),
  s(
    'about-export-import-reset',
    `await __t.tab('About'); await __t.sleep(300);
     const names = vis('[data-settings-transfer] button').map((b) => b.textContent.trim().replace(/\\s+/g, ' ')).join(' | ');
     const doc = await window.aps.invoke('settings.export');
     await window.aps.invoke('settings.import', { doc: { ...doc, settings: { ...doc.settings, density: 'compact' } } });
     const after = (await window.aps.invoke('settings.get')).density;
     await window.aps.invoke('settings.reset', { keys: ['density'] });
     return names + ' || exported: ' + doc.format + ' | imported density: ' + after + ' | reset: ' + String((await window.aps.invoke('settings.get')).density);`,
  ),
  s(
    'ctrl-t-opens-a-request-tab',
    `await __t.view('Collections'); await __t.sleep(600);
     const before = tabs();
     await __t.real.key('t', { ctrl: true }); await __t.sleep(700);
     return 'tabs ' + before + ' -> ' + tabs() + ' | url field focus: ' + (document.activeElement?.getAttribute('aria-label') === 'Request URL');`,
  ),
  s(
    'unresolved-variable-asks-first',
    `const url = vis('input[aria-label="Request URL"]')[0]; if (!url) return 'NO INPUT';
     const method = vis('[aria-label="HTTP method"]')[0] ?? vis('select').find((x) => [...x.options].some((o) => o.value === 'POST'));
     if (method) { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(method, 'POST'); method.dispatchEvent(new Event('change', { bubbles: true })); }
     setVal(url, 'http://127.0.0.1:4010/echo/{{noSuchVariable}}'); await __t.sleep(300);
     const send = vis('button').find((b) => b.textContent.trim() === 'Send'); if (!send) return 'NO BUTTON';
     send.click(); await __t.sleep(900);
     const dlg = vis('[role=dialog]')[0]; const text = dlg?.innerText.replace(/\\s+/g, ' ') ?? 'NO DIALOG';
     const cancel = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Cancel'); cancel?.click(); await __t.sleep(300);
     return text.slice(0, 160) + ' || closed: ' + !vis('[role=dialog]')[0];`,
  ),
];

module.exports = withExpect(steps, {
  'scope-lines': /^Applies to: all workspaces on this computer\. \|\| Applies to: this workspace/,
  'search-jumps-to-the-tab': /^Default timeout \(ms\)\s*Requests \|\| field: true \| box cleared: true$/,
  'ask-before-sending-toggle': /^toggle: true \| default on: true$/,
  'about-export-import-reset': /^Export.*Import settings….*Reset settings… \|\| exported: testpion-settings \| imported density: compact \| reset: (undefined|comfortable)$/,
  'ctrl-t-opens-a-request-tab': /^tabs \d+ -> \d+ \| url field focus: true$/,
  'unresolved-variable-asks-first': /^Send with 1 variable that has no value\?.*noSuchVariable.* \|\| closed: true$/,
});
