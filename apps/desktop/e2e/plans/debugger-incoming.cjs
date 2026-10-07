// The Debugger's Incoming tab: a request a program sends to one of TestPion's mock servers is listed with the example
// that answered, and opens in Request Details / Response Details (secrets masked), with Open and Ask AI only.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const tab = (name) => vis('main [role=tab]').find((t) => t.textContent.trim().startsWith(name));
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'a-mock-answers-a-request',
    `await window.aps.invoke('col.save', {
       schemaVersion: '1.0', id: 'e2e-mocked', name: 'E2E mocked', version: 0, variables: [], updatedAt: '',
       items: [{ kind: 'http', id: 'm1', name: 'Create pet', request: { method: 'POST', url: 'http://api.test/pets' },
         examples: [{ id: 'ex1', name: 'Created', status: 201, headers: [{ key: 'content-type', value: 'application/json', enabled: true }], body: '{"id":7,"name":"Rex"}' }] }],
     });
     const info = await window.aps.invoke('mock.start', { collectionId: 'e2e-mocked' });
     const r = await window.aps.invoke('http.send', { request: { method: 'POST', url: info.url + '/pets?source=e2e', headers: [{ key: 'Authorization', value: 'Bearer e2e-secret-token', enabled: true }, { key: 'Content-Type', value: 'application/json', enabled: true }], body: { type: 'json', content: '{"name":"Rex"}' } } });
     return 'status: ' + (r.status ?? r.response?.status);`,
  ),
  step(
    'listed-in-incoming',
    `await __t.view('Debugger'); await __t.sleep(800);
     tab('Incoming requests')?.click(); await __t.sleep(600);
     const row = await __t.waitFor(() => vis('main [data-incoming-row]').find((x) => x.textContent.includes('/pets')), 4000);
     // the cells after # and the time: method, path, status, mock server, the example that answered
     return 'row: ' + (row ? [...row.children].slice(2).map((c) => c.textContent.trim()).join(' | ') : 'NONE');`,
  ),
  step(
    'opens-in-the-panes',
    `vis('main [data-incoming-row]').find((x) => x.textContent.includes('/pets'))?.click(); await __t.sleep(600);
     const req = document.querySelector('main [data-details-pane=request]')?.textContent ?? '';
     const res = document.querySelector('main [data-details-pane=response]')?.textContent ?? '';
     const buttons = vis('main button').map((b) => b.textContent.trim()).filter((t) => ['Open', 'Resend', 'Ask AI', 'Compare', 'Bookmark', 'Delete'].includes(t));
     [...document.querySelectorAll('main [data-details-pane=response] [role=tab]')].find((t) => t.textContent.trim().startsWith('Content'))?.click(); await __t.sleep(300);
     const body = document.querySelector('main [data-details-pane=response] pre')?.textContent ?? '';
     await window.aps.invoke('mock.stop', { collectionId: 'e2e-mocked' });
     await window.aps.invoke('col.delete', { id: 'e2e-mocked' }).catch(() => undefined);
     tab('Outgoing requests')?.click();
     return 'request line: ' + /POST \\/pets\\?source=e2e/.test(req) + ' | secret masked: ' + (!/e2e-secret-token/.test(req) && /\\*\\*\\*/.test(req)) + ' | response: ' + /201/.test(res) + ' | body: ' + body.trim() + ' | buttons: ' + buttons.join(',');`,
  ),
];

module.exports = withExpect(steps, {
  'a-mock-answers-a-request': /^status: 201$/,
  'listed-in-incoming': /^row: POST \| \/pets \| 201 \| E2E mocked \| Created$/,
  'opens-in-the-panes': /^request line: true \| secret masked: true \| response: true \| body: \{"id":7,"name":"Rex"\} \| buttons: Open,Ask AI$/,
});
