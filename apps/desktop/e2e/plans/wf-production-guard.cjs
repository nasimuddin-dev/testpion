// WF-06: one production guard for every send and run path. With an environment marked as production active, the window
// wears a thin frame in the production colour; a POST asks first (Cancel: nothing is sent; Send: it is), a GET does
// not ask, a GraphQL mutation asks the same way ("Send and don't ask again" lasts for the session), and a collection run
// asks once for the whole run, saying how many of its requests change data. The question comes from the backend's
// refusal, answered by the window's one shared confirm, so every view asks the same way.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

const PORT = 47331;

/** A production environment and a collection with a POST, a GET and a GraphQL mutation against this plan's server. */
function prepare(ws) {
  writeFileSync(
    join(ws, 'environments', 'e2e-prod.json'),
    JSON.stringify({ id: 'e2e-prod', name: 'E2E Production', isProduction: true, variables: [{ key: 'prodBase', value: `http://127.0.0.1:${PORT}`, enabled: true }] }, null, 2),
  );
  const items = [
    { kind: 'http', id: 'g-create', name: 'E2E create', request: { method: 'POST', url: '{{prodBase}}/create', headers: [], body: { type: 'json', content: '{"a":1}' } } },
    { kind: 'http', id: 'g-list', name: 'E2E list', request: { method: 'GET', url: '{{prodBase}}/list', headers: [] } },
    { kind: 'graphql', id: 'g-mutate', name: 'E2E mutate', request: { endpoint: '{{prodBase}}/graphql', query: 'mutation { add }', headers: [] } },
  ];
  writeFileSync(
    join(ws, 'collections', 'e2e-guard.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-guard', name: 'E2E Guard', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}
const H = `
  const dialog = (title) => vis('[role=dialog], [role=alertdialog]').find((d) => d.textContent.includes(title));
  const answer = async (title, label) => {
    const d = await __t.waitFor(() => dialog(title), 4000);
    if (!d) return 'NO DIALOG ' + title;
    const text = short(d.innerText, 400);
    const buttons = [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
    [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === label)?.click();
    await __t.sleep(600);
    return text + ' | buttons: ' + buttons.join(' / ');
  };
  const send = async (name, label = 'Send') => {
    await __t.requests();
    const r = await __t.find(name);
    if (r !== 'ok') return r;
    const b = await __t.waitFor(() => button(label) && !button(label).disabled && button(label), 6000);
    if (!b) return 'NO BUTTON ' + label;
    b.click();
    return 'ok';
  };
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });
const hits = (label) => [label, `main: const h = globalThis.__prodHits ?? []; const out = '${label}: ' + (h.join(', ') || 'none'); globalThis.__prodHits = []; return out;`, false];

const steps = [
  [
    'server',
    `main:
      const http = require('node:http');
      globalThis.__prodHits = [];
      if (globalThis.__prodServer) return 'listening';
      globalThis.__prodServer = http.createServer((req, res) => { req.resume(); req.on('end', () => { globalThis.__prodHits.push(req.method + ' ' + req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { ok: true } })); }); });
      await new Promise((ok, fail) => globalThis.__prodServer.listen(${PORT}, '127.0.0.1', ok).on('error', fail));
      globalThis.__prodServer.unref();
      return 'listening';`,
    false,
  ],
  s(
    'production-active',
    `const picker = document.querySelector('header button[aria-label="Environment"]');
     picker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); picker.click();
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('E2E Production')), 3000);
     if (!item) return 'NO MENU ITEM E2E Production';
     item.click(); await __t.sleep(800);
     const frame = document.querySelector('[data-testid="production-frame"]');
     return 'active: ' + short(picker.textContent) + ' | frame: ' + !!frame + ' | covers window: ' + (frame ? getComputedStyle(frame).position + ' ' + getComputedStyle(frame).pointerEvents : '-');`,
  ),
  s(
    'post-asks-cancel',
    `const r = await send('E2E create'); if (r !== 'ok') return r;
     return await answer('Send to E2E Production?', 'Cancel');`,
  ),
  hits('after-cancel'),
  s(
    'post-asks-send',
    `const r = await send('E2E create'); if (r !== 'ok') return r;
     const a = await answer('Send to E2E Production?', 'Send');
     const status = await __t.waitFor(() => /\\b200\\b/.test(document.querySelector('main')?.innerText ?? '') && '200', 8000);
     return (a.startsWith('NO ') ? a : 'answered') + ' | response: ' + (status ?? 'none');`,
  ),
  hits('after-send'),
  s(
    'get-does-not-ask',
    `const r = await send('E2E list'); if (r !== 'ok') return r;
     await __t.sleep(2000);
     return 'dialog: ' + !!dialog('E2E Production?');`,
  ),
  hits('after-get'),
  s(
    'mutation-asks-once',
    `const r = await send('E2E mutate', 'Run'); if (r !== 'ok') return r;
     const a = await answer('Send to E2E Production?', "Send and don't ask again");
     await __t.sleep(1500);
     const b = await __t.waitFor(() => button('Run') && !button('Run').disabled && button('Run'), 6000);
     b?.click();
     await __t.sleep(1500);
     return (a.startsWith('NO ') ? a : 'asked: ' + /may change real data/.test(a)) + ' | asked again: ' + !!dialog('E2E Production?');`,
  ),
  hits('after-mutations'),
  s(
    'run-asks-once',
    `await __t.requests();
     const items = await __t.menu('E2E Guard');
     const run = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Run collection');
     if (!run) return 'NO MENU ITEM Run collection | ' + items;
     run.click(); await __t.sleep(1500);
     const go = await __t.waitFor(() => vis('main button').find((b) => b.textContent.trim() === 'Run E2E Guard'), 5000);
     if (!go) return 'NO BUTTON Run E2E Guard';
     go.click();
     return await answer('Run against E2E Production?', 'Cancel');`,
  ),
  hits('after-run-cancel'),
];

module.exports = withExpect(
  steps,
  {
    server: /^listening$/,
    'production-active': /^active: E2E Production \| frame: true \| covers window: fixed none$/,
    'post-asks-cancel':
      /^Send to E2E Production\? .*"E2E Production" is a production environment\. Send POST E2E create may change real data\. .* \| buttons: Cancel \/ Send and don't ask again \/ Send$/,
    'after-cancel': /^after-cancel: none$/,
    'post-asks-send': /^answered \| response: 200$/,
    'after-send': /^after-send: POST \/create$/,
    'get-does-not-ask': /^dialog: false$/,
    'after-get': /^after-get: GET \/list$/,
    'mutation-asks-once': /^asked: true \| asked again: false$/,
    'after-mutations': /^after-mutations: POST \/graphql, POST \/graphql$/,
    'run-asks-once': /^Run against E2E Production\? .*Run E2E Guard \(3 requests, 2 change data\) may change real data\. .* \| buttons: Cancel \/ Run and don't ask again \/ Run$/,
    'after-run-cancel': /^after-run-cancel: none$/,
  },
  { prepare },
);
