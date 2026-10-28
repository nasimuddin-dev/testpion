// The Debugger's content-aware body views (0.58): Image (dimensions and size from a PNG kept as base64), XML (a tree), HTML (drawn in a
// sandboxed frame: scripts off, network off), Form (multipart parts), GraphQL (operation in the URL cell, formatted query, variables,
// the response's errors), MessagePack (decoded on the host, a token masked), and the Summary's TLS and Caching sections.
// Loads a mock HAR (no network). Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const HAR = `(() => {
  const h = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const entry = (i, method, url, reqType, reqBody, resType, resBody, extra = {}) => ({
    startedDateTime: new Date(Date.now() - 60000 + i * 1000).toISOString(),
    time: 25,
    request: { method, url, httpVersion: 'HTTP/1.1', headers: h(reqType ? { 'content-type': reqType } : {}), cookies: [], queryString: [], headersSize: -1, bodySize: reqBody ? reqBody.length : 0, ...(reqBody ? { postData: { mimeType: reqType, text: reqBody } } : {}) },
    response: { status: extra.status ?? 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: h({ 'content-type': resType, ...(extra.headers ?? {}) }), cookies: [], content: { size: (resBody || '').length, mimeType: resType, text: resBody, ...(extra.encoding ? { encoding: extra.encoding } : {}) }, redirectURL: '', headersSize: -1, bodySize: (resBody || '').length },
    cache: {},
    timings: { send: 1, wait: 20, receive: 4 },
    _testpion: { id: 'v' + i, kind: 'http', ...(extra.connection ? { connection: extra.connection } : {}) },
  });
  const gql = JSON.stringify({ operationName: 'GetUser', query: 'query GetUser($id: ID!) { user(id: $id) { id name } }', variables: { id: '7', password: 'hunter2hunter2' } });
  const gqlRes = JSON.stringify({ data: { user: null }, errors: [{ message: 'User 7 not found', path: ['user'], extensions: { code: 'NOT_FOUND' } }] });
  const multipart = ['--XYZ', 'Content-Disposition: form-data; name="title"', '', 'Hello', '--XYZ', 'Content-Disposition: form-data; name="doc"; filename="a.pdf"', 'Content-Type: application/pdf', '', '%PDF-1.4', '--XYZ--', ''].join('\\r\\n');
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: [
    entry(1, 'GET', 'https://views.example.test/logo.png', '', '', 'image/png', '${PNG_1X1}', { encoding: 'base64' }),
    entry(2, 'GET', 'https://views.example.test/orders.xml', '', '', 'application/xml', '<orders count="2"><order id="1"><item>Tea</item></order><order id="2"><item>Milk</item></order></orders>'),
    entry(3, 'GET', 'https://views.example.test/page.html', '', '', 'text/html', '<h1 id="hi">Hello preview</h1><p style="color:red">styled</p>'),
    entry(4, 'POST', 'https://views.example.test/upload', 'multipart/form-data; boundary=XYZ', multipart, 'application/json', '{"ok":true}'),
    entry(5, 'POST', 'https://views.example.test/graphql', 'application/json', gql, 'application/json', gqlRes),
    entry(6, 'GET', 'https://views.example.test/mp', '', '', 'application/x-msgpack', '82a46e616d65a3746f6da5746f6b656ea6733363723374', {}),
    entry(7, 'GET', 'https://views.example.test/cached.json', '', '', 'application/json', '{"a":1}', { headers: { 'cache-control': 'public, max-age=3600', etag: '"abc"' }, connection: { version: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', alpn: 'h2', authorized: true, chain: [{ subject: 'CN=views.example.test', issuer: 'CN=Test CA', validFrom: '2020-01-01T00:00:00.000Z', validTo: '2020-06-01T00:00:00.000Z', san: ['views.example.test'] }] } }),
  ] } });
})()`;

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const pane = (side) => document.querySelector('main [data-details-pane="' + side + '"]');
  const tabs = (side) => [...(pane(side)?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.textContent.trim());
  const openTab = async (side, name) => {
    const t = [...(pane(side)?.querySelectorAll('[role=tab]') ?? [])].find((x) => x.textContent.trim().startsWith(name));
    if (!t) return false;
    if (!t.hasAttribute('data-overflow')) { await __t.real.click(t); await __t.sleep(400); return true; }
    const more = pane(side)?.querySelector('[aria-label^="All tabs"]');
    if (!more) return false;
    more.click(); await __t.sleep(300);
    const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith(name)), 2000);
    if (!it) return false;
    it.click(); await __t.sleep(400); return true;
  };
  const select = async (text) => { const r = await __t.waitFor(() => row(text), 5000); if (!r) return false; await __t.real.click(r); await __t.sleep(700); return true; };
`;
const step = stepOf(H);

const steps = [
  step(
    'load-a-session-with-one-exchange-of-each-kind',
    `await __t.view('Debugger'); await __t.sleep(500);
     const r = await window.aps.invoke('debug.openSession', { text: ${HAR} });
     await __t.waitFor(() => (rows().length >= 7 ? true : null), 8000);
     return 'loaded: ' + r.loaded + ' | rows: ' + rows().length;`,
  ),
  step(
    'graphql-operation-in-the-url-cell',
    `const r = row('/graphql'); if (!r) return 'NO ROW';
     const label = r.querySelector('[data-graphql-label]')?.textContent.trim();
     return 'label: ' + label;`,
  ),
  step(
    'image-tab-shows-size-and-dimensions',
    `if (!(await select('logo.png'))) return 'NO ROW';
     if (!(await openTab('response', 'Image'))) return 'NO IMAGE TAB: ' + tabs('response').join(',');
     const img = pane('response')?.querySelector('[data-view=image] img'); const size = pane('response')?.querySelector('[data-image-size]')?.textContent.trim();
     await __t.waitFor(() => (img && img.complete ? true : null), 3000);
     return 'img: ' + !!img + ' | drawn: ' + !!(img && img.naturalWidth === 1) + ' | size: ' + size;`,
  ),
  step(
    'xml-tab-is-a-tree-you-can-fold',
    `if (!(await select('orders.xml'))) return 'NO ROW';
     if (!(await openTab('response', 'XML'))) return 'NO XML TAB: ' + tabs('response').join(',');
     const v = () => pane('response')?.querySelector('[data-view=xml]');
     const before = v()?.textContent ?? '';
     const fold = [...v().querySelectorAll('button[aria-label^="Collapse"]')].find((b) => b.getAttribute('aria-label') === 'Collapse order');
     if (fold) { await __t.real.click(fold); await __t.sleep(300); }
     const after = v()?.textContent ?? '';
     return 'shows: ' + /orders/.test(before) + ',' + /Tea/.test(before) + ' | attr: ' + /count/.test(before) + ' | folded hides item: ' + (/Milk|Tea/.test(before) && !after.includes('Tea'));`,
  ),
  step(
    'html-preview-is-sandboxed',
    `if (!(await select('page.html'))) return 'NO ROW';
     if (!(await openTab('response', 'Preview'))) return 'NO PREVIEW TAB: ' + tabs('response').join(',');
     const f = pane('response')?.querySelector('iframe[data-html-preview]'); if (!f) return 'NO FRAME';
     await __t.sleep(600);
     return 'sandbox: [' + f.getAttribute('sandbox') + '] | csp: ' + /default-src 'none'/.test(f.getAttribute('srcdoc')) + ' | opaque origin: ' + (f.contentDocument === null) + ' | shows text: ' + /Hello preview/.test(f.getAttribute('srcdoc') ?? '');`,
  ),
  step(
    'multipart-form-parts',
    `if (!(await select('/upload'))) return 'NO ROW';
     if (!(await openTab('request', 'Form'))) return 'NO FORM TAB: ' + tabs('request').join(',');
     const t = pane('request')?.querySelector('[data-view-table=multipart]'); if (!t) return 'NO TABLE';
     const rowsText = [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent.trim()).join('|'));
     return rowsText.join(' ;; ');`,
  ),
  step(
    'graphql-tab-shows-query-variables-and-errors',
    `if (!(await select('/graphql'))) return 'NO ROW';
     if (!(await openTab('response', 'GraphQL'))) return 'NO GRAPHQL TAB: ' + tabs('response').join(',');
     const v = pane('response')?.querySelector('[data-view=graphql]');
     const errs = v?.querySelector('[data-graphql-errors]')?.textContent ?? '';
     return 'query: ' + /query GetUser/.test(v?.textContent ?? '') + ' | vars: ' + /id/.test(v?.textContent ?? '') + ' | secret hidden: ' + !/hunter2hunter2/.test(v?.textContent ?? '') + ' | error: ' + /User 7 not found/.test(errs) + ' ' + /NOT_FOUND/.test(errs) + ' | on request side too: ' + tabs('request').some((t) => t.startsWith('GraphQL'));`,
  ),
  step(
    'messagepack-is-decoded-on-the-host-and-masked',
    `if (!(await select('/mp'))) return 'NO ROW';
     if (!(await openTab('response', 'MessagePack'))) return 'NO MSGPACK TAB: ' + tabs('response').join(',');
     const v = await __t.waitFor(() => { const x = pane('response')?.querySelector('[data-view=msgpack]'); return x && x.textContent.length > 4 ? x : null; }, 5000);
     const txt = v?.textContent ?? '';
     return 'decoded: ' + /tom/.test(txt) + ' | token shown: ' + /s3cr3t/.test(txt);`,
  ),
  step(
    'summary-has-tls-and-caching-sections',
    `if (!(await select('cached.json'))) return 'NO ROW';
     if (!(await openTab('request', 'Summary'))) return 'NO SUMMARY';
     const groups = [...(pane('request')?.querySelectorAll('[data-summary-group]') ?? [])].map((g) => g.textContent.trim()).join(',');
     const t = pane('request')?.textContent ?? '';
     return 'groups: ' + groups + ' | tls: ' + /TLSv1\\.3/.test(t) + ' | expired flagged: ' + !!pane('request')?.querySelector('[data-tls-finding=bad]') + ' | cache: ' + /1 h/.test(t) + ' | validator: ' + /"abc"/.test(t);`,
  ),
];

module.exports = withExpect(steps, {
  'load-a-session-with-one-exchange-of-each-kind': /^loaded: 7 \| rows: 7$/,
  'graphql-operation-in-the-url-cell': /^label: query GetUser$/,
  'image-tab-shows-size-and-dimensions': /^img: true \| drawn: true \| size: 1 × 1 px$/,
  'xml-tab-is-a-tree-you-can-fold': /^shows: true,true \| attr: true \| folded hides item: true$/,
  'html-preview-is-sandboxed': /^sandbox: \[\] \| csp: true \| opaque origin: true \| shows text: true$/,
  'multipart-form-parts': /^title\|\|\|5 B\|Hello ;; doc\|a\.pdf\|application\/pdf\|8 B\|\(file content is not shown\)$/,
  'graphql-tab-shows-query-variables-and-errors': /^query: true \| vars: true \| secret hidden: true \| error: true true \| on request side too: true$/,
  'messagepack-is-decoded-on-the-host-and-masked': /^decoded: true \| token shown: false$/,
  'summary-has-tls-and-caching-sections': /^groups: .*TLS and certificate.*Caching.* \| tls: true \| expired flagged: true \| cache: true \| validator: true$/,
});
