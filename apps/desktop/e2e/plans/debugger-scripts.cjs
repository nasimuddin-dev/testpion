// JavaScript rule scripts (0.60, FG-21): the Modify panel's New rule menu offers "Run a script", the editor shows the script editor with
// a Test button that runs both hooks on a captured exchange and says what the script would do, a script that fails shows its message,
// a script with neither hook is refused with the reason, and a saved script rule is described in the list. The engine (sandbox limits,
// header and body edits, replies, fail-open) is covered by tests/unit/debugger-script-rules.test.ts.
// Loads a mock HAR (no network). Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const HAR = `(() => {
  const h = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: [{
    startedDateTime: new Date(Date.now() - 60000).toISOString(), time: 25,
    request: { method: 'GET', url: 'https://scripts.example.test/orders/7', httpVersion: 'HTTP/1.1', headers: h({ accept: 'application/json' }), cookies: [], queryString: [], headersSize: -1, bodySize: 0 },
    response: { status: 500, statusText: 'Server Error', httpVersion: 'HTTP/1.1', headers: h({ 'content-type': 'application/json' }), cookies: [], content: { size: 12, mimeType: 'application/json', text: '{"ok":false}' }, redirectURL: '', headersSize: -1, bodySize: 12 },
    cache: {}, timings: { send: 1, wait: 20, receive: 4 }, _testpion: { id: 'sc1', kind: 'http' },
  }] } });
})()`;

const H = `
  const items = () => [...document.querySelectorAll('[role=menuitem]')].filter((m) => m.offsetParent);
  const pick = async (re) => { const it = await __t.waitFor(() => items().find((m) => re.test(m.textContent)), 3000); if (!it) return false; await __t.real.click(it); await __t.sleep(400); return true; };
  const dialog = () => document.querySelector('[role=dialog]');
  const mine = async () => (await window.aps.invoke('debug.rules')).rules.filter((r) => /^e2e script /.test(r.name));
  const save = async (rule) => { try { await window.aps.invoke('debug.saveRule', { rule }); return 'SAVED'; } catch (e) { return e.message; } };
`;
const step = stepOf(H);

const steps = [
  step(
    'load-a-session-with-one-exchange',
    `await __t.view('Debugger'); await __t.sleep(500);
     const r = await window.aps.invoke('debug.openSession', { text: ${HAR} });
     return 'loaded: ' + r.loaded;`,
  ),
  step(
    'new-rule-menu-offers-run-a-script-and-the-editor-opens',
    `for (const r of (await mine())) await window.aps.invoke('debug.deleteRule', { id: r.id });
     const rail = document.querySelector('[data-tool-rail] button[aria-label="Modify"]'); if (!rail) return 'NO MODIFY RAIL';
     await __t.real.click(rail);
     await pick(/Modify headers/);
     const add = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Add' && b.closest('[data-rule-list]')), 4000); if (!add) return 'NO ADD';
     await __t.real.click(add);
     const menu = (await __t.waitFor(() => (items().length ? items() : null), 3000) ?? []).map((m) => m.textContent.trim());
     if (!(await pick(/^Run a script$/))) return 'NO SCRIPT ITEM: ' + menu.join(',');
     const d = await __t.waitFor(() => dialog(), 3000); if (!d) return 'NO DIALOG';
     const editor = await __t.waitFor(() => d.querySelector('[data-rule-script-editor]'), 5000);
     return 'kind: ' + d.querySelector('select').value + ' | editor: ' + !!editor + ' | limit field: ' + /Time a hook may run/.test(d.textContent) + ' | file switch: ' + /Use a file instead/.test(d.textContent);`,
  ),
  step(
    'test-button-runs-both-hooks-on-a-captured-exchange',
    `const d = dialog(); if (!d) return 'NO DIALOG';
     const btn = await __t.waitFor(() => { const b = d.querySelector('[data-script-test]'); return b && !b.disabled ? b : null; }, 5000); if (!btn) return 'TEST DISABLED';
     btn.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(btn);
     const res = await __t.waitFor(() => d.querySelector('[data-script-result]'), 15000); if (!res) return 'NO RESULT';
     const phases = [...res.querySelectorAll('[data-script-phase]')].map((p) => p.getAttribute('data-script-phase') + ': ' + (/failed/.test(p.textContent) ? 'failed' : /changes nothing/.test(p.textContent) ? 'nothing' : 'something'));
     const cancel = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancel'); await __t.real.click(cancel); await __t.sleep(200);
     return phases.join(' | ') + ' | closed: ' + !dialog();`,
  ),
  step(
    'a-script-with-neither-hook-is-refused-with-the-reason',
    `return (await save({ kind: 'script', name: 'e2e script none', match: {}, script: { code: 'const a = 1;' } })).slice(0, 70);`,
  ),
  step(
    'a-saved-script-rule-is-described-and-tested-through-the-engine',
    `const code = "function onRequest(ctx) { ctx.request.headers['x-env'] = 'staging'; console.log('hello'); }\\nfunction onResponse(ctx) { if (ctx.response.status === 500) ctx.response.status = 503; }";
     const saved = await save({ kind: 'script', name: 'e2e script patch', match: { host: 'scripts.example.test' }, script: { code } });
     const rule = (await mine())[0];
     const t = await window.aps.invoke('debug.testScript', { rule: { ...rule }, id: 'sc1' });
     return saved + ' | summary: ' + rule?.summary + ' | matches: ' + t.matches + ' | ' + t.phases.map((p) => p.phase + ': ' + p.does.join('; ') + ' [' + p.logs.join(',') + ']').join(' | ');`,
  ),
  step(
    'a-script-that-fails-says-so-and-names-the-error',
    `const t = await window.aps.invoke('debug.testScript', { rule: { kind: 'script', name: 'e2e script bad', match: {}, script: { code: 'function onRequest(ctx) { missing(); }' } }, id: 'sc1' });
     const p = t.phases[0];
     return 'ok: ' + t.ok + ' | error: ' + /missing/.test(p.error ?? '') + ' | response hook still reported: ' + (t.phases[1]?.noHook === true);`,
  ),
  step(
    'rule-list-shows-the-script-rule',
    `const rail = document.querySelector('[data-tool-rail] button[aria-label="Modify"]'); await __t.real.click(rail); await __t.sleep(500);
     const list = document.querySelector('main [data-rule-list*=script]'); if (!list) return 'NO LIST';
     const row = await __t.waitFor(() => [...list.querySelectorAll('*')].find((x) => x.textContent.includes('e2e script patch') && x.children.length < 6), 4000);
     return 'row: ' + !!row + ' | says: ' + /Run a script on scripts\\.example\\.test/.test(list.textContent);`,
  ),
  step(
    'clean-up',
    `for (const r of (await mine())) await window.aps.invoke('debug.deleteRule', { id: r.id });
     return 'left: ' + (await mine()).length;`,
  ),
];

module.exports = withExpect(steps, {
  'load-a-session-with-one-exchange': /^loaded: 1$/,
  'new-rule-menu-offers-run-a-script-and-the-editor-opens': /^kind: script \| editor: true \| limit field: true \| file switch: true$/,
  'test-button-runs-both-hooks-on-a-captured-exchange': /^request: nothing \| response: nothing \| closed: true$/,
  'a-script-with-neither-hook-is-refused-with-the-reason': /^The script defines neither onRequest/,
  'a-saved-script-rule-is-described-and-tested-through-the-engine': /^SAVED \| summary: Run a script on scripts\.example\.test \| matches: true \| request: sets the request header x-env: staging \[hello\] \| response: changes the response status to 503 \[\]$/,
  'a-script-that-fails-says-so-and-names-the-error': /^ok: false \| error: true \| response hook still reported: true$/,
  'rule-list-shows-the-script-rule': /^row: true \| says: true$/,
  'clean-up': /^left: 0$/,
});
