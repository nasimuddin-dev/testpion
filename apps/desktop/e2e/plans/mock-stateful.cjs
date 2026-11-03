// A stateful mock server: started with Stateful on, what a client POSTs the mock keeps (GET lists and returns it, PATCH changes
// it, DELETE removes it) for the time it runs; the list example seeds the state; a path the examples do not describe as a
// resource is answered by the examples as before; the Mock tab says Stateful is on and Reset state forgets what was created.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'a-collection-with-a-list-example',
    `const col = { schemaVersion: '1.0', id: 'e2e-stateful', name: 'Stateful pets', version: 0, variables: [], updatedAt: '', items: [
       { kind: 'http', id: 'list', name: 'List pets', request: { method: 'GET', url: '{{baseUrl}}/pets' }, examples: [{ id: 'l', name: 'All', status: 200, headers: [{ key: 'Content-Type', value: 'application/json' }], body: '[{"id":1,"name":"Rex"}]' }] },
       { kind: 'http', id: 'login', name: 'Log in', request: { method: 'POST', url: '{{baseUrl}}/login' }, examples: [{ id: 'ok', name: 'Success', status: 200, headers: [], body: '{"token":"t"}' }] },
     ] };
     await window.aps.invoke('col.save', col);
     const info = await window.aps.invoke('mock.start', { collectionId: 'e2e-stateful', stateful: true });
     window.__mockUrl = info.url;
     return 'running: ' + info.running + ' | stateful: ' + info.stateful + ' | routes: ' + info.routes.length;`,
  ),
  step(
    'post-creates-get-returns-delete-removes',
    `// the window's CSP allows no fetch to other origins: the app's own engine sends (http.send), as a request tab would
     const j = async (method, path, body) => { const r = await window.aps.invoke('http.send', { request: { method, url: window.__mockUrl + path, headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], ...(body === undefined ? {} : { body: { type: 'json', content: JSON.stringify(body) } }) } }); const res = r.response ?? r; const h = Object.fromEntries((res.headers ?? []).map(([k, v]) => [String(k).toLowerCase(), v])); return { status: res.status, state: h['x-mock-state'] ?? null, body: res.status === 204 || !res.bodyPreview ? null : JSON.parse(res.bodyPreview) }; };
     window.__j = j;
     const seeded = (await j('GET', '/pets')).body.length;
     const created = await j('POST', '/pets', { name: 'Fluffy' });
     const listed = (await j('GET', '/pets')).body.length;
     const one = await j('GET', '/pets/' + created.body.id);
     const changed = await j('PATCH', '/pets/' + created.body.id, { name: 'Fluff' });
     const removed = (await j('DELETE', '/pets/' + created.body.id)).status;
     const gone = (await j('GET', '/pets/' + created.body.id)).status;
     const login = await j('POST', '/login', { user: 'a' });
     const kept = await window.aps.invoke('mock.state', { collectionId: 'e2e-stateful' });
     return 'seeded: ' + seeded + ' | created: ' + created.status + ' ' + created.state + ' id ' + created.body.id + ' | listed: ' + listed + ' | one: ' + one.body.name + ' | changed: ' + changed.body.name + ' | removed: ' + removed + ' | gone: ' + gone + ' | login by example: ' + login.body.token + ' ' + login.state + ' | state resources: ' + Object.keys(kept).join(',');`,
  ),
  step(
    'the-mock-tab-says-stateful-and-resets',
    `await __t.requests(); await __t.sleep(600);
     await __t.expand('Stateful pets'); const opened = await __t.open('List pets'); if (opened !== 'ok') return opened;
     // the collection's own page (Overview, Variables, Mock …): the collection crumb of the open request
     const crumb = [...document.querySelectorAll('nav[aria-label="Where this request is saved"] button')].find((x) => x.offsetParent); if (!crumb) return 'NO CRUMB'; crumb.click(); await __t.sleep(1500);
     const ok = await __t.tab('Mock'); await __t.sleep(800);
     const on = await __t.waitFor(() => document.querySelector('[data-mock-stateful]'), 6000); if (!on) return 'NO STATEFUL LINE (tab: ' + ok + ')';
     const reset = document.querySelector('[data-mock-reset-state]'); if (!reset) return 'NO RESET BUTTON';
     await window.__j('POST', '/pets', { name: 'Again' });
     const before = Object.values(await window.aps.invoke('mock.state', { collectionId: 'e2e-stateful' })).flat().length;
     await __t.real.click(reset); await __t.sleep(600);
     const after = (await window.__j('GET', '/pets')).body.length;
     await window.aps.invoke('mock.stop', { collectionId: 'e2e-stateful' });
     await window.aps.invoke('col.delete', { id: 'e2e-stateful' }).catch(() => undefined);
     return 'stateful: ' + on.getAttribute('data-mock-stateful') + ' | records before reset: ' + before + ' | after reset: ' + after;`,
  ),
];

module.exports = withExpect(steps, {
  'a-collection-with-a-list-example': /^running: true \| stateful: true \| routes: 2$/,
  'post-creates-get-returns-delete-removes': /^seeded: 1 \| created: 201 \/pets id 2 \| listed: 2 \| one: Fluffy \| changed: Fluff \| removed: 204 \| gone: 404 \| login by example: t null \| state resources: \/pets$/,
  'the-mock-tab-says-stateful-and-resets': /^stateful: true \| records before reset: 2 \| after reset: 1$/,
});
