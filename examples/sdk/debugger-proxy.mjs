// The Debugger engine as a library (docs/architecture/engine-sdk.md): start a proxy, give it rules (one of them a JavaScript
// script), send traffic through it, read what it captured, save a HAR. Nothing here needs the TestPion app.
//
//   npm run build            (once, in the repository)
//   node examples/sdk/debugger-proxy.mjs
import { createServer, request } from 'node:http';
import { Redactor, exchangesToHar, startDebuggerProxy } from '@testpion/core';

// a small API to capture
const api = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, env: req.headers['x-env'] ?? null, secret: 'hunter2' }));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiPort = api.address().port;

// rules: plain data. Declarative kinds (modify, reply, redirect, fault, ...) and `script` (onRequest / onResponse in a sandbox).
const rules = [
  { id: 'r1', name: 'Mark staging', enabled: true, kind: 'modify', match: { host: `127.0.0.1:${apiPort}` }, requestHeaders: [{ op: 'set', name: 'x-env', value: 'staging' }] },
  {
    id: 'r2',
    name: 'Hide the secret',
    enabled: true,
    kind: 'script',
    match: { host: `127.0.0.1:${apiPort}` },
    script: { code: 'function onResponse(ctx) { const j = JSON.parse(ctx.response.body); delete j.secret; ctx.response.body = JSON.stringify(j); }' },
  },
];

const proxy = await startDebuggerProxy({
  rules: () => rules, // read for every request: change the array and the next request sees it
  onExchange: (e, phase) => phase === 'response' && console.log(`${e.method} ${e.url} -> ${e.status} (${e.durationMs} ms)${e.rules ? `  rules: ${e.rules.join(', ')}` : ''}`),
});

// send a request through the proxy (any HTTP client with a proxy setting does the same)
const body = await new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: `http://127.0.0.1:${apiPort}/orders/42`, headers: { host: `127.0.0.1:${apiPort}` } }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => resolve(text));
  });
  req.on('error', reject);
  req.end();
});
console.log('the program received:', body); // the secret is gone, the server saw x-env: staging

// what was captured, and the same as a HAR (secrets in headers and URLs masked)
const [first] = proxy.exchanges;
console.log('captured:', first.method, first.url, first.status, 'rules:', first.rules);
console.log('HAR entries:', exchangesToHar(proxy.exchanges, new Redactor()).log.entries.length);

await proxy.close();
await new Promise((r) => api.close(r));
