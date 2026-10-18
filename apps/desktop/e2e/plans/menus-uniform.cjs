// One menu everywhere (MENU-1…3, planning/menus-uniform.md): every tree and list node's menu comes from one function
// (lib/node-menu.ts), in one group order (create · open · tree · run · share · tools · git · edit · danger). Driven with
// real input only (__t.real: right-click and the ⋯ button, keys): for each kind of the plan's list the right-click menu
// and the ⋯ menu are the same and hold the items of the model; Shift+F10 and the menu key open the focused row's menu;
// Expand all and Collapse all work at depth and persist across a reload; the blank area opens the section's menu;
// screenshots at comfortable and compact density, dark and light.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** Fixtures: a favorite request, a saved load test and evaluation (the examples have none), a dataset folder. */
function prepare(ws) {
  const file = join(ws, 'collections', 'httpbin.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const mark = (nodes) => nodes.forEach((n) => (n.id === 'hb-headers' ? (n.favorite = true) : n.items && mark(n.items)));
  mark(c.items);
  writeFileSync(file, JSON.stringify(c, null, 2));
  writeFileSync(
    join(ws, 'library', 'load-tests.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        folders: ['Smoke'],
        items: [{ id: 'lt-e2e', name: 'E2E load', folder: 'Smoke', data: { kind: 'http', method: 'GET', url: 'http://127.0.0.1:4010/health', vus: 1, duration: 1 } }],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(ws, 'library', 'evaluations.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'ev-e2e', name: 'E2E evaluation', data: { dataset: 'intents.jsonl' } }] }, null, 2),
  );
  writeFileSync(
    join(ws, 'library', 'dataset-folders.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: ['Evaluations'], items: [{ id: 'intents.jsonl', name: 'intents.jsonl', folder: 'Evaluations', data: null }] }, null, 2),
  );
}

const H = `
  const aside = () => document.querySelector('aside[aria-label="Collections explorer"]');
  const node = (id) => [...document.querySelectorAll('[data-node-id]')].find((n) => n.getAttribute('data-node-id') === id && n.getClientRects().length);
  const byName = (scope, name) => [...document.querySelectorAll('[data-node-id' + (scope ? '^="' + scope + '"' : '') + ']')].find((n) => n.getClientRects().length && (n.querySelector('[data-row-name]')?.getAttribute('data-row-name') === name || n.querySelector('.truncate')?.textContent.trim() === name));
  const menuOpen = () => document.querySelector('[role=menu]');
  /** The open menu as groups: items joined by ' | ', groups by ' ‖ ' (a submenu's trigger is one item). */
  const groups = () => { const m = menuOpen(); if (!m) return 'NO MENU'; const out = [[]]; for (const el of m.querySelectorAll('[role=menuitem], [role=separator]')) { if (el.closest('[role=menu]') !== m) continue; if (el.getAttribute('role') === 'separator') out.push([]); else out[out.length - 1].push(el.textContent.trim()); } return out.filter((g) => g.length).map((g) => g.join(' | ')).join(' ‖ '); };
  const close = async () => { if (!menuOpen()) return; await __t.real.key('Escape'); await __t.waitFor(() => !menuOpen(), 1500); };
  /** A row's menu by right-click, then by its ⋯ button: both, and whether they are the same. */
  const both = async (row) => {
    if (!row) return 'NO ROW';
    await close();
    row.scrollIntoView({ block: 'center' });
    await __t.real.rightClick(row);
    if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU (right-click)';
    const right = groups(); await close();
    const dots = row.querySelector('button[aria-label^="More actions for"]');
    if (!dots) return 'NO BUTTON ⋯';
    await __t.real.click(dots);
    if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU (⋯)';
    const viaDots = groups(); await close();
    return right === viaDots ? right : 'DIFFER right: ' + right + ' / ⋯: ' + viaDots;
  };
  /** Unfold a row (a real click on its chevron row) when it is folded. */
  const unfold = async (row) => { const b = row?.querySelector('[data-tree-row][aria-expanded="false"]'); if (b) { b.scrollIntoView({ block: 'center' }); await __t.real.click(b); await __t.waitFor(() => b.getAttribute('aria-expanded') === 'true' || !b.isConnected, 1500); } return row; };
  /** A row's open state: its own button's aria-expanded (the ⋯ menu trigger carries one too). */
  const exp = (row) => row?.querySelector('[data-tree-row]')?.getAttribute('aria-expanded');
  /** The right-click menu of a row, scrolled into view first (real input hits what is on screen). */
  const menuOf = async (row) => { await close(); row.scrollIntoView({ block: 'center' }); await __t.real.rightClick(row); return await __t.waitFor(menuOpen, 2000); };
  /** Pick a menu item with a real click. */
  const pick = async (label) => { const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label), 1500); if (!it) return false; await __t.real.click(it); await __t.waitFor(() => !menuOpen(), 1500); return true; };
`;
const step = (name, body, shot) => [name, `(async () => { ${H} ${body} })()`, shot];
const RELOAD = `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.webContents.reload();
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); if (await w.webContents.executeJavaScript("document.readyState === 'complete' && !!document.querySelector('nav')").catch(() => false)) break; }
  await w.webContents.executeJavaScript(require('node:fs').readFileSync(require.resolve('./helpers.js'), 'utf8')); await w.webContents.executeJavaScript(require('./real-input.cjs').PAGE); return 'reloaded';`;

const steps = [
  step('open-explorer', `await __t.requests(); const c = await __t.waitFor(() => node('httpbin'), 3000); return c ? 'ok' : 'NO ROW httpbin';`),
  // the Collections tree
  step('collection', `return await both(node('httpbin'));`),
  step('category', `await unfold(node('httpbin')); return await both(await __t.waitFor(() => node('httpbin:cat:rest'), 2000));`),
  step('folder', `return await both(await __t.waitFor(() => node('httpbin:hb-basics'), 2000));`),
  step('request-http', `await unfold(node('httpbin:hb-basics')); return await both(await __t.waitFor(() => node('httpbin:hb-headers'), 2000));`),
  step(
    'request-soap',
    `await unfold(node('soap')); const f = await __t.waitFor(() => byName('soap:', 'Calculator (dneonline.com)'), 2000); await unfold(f); return await both(await __t.waitFor(() => byName('soap:', 'Add 20 and 22'), 2000));`,
  ),
  step(
    'request-graphql',
    `await unfold(node('graphql-public')); const f = await __t.waitFor(() => byName('graphql-public:', 'Countries'), 2000); await unfold(f); return await both(await __t.waitFor(() => byName('graphql-public:', 'Country by code'), 2000));`,
  ),
  step('grpc-folder', `await unfold(node('grpc')); return await both(await __t.waitFor(() => node('grpc:grpc:folder:grpcb.in'), 2000));`),
  step('grpc-call', `return await both(await __t.waitFor(() => node('grpc:grpc:grpc-hello'), 2000));`),
  step('ws-connection', `await unfold(node('realtime')); return await both(await __t.waitFor(() => node('realtime:websocket:ws-postman-echo'), 2000));`),
  // the explorer's sections
  step('favorites-section', `return await both(node('section:favorites'));`),
  step('favorite', `return await both(await __t.waitFor(() => node('favorites:fav-httpbin:hb-headers'), 2000));`),
  step('mcp-section', `const s = node('section:mcp'); await unfold(s); return await both(s);`),
  step('mcp-folder', `return await both(await __t.waitFor(() => node('mcp:folder:Public servers'), 2000));`),
  step('mcp-server', `return await both(await __t.waitFor(() => node('mcp:petstore-mcp'), 2000));`),
  step('spec-section', `const s = node('section:specs'); await unfold(s); return await both(s);`),
  step('spec', `return await both(await __t.waitFor(() => node('specs:specs/petstore.json'), 2000));`),
  step('dataset-section', `const s = node('section:datasets'); await unfold(s); return await both(s);`),
  step('dataset-folder', `return await both(await __t.waitFor(() => node('datasets:folder:Evaluations'), 2000));`),
  step('dataset', `return await both(await __t.waitFor(() => node('datasets:intents.jsonl'), 2000));`),
  // the keyboard opens the focused row's menu: Shift+F10 and the menu key
  step(
    'shift-f10',
    `await close(); const row = node('httpbin:hb-headers'); const b = row?.querySelector('[data-tree-row]'); if (!b) return 'NO ROW'; b.focus();
     await __t.real.key('F10', { shift: true }); if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU'; const r = groups(); await close(); return r;`,
  ),
  step(
    'menu-key',
    `await close(); const row = node('mcp:petstore-mcp'); const b = row?.querySelector('[data-tree-row]'); if (!b) return 'NO ROW'; b.focus();
     await __t.real.key('ContextMenu'); if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU'; const r = groups(); await close(); return r;`,
  ),
  // the blank area of the sidebar: the workspace's menu
  step(
    'empty-area',
    `await close(); const pad = aside().querySelector('[data-explorer-area] > div[aria-hidden]'); if (!pad) return 'NO AREA'; pad.scrollIntoView({ block: 'end' });
     await __t.real.rightClick(pad); if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU'; const r = groups(); await close(); return r;`,
  ),
  // Expand all at depth: every folder of the collection opens; Collapse all closes them and the collection
  step(
    'expand-all',
    `await close(); const row = node('graphql-public'); row.scrollIntoView({ block: 'center' }); await __t.real.rightClick(row); await __t.waitFor(menuOpen, 2000);
     if (!(await pick('Expand all'))) return 'NO ITEM Expand all';
     await __t.waitFor(() => ![...document.querySelectorAll('[data-node-id^="graphql-public:"] [aria-expanded="false"]')].length, 3000);
     const folded = [...document.querySelectorAll('[data-node-id^="graphql-public:"] [data-tree-row][aria-expanded]')].filter((b) => b.getAttribute('aria-expanded') !== 'true').length;
     const open = [...document.querySelectorAll('[data-node-id^="graphql-public:"] [data-tree-row][aria-expanded="true"]')].length;
     return 'folded: ' + folded + ' | open: ' + open;`,
  ),
  step(
    'expand-all-section',
    `if (!(await menuOf(node('section:mcp')))) return 'NO MENU'; if (!(await pick('Collapse all'))) return 'NO ITEM Collapse all';
     await __t.waitFor(() => exp(node('section:mcp')) === 'false', 1500);
     const closed = exp(node('section:mcp')) + ',' + !node('mcp:folder:Public servers');
     if (!(await menuOf(node('section:mcp')))) return 'NO MENU'; if (!(await pick('Expand all'))) return 'NO ITEM Expand all';
     await __t.waitFor(() => exp(node('mcp:folder:Public servers')) === 'true', 2000);
     const folders = [...document.querySelectorAll('[data-node-id^="mcp:folder:"] [data-tree-row][aria-expanded]')].map((b) => b.getAttribute('aria-expanded'));
     return 'collapsed: ' + closed + ' | section: ' + exp(node('section:mcp')) + ' | folders: ' + folders.join(',');`,
  ),
  step(
    'collapse-folder-before-reload',
    `if (!(await menuOf(node('mcp:folder:Public servers')))) return 'NO MENU'; if (!(await pick('Collapse all'))) return 'NO ITEM Collapse all';
     await __t.waitFor(() => exp(node('mcp:folder:Public servers')) === 'false', 1500);
     return 'folder: ' + exp(node('mcp:folder:Public servers')) + ' | graphql folders open: ' + [...document.querySelectorAll('[data-node-id^="graphql-public:"] [data-tree-row][aria-expanded="true"]')].length;`,
  ),
  ['reload', RELOAD],
  step(
    'state-after-reload',
    `await __t.requests(); await __t.waitFor(() => node('mcp:folder:Public servers'), 4000);
     const folder = exp(node('mcp:folder:Public servers'));
     const gql = [...document.querySelectorAll('[data-node-id^="graphql-public:"] [data-tree-row][aria-expanded="true"]')].length;
     return 'folder: ' + folder + ' | graphql folders open: ' + gql;`,
  ),
  // the lists of the other views
  step('prompt', `await __t.view('AI Lab'); const r = await __t.waitFor(() => node('ai-saved:ai-intent'), 3000); return await both(r);`),
  step('prompt-folder', `return await both(node('ai-saved:folder:Offline demo model'));`),
  step('prompt-header', `return await both(node('ai-saved:section'));`),
  step('load-test', `await __t.view('Load'); return await both(await __t.waitFor(() => node('load-saved:lt-e2e'), 3000));`),
  step('evaluation', `await __t.view('Evaluations'); return await both(await __t.waitFor(() => node('eval-saved:ev-e2e'), 3000));`),
  step('monitor', `await __t.view('Monitors'); return await both(await __t.waitFor(() => byName('monitors:', 'Public APIs health'), 3000));`),
  step('test-folder', `await __t.view('Tests'); return await both(await __t.waitFor(() => node('tests:dir:rest'), 3000));`),
  step('test-file', `return await both(await __t.waitFor(() => node('tests:rest/httpbin.yaml'), 3000));`),
  step(
    'tests-empty-area',
    `await close(); const area = [...document.querySelectorAll('.overflow-auto')].find((x) => x.querySelector('[data-node-id^="tests:"]')); if (!area) return 'NO AREA';
     const pad = area.querySelector(':scope > div[aria-hidden]'); if (!pad) return 'NO BLANK AREA'; pad.scrollIntoView({ block: 'end' });
     await __t.real.rightClick(pad); if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU'; const g = groups(); await close(); return g;`,
  ),
  step(
    'history-row',
    `await window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:4010/health?menus-uniform=1', headers: [] }, name: 'E2E menus uniform' }).catch(() => undefined);
     await __t.view('History'); const row = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.getClientRects().length && /menus-uniform=1/.test(b.textContent)), 5000); if (!row) return 'NO ROW';
     return await both(row.parentElement);`,
  ),
  step(
    'environment',
    `await __t.view('Environments'); const row = await __t.waitFor(() => [...document.querySelectorAll('main [data-rename-id]')].find((b) => b.getClientRects().length && /Public APIs/.test(b.textContent)), 3000); return await both(row?.parentElement);`,
  ),
  // the look: comfortable and compact density, dark (the e2e default) and light
  step(
    'look-comfortable-dark',
    `await __t.requests(); const row = node('httpbin'); await __t.real.rightClick(row); await __t.waitFor(menuOpen, 2000); return 'density ' + document.documentElement.dataset.density + ' theme ' + document.documentElement.dataset.theme;`,
    true,
  ),
  step(
    'look-compact-dark',
    `await close(); document.documentElement.dataset.density = 'compact'; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
     await unfold(node('mcp:folder:Public servers')); // folded by Collapse all before the reload (and kept so)
     if (!(await menuOf(await __t.waitFor(() => node('mcp:petstore-mcp'), 2000)))) return 'NO MENU';
     const m = menuOpen().getBoundingClientRect(); const fits = m.bottom <= innerHeight && m.right <= innerWidth && m.left >= 0;
     return 'density ' + document.documentElement.dataset.density + ' | fits ' + fits;`,
    true,
  ),
  step(
    'look-compact-light',
    `await close(); document.documentElement.dataset.theme = 'light'; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
     if (!(await menuOf(node('specs:specs/petstore.json')))) return 'NO MENU';
     const r = 'theme ' + document.documentElement.dataset.theme + ' | items ' + menuOpen().querySelectorAll('[role=menuitem]').length;
     return r;`,
    true,
  ),
  step('look-reset', `await close(); document.documentElement.dataset.density = 'comfortable'; document.documentElement.dataset.theme = 'dark'; return 'ok';`),
];

const X = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\|/g, '\\|') + '$');
module.exports = withExpect(
  steps,
  {
    'open-explorer': /^ok$/,
    collection: X(
      'New HTTP request | New request | New folder… ‖ Expand all | Collapse all ‖ Run collection ‖ Copy link | Export ‖ Monitor on a schedule… | Run in CI… | Create test file from collection… | Generate integration flow with AI… | Settings, runner & docs | Convert scripts to tp.* ‖ Rename | Duplicate ‖ Delete…',
    ),
    category: X('New HTTP request ‖ Expand all | Collapse all ‖ Run collection'),
    folder: X(
      'New HTTP request | New folder… ‖ Expand all | Collapse all ‖ Run folder ‖ Copy link ‖ Monitor on a schedule… | Run in CI… | Create test file from folder… | Generate integration flow with AI… | Edit folder (scripts, variables, auth) ‖ Rename | Duplicate | Move to… ‖ Delete…',
    ),
    'request-http': X('Open | Open in new tab ‖ Copy link | Copy as ‖ Monitor on a schedule… | Save as test… ‖ Rename | Duplicate | Move to… | Remove from favorites ‖ Delete…'),
    'request-soap': X('Open | Open in new tab ‖ Copy link | Copy as ‖ Monitor on a schedule… | Save as test… ‖ Rename | Duplicate | Move to… | Add to favorites ‖ Delete…'),
    'request-graphql': X('Open | Open in new tab ‖ Copy link ‖ Monitor on a schedule… | Save as test… ‖ Rename | Duplicate | Move to… | Add to favorites ‖ Delete…'),
    'grpc-folder': X('Expand all | Collapse all ‖ Rename folder ‖ Delete folder…'),
    'grpc-call': X('Open | Open in new tab ‖ Copy link | Copy as grpcurl ‖ Save as test… ‖ Rename | Duplicate | Move to collection ‖ Delete…'),
    'ws-connection': X('Open | Open in new tab ‖ Copy link | Copy URL ‖ Save as test… ‖ Rename | Duplicate | Move to collection ‖ Delete…'),
    'favorites-section': X('Expand all | Collapse all'),
    favorite: X('Open | Open in new tab | Reveal in sidebar ‖ Copy link | Copy as ‖ Monitor on a schedule… | Save as test… ‖ Rename | Duplicate | Remove from favorites ‖ Delete…'),
    'mcp-section': X('Add an MCP server | New folder… ‖ Open MCP inspector ‖ Expand all | Collapse all'),
    'mcp-folder': X('Add an MCP server here ‖ Expand all | Collapse all ‖ Rename folder ‖ Delete folder…'),
    'mcp-server': X('Open | Open in new tab ‖ Connect ‖ Copy link | Copy MCP config ‖ Settings… ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    'spec-section': X('Import an OpenAPI document | New folder… ‖ Open API definitions ‖ Expand all | Collapse all'),
    spec: X('Open | Reveal file ‖ Lint | API coverage | Compare versions ‖ Copy link | Copy path ‖ Generate tests… | Generate integration flows… ‖ Rename | Move to folder ‖ Delete…'),
    'dataset-section': X('New CSV | New JSONL | New folder… | Generate test data… ‖ Expand all | Collapse all'),
    'dataset-folder': X('Expand all | Collapse all ‖ Rename folder ‖ Delete folder…'),
    dataset: X('Open | Reveal file | Preview ‖ Run a collection with it ‖ Copy link | Copy path ‖ Use in a test ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    'shift-f10': X('Open | Open in new tab ‖ Copy link | Copy as ‖ Monitor on a schedule… | Save as test… ‖ Rename | Duplicate | Move to… | Remove from favorites ‖ Delete…'),
    'menu-key': X('Open | Open in new tab ‖ Connect ‖ Copy link | Copy MCP config ‖ Settings… ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    'empty-area': /^New collection \| .+ ‖ Recently deleted… ‖ Expand all \| Collapse all ‖ Run in CI…$/,
    'expand-all': /^folded: 0 \| open: [1-9]\d*$/,
    'expand-all-section': /^collapsed: false,true \| section: true \| folders: true(,true)*$/,
    'collapse-folder-before-reload': /^folder: false \| graphql folders open: [1-9]\d*$/,
    reload: /^reloaded$/,
    'state-after-reload': /^folder: false \| graphql folders open: [1-9]\d*$/,
    prompt: X('Open | Open in new tab ‖ Copy link ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    'prompt-folder': X('Save current prompt here ‖ Expand all | Collapse all ‖ Rename folder ‖ Delete folder…'),
    'prompt-header': X('Save current prompt | New folder… ‖ Expand all | Collapse all'),
    'load-test': X('Open | Open in new tab ‖ Run ‖ Copy link ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    evaluation: X('Open | Open in new tab ‖ Run ‖ Copy link ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    monitor: X('Open | Open in new tab | Edit ‖ Run now | Resume ‖ Copy link ‖ Rename | Duplicate | Move to folder ‖ Delete…'),
    'test-folder': X('New test file here ‖ Expand all | Collapse all ‖ Run folder ‖ Run in CI… ‖ Rename folder ‖ Delete folder…'),
    'test-file': X(
      'Open | Reveal file ‖ Run | Run with data… | Run in several environments… ‖ Copy link | Copy path | Copy CLI command | Export as Arazzo… ‖ Monitor on a schedule… | Run in CI… | Expose as MCP tool… ‖ Rename | Duplicate ‖ Delete…',
    ),
    'tests-empty-area': /^New HTTP test \| .*New suite ‖ Expand all \| Collapse all ‖ Run in CI…$/,
    'history-row': /^Open( \| Open request)? \| Open trace ‖ Copy link ‖ Save as test… ‖ Delete…$/,
    environment: X('Open ‖ Make active ‖ Copy link ‖ Rename | Duplicate ‖ Delete…'),
    'look-comfortable-dark': /^density (comfortable|undefined) theme dark$/,
    'look-compact-dark': /^density compact \| fits true$/,
    'look-compact-light': /^theme light \| items \d+$/,
    'look-reset': /^ok$/,
  },
  { prepare },
);
