// Code reads in colour everywhere: the editors know JSON Lines, CSV (a colour per column) and raw HTTP besides their
// usual languages, a response's Raw view and a trace's raw payload colour keys, strings and numbers, and a text body
// that is JSON is coloured as JSON. "main:" steps run outside the page.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const PORT = 18766;
const syn = (root) =>
  `(() => { const r = ${root}; const n = (k) => r ? r.querySelectorAll('.syn-' + k).length : 0; return 'keys ' + n('key') + ' strings ' + n('string') + ' numbers ' + n('number'); })()`;

const steps = [
  [
    'serve',
    `main: const http = require('http'); await new Promise((r) => http.createServer((q, res) => { if (q.url === '/page') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><html><head><title>Page</title></head><body><div><p>Hi</p></div></body></html>'); } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: 'Rex', age: 3, tags: ['a', 'b'] })); }).listen(${PORT}, '127.0.0.1', r)); return 'serving';`,
    false,
  ],
  step(
    'send-and-read-it-raw',
    `await __t.requests();
     const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500);
     vis('[role=menuitem]').find((x) => x.textContent.trim().startsWith('HTTP request'))?.click(); await __t.sleep(1200);
     const url = vis('main input[aria-label="Request URL"]')[0];
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, 'http://127.0.0.1:${PORT}/pets'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
     button('Send')?.click();
     await __t.waitFor(() => vis('main button').find((b) => b.textContent.trim().toLowerCase() === 'raw'), 10000);
     vis('main button').find((b) => b.textContent.trim().toLowerCase() === 'raw').click(); await __t.sleep(600);
     return 'raw view: ' + ${syn("vis('main .mono').find((x) => /Rex/.test(x.textContent) && x.querySelector('.syn-key'))")};`,
  ),
  step(
    'editor-languages',
    `const M = window.__monaco; if (!M) return 'NO EDITOR';
     const ids = M.languages.getLanguages().map((l) => l.id);
     const kinds = (text, lang) => [...new Set(M.editor.tokenize(text, lang).flat().map((t) => t.type.replace(/\\.(jsonl|csv|http)$/, '')))].filter(Boolean).sort().join(' ');
     return 'languages: ' + ['jsonl', 'csv', 'http'].filter((x) => ids.includes(x)).join(',')
       + ' | http: ' + kinds('POST https://x.test/pets HTTP/1.1\\nContent-Type: application/json\\n\\n{"name": 3}', 'http');`,
  ),
  step(
    'a-trace-payload-raw',
    `await __t.view('Traces');
     const row = await __t.waitFor(() => vis('main *').find((x) => x.children.length === 0 && ['New HTTP request', 'GET http://127.0.0.1:${PORT}/pets'].includes(x.textContent.trim())), 10000);
     row.click(); await __t.sleep(800);
     tab('Payload')?.click(); await __t.sleep(600);
     const raws = vis('main button').filter((b) => b.textContent.trim() === 'Raw'); raws[raws.length - 1]?.click(); await __t.sleep(500);
     return 'trace raw: ' + ${syn("vis('main [data-raw-view]').find((p) => /Rex/.test(p.textContent))")};`,
  ),
  step(
    'a-minified-page-is-pretty-in-its-trace',
    `const sent = await window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:${PORT}/page', headers: [], body: { type: 'none' } } }).catch((e) => ({ error: e }));
     if (sent?.error) return 'SEND FAILED ' + JSON.stringify(sent.error).slice(0, 200);
     const tl = await window.aps.invoke('traces.list', {}); const names = (tl.items ?? tl.rows ?? tl.traces ?? []).map((t) => t.name ?? t.title); if (!names.some((n) => String(n).includes('/page'))) return 'NO TRACE: ' + JSON.stringify(names) + ' | sent: ' + JSON.stringify(sent).slice(0, 300);
     await __t.view('Home'); await __t.view('Traces');
     const row = await __t.waitFor(() => vis('main *').filter((x) => x.textContent.includes('${PORT}/page')).sort((a, b) => a.textContent.length - b.textContent.length)[0], 10000);
     row.click(); await __t.sleep(800);
     tab('Payload')?.click(); await __t.sleep(800);
     const lines = vis('main .mono .leading-5').map((x) => x.textContent).filter((t) => /<|Hi/.test(t));
     return 'lines: ' + lines.length + ' | indented: ' + lines.some((t) => t.includes('      <p>Hi</p>')) + ' | title: ' + lines.some((t) => t.includes('<title>Page</title>'));`,
  ),
];

module.exports = withExpect(steps, {
  'send-and-read-it-raw': /^raw view: keys [1-9]\d* strings [1-9]\d* numbers [1-9]/,
  'editor-languages': /^languages: jsonl,csv,http \| http: .*keyword.*string\.key\.json/,
  'a-trace-payload-raw': /^trace raw: keys [1-9]\d* strings [1-9]\d* numbers [1-9]/,
  'a-minified-page-is-pretty-in-its-trace': /^lines: (1[0-9]|[2-9]\d) \| indented: true \| title: true$/,
});
