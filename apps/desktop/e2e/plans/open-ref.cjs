// WF-02 openRef: one resolver opens every kind of item in its own view. A gRPC search hit lands in gRPC, a WebSocket
// connection changed in git opens from the Git view (its RefLink, with the shared right-click menu), a GraphQL history
// entry opens in GraphQL with the query that was sent, and a search hit of a request deleted since says so (with what to
// open instead) rather than opening an empty editor.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const view = () => localStorage.getItem('aps.view');
  const activeTab = () => document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')?.textContent.trim() ?? 'NO TAB';
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim());
  // the workspace search (top bar): type, wait for a hit with this title, click it
  const searchAndOpen = async (query, title) => {
    await __t.esc();
    document.querySelector('[data-search-trigger]')?.click();
    const input = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Search"] input'), 3000);
    if (!input) return 'NO DIALOG search';
    setVal(input, query);
    const hit = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog][aria-label="Search"] [role=option]')].find((o) => o.textContent.includes(title)), 5000);
    if (!hit) return 'NO ROW ' + title;
    const kind = hit.querySelector('span.ml-auto')?.textContent.trim();
    hit.click();
    await __t.sleep(1500);
    return kind;
  };
`;
const step = (name, body, shot) => [name, `(async () => { ${H} ${body} })()`, shot];

const steps = [
  // the bug: gRPC (and WebSocket, SOAP) items opened in the GraphQL view
  step(
    'search-grpc',
    `const kind = await searchAndOpen('Say hello', 'Say hello (unary)');
     if (/^NO /.test(kind)) return kind;
     await __t.waitFor(() => view() === 'grpc' && /Say hello/.test(activeTab()), 4000);
     return 'hit: ' + kind + ' | view: ' + view() + ' | tab: ' + activeTab();`,
  ),
  step(
    'search-websocket',
    `const kind = await searchAndOpen('ifelse', 'ws.ifelse.io');
     if (/^NO /.test(kind)) return kind;
     await __t.waitFor(() => view() === 'websocket', 4000);
     return 'view: ' + view() + ' | tab: ' + activeTab();`,
  ),
  // a hit for a request deleted after the search listed it: a message with what to open instead, never an empty editor
  step(
    'search-stale',
    `await __t.esc();
     const hits = await window.aps.invoke('ws.search', { query: 'Custom headers' });
     const h = hits.find((x) => x.kind === 'request' && x.title === 'Custom headers');
     if (!h) return 'NO ROW Custom headers';
     document.querySelector('[data-search-trigger]')?.click();
     const input = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Search"] input'), 3000);
     setVal(input, 'Custom headers');
     const hit = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog][aria-label="Search"] [role=option]')].find((o) => o.textContent.includes('Custom headers')), 5000);
     if (!hit) return 'NO ROW in the dialog';
     // deleted meanwhile (another window, a git pull …)
     const c = await window.aps.invoke('col.get', { id: h.ref.collectionId });
     const drop = (items) => items.filter((n) => n.id !== h.ref.requestId).map((n) => (n.kind === 'folder' ? { ...n, items: drop(n.items) } : n));
     await window.aps.invoke('col.save', { ...c, items: drop(c.items) });
     await __t.sleep(500);
     const before = toasts().length;
     hit.click();
     const t = await __t.waitFor(() => toasts().find((x) => /Can't open/.test(x)), 5000);
     const action = [...document.querySelectorAll('[data-sonner-toast] button')].map((b) => b.textContent.trim()).find((x) => /^Open /.test(x));
     return 'toast: ' + (t ? t.replace(/\\s+/g, ' ').slice(0, 120) : 'NONE') + ' | action: ' + (action ?? 'NONE') + ' | new toasts: ' + (toasts().length > before);`,
  ),
  // the Git view: a saved WebSocket connection renamed on disk is a change by meaning that opens in the WebSocket editor
  [
    'git-commit',
    `main:
      const { execFileSync } = require('node:child_process');
      const { readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const ws = join(home, 'ws');
      const git = (...a) => execFileSync('git', a, { cwd: ws, stdio: 'pipe' }).toString();
      git('init', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'Start');
      const file = join(ws, 'library', 'websocket.json');
      const lib = JSON.parse(readFileSync(file, 'utf8'));
      lib.items.find((i) => i.id === 'mqtt-hivemq').name = 'Renamed socket';
      writeFileSync(file, JSON.stringify(lib, null, 2));
      return 'changed: ' + git('status', '--porcelain').trim();`,
    false,
  ],
  step(
    'git-open-websocket',
    `await __t.view('Git');
     const find = () => [...document.querySelectorAll('[aria-label="Changes"] [data-ref-link]')].find((a) => a.textContent.includes('Renamed socket'));
     let link = await __t.waitFor(find, 8000);
     if (!link) return 'NO ROW Renamed socket | links: ' + [...document.querySelectorAll('[aria-label="Changes"] li')].map((l) => l.textContent.trim().slice(0, 60)).join(' / ');
     // the shared right-click menu of a named item
     link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
     await __t.waitFor(() => document.querySelector('[role=menu]'), 2000);
     const menu = [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.textContent.trim()).join(' | ');
     await __t.esc();
     link = await __t.waitFor(find, 2000);
     link.click();
     await __t.waitFor(() => view() === 'websocket' && /Renamed socket/.test(activeTab()), 5000);
     return 'kind: ' + link.getAttribute('data-ref-link') + ' | menu: ' + menu + ' | view: ' + view() + ' | tab: ' + activeTab();`,
  ),
  // a GraphQL endpoint of its own (the demo servers may belong to another run): any query gets {"data": …}
  [
    'graphql-endpoint',
    `main:
      const http = require('node:http');
      if (globalThis.__openRefGql) return 'listening';
      globalThis.__openRefGql = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { __typename: 'Query' } })); }); });
      await new Promise((ok, fail) => globalThis.__openRefGql.listen(47311, '127.0.0.1', ok).on('error', fail));
      globalThis.__openRefGql.unref();
      return 'listening';`,
    false,
  ],
  // History: a GraphQL query opens in GraphQL with what was sent (it used to open an empty editor)
  step(
    'history-graphql',
    `const query = '{ __typename } # e2e-open-ref';
     const r = await window.aps.invoke('gql.send', { request: { endpoint: 'http://127.0.0.1:47311/graphql', query, headers: [] }, name: 'E2E open-ref query' }).catch((e) => ({ error: e?.message ?? JSON.stringify(e) }));
     if (r.error) return 'ERR send: ' + r.error;
     await __t.view('History');
     const row = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.includes('127.0.0.1:47311/graphql')), 6000);
     if (!row) return 'NO ROW 127.0.0.1:47311/graphql';
     row.click();
     await __t.sleep(700);
     if (!(await __t.button('Open'))) return 'NO BUTTON Open';
     await __t.waitFor(() => view() === 'graphql' && document.querySelector('main')?.innerText.includes('e2e-open-ref'), 6000);
     return 'view: ' + view() + ' | tab: ' + activeTab() + ' | query shown: ' + !!document.querySelector('main')?.innerText.includes('e2e-open-ref');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'search-grpc': /^hit: saved \| view: grpc \| tab: .*Say hello \(unary\)/,
    'search-websocket': /^view: websocket \| tab: .*ws\.ifelse\.io/,
    'search-stale': /^toast: Can't open that request: It is no longer in the collection .* \| action: Open .+ \| new toasts: true$/,
    'git-commit': /^changed: M library\/websocket\.json$/,
    'git-open-websocket': /^kind: saved \| menu: Open \| Open in new tab \| Reveal in sidebar \| Copy link \| view: websocket \| tab: .*Renamed socket/,
    'graphql-endpoint': /^listening$/,
    'history-graphql': /^view: graphql \| tab: .*E2E open-ref query.* \| query shown: true$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
