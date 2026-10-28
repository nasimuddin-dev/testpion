// Every list of saved items keeps its items in folders: the ones with no folder are in the built-in General folder (first,
// always there, cannot be renamed or deleted). Opens each foldered list (saved prompts, evaluations, load tests, monitors,
// MCP servers, API definitions, datasets) and checks, row by row, that no item row sits at the top level of its list (every
// item's nearest container above it is a folder row); then, with real input, moves an item out of General and back, and
// asks for a new folder called General.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** Fixtures: a loose evaluation and load test beside a foldered one (the examples have none). */
function prepare(ws) {
  writeFileSync(
    join(ws, 'library', 'load-tests.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        folders: ['Smoke'],
        items: [
          { id: 'lt-loose', name: 'Loose load', data: { kind: 'http', method: 'GET', url: 'http://127.0.0.1:4010/health', vus: 1, duration: 1 } },
          { id: 'lt-smoke', name: 'Smoke load', folder: 'Smoke', data: { kind: 'http', method: 'GET', url: 'http://127.0.0.1:4010/health', vus: 1, duration: 1 } },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(ws, 'library', 'evaluations.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'ev-loose', name: 'Loose evaluation', data: { dataset: 'intents.jsonl' } }] }, null, 2),
  );
}

const H = `
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const menuOpen = () => document.querySelector('[role=menu]');
  const close = async () => { if (!menuOpen()) return; await __t.real.key('Escape'); await __t.waitFor(() => !menuOpen(), 1500); };
  const kindOf = (b) => b.closest('[data-node-kind]')?.getAttribute('data-node-kind') ?? '';
  const isItem = (b) => !/^(section:|folder:)|^(category|favorites)$/.test(kindOf(b));
  /** The rows of a scope in order; each item must have a folder row as the nearest row above it with a lower level. */
  const audit = (scope) => {
    const rows = [...scope.querySelectorAll('[data-tree-row]')].filter(visible);
    const loose = []; let items = 0; const folders = [];
    rows.forEach((b, i) => {
      if (kindOf(b).startsWith('folder:')) folders.push(b.getAttribute('data-row-name'));
      if (!isItem(b)) return;
      items++;
      const level = Number(b.getAttribute('aria-level'));
      let parent; for (let j = i - 1; j >= 0 && !parent; j--) if (Number(rows[j].getAttribute('aria-level')) < level) parent = rows[j];
      if (!parent || !kindOf(parent).startsWith('folder:')) loose.push(b.getAttribute('data-row-name'));
    });
    return { loose, items, folders };
  };
  const report = (scope, what) => { if (!scope) return 'NO LIST ' + what; const a = audit(scope); return what + ' | items ' + (a.items > 0) + ' | loose: ' + (a.loose.join(', ') || 'none') + ' | first folder: ' + a.folders[0] + ' | General once: ' + (a.folders.filter((f) => f === 'General').length === 1); };
  const listOf = (kind) => [...document.querySelectorAll('[role=tree]')].find((t) => visible(t) && t.querySelector('[data-node-kind="section:' + kind + '"]'));
  const sectionOf = (id) => document.querySelector('aside[aria-label="Collections explorer"] [data-tree-section="' + id + '"]');
  const rowOf = (scope, name) => [...scope.querySelectorAll('[data-tree-row]')].find((b) => visible(b) && b.getAttribute('data-row-name') === name)?.closest('[data-node-id]');
  const parentName = (row) => { const rows = [...row.closest('[role=tree]').querySelectorAll('[data-tree-row]')].filter(visible); const level = Number(row.querySelector('[data-tree-row]').getAttribute('aria-level')); const i = rows.indexOf(row.querySelector('[data-tree-row]')); for (let j = i - 1; j >= 0; j--) if (Number(rows[j].getAttribute('aria-level')) < level) return rows[j].getAttribute('data-row-name'); return 'NONE'; };
  const item = (label) => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label);
  const off = (label) => { const m = item(label); return !m ? 'MISSING' : (m.disabled || m.getAttribute('aria-disabled') === 'true') ? 'disabled' : 'enabled'; };
  /** Move an item with real clicks: its menu, Move to folder, the folder. */
  const moveTo = async (row, folder) => {
    await close(); row.scrollIntoView({ block: 'center' }); await __t.real.rightClick(row);
    if (!(await __t.waitFor(menuOpen, 2000))) return false;
    const m = item('Move to folder'); if (!m) return false;
    await __t.real.click(m);
    const t = await __t.waitFor(() => item(folder), 1500); if (!t) return false;
    await __t.real.click(t); await __t.waitFor(() => !menuOpen(), 1500); await __t.sleep(700); return true;
  };
`;
const step = (name, body, shot) => [name, `(async () => { ${H} ${body} })()`, shot];

const steps = [
  // AI Lab: saved prompts (the examples keep some loose beside a folder)
  step('prompts', `await __t.view('AI Lab'); await __t.tab('Playground'); const s = await __t.waitFor(() => listOf('prompt'), 4000); await __t.sleep(600); return report(s, 'prompts');`),
  step('prompts-general', `const s = listOf('prompt'); const g = rowOf(s, 'General'); const r = rowOf(s, 'Haiku (try with a real model)'); return 'general: ' + !!g + ' | Haiku in: ' + (r ? parentName(r) : 'NO ROW');`),
  step('evaluations', `await __t.view('Evaluations'); const s = await __t.waitFor(() => listOf('evaluation'), 4000); await __t.sleep(600); return report(s, 'evaluations');`),
  step('load-tests', `await __t.view('Load'); const s = await __t.waitFor(() => listOf('load-test'), 4000); await __t.sleep(600); return report(s, 'load tests');`),
  step('monitors', `await __t.view('Monitors'); const s = await __t.waitFor(() => listOf('monitor'), 4000); await __t.sleep(600); return report(s, 'monitors') + ' | health: ' + parentName(rowOf(s, 'Public APIs health'));`),
  // the explorer's sections
  step('explorer', `await __t.requests(); await __t.sleep(800); return 'ok';`),
  step('mcp', `const s = sectionOf('mcp'); if (s) { const h = s.querySelector('[data-tree-row][aria-expanded="false"]'); if (h) await __t.real.click(h); } await __t.sleep(500); return report(sectionOf('mcp'), 'mcp servers');`),
  step('specs', `const s = sectionOf('specs'); const h = s?.querySelector('[data-tree-row][aria-level="1"][aria-expanded="false"]'); if (h) { await __t.real.click(h); await __t.sleep(500); } return report(sectionOf('specs'), 'api definitions');`),
  step('datasets', `const s = sectionOf('datasets'); const h = s?.querySelector('[data-tree-row][aria-level="1"][aria-expanded="false"]'); if (h) { await __t.real.click(h); await __t.sleep(500); } return report(sectionOf('datasets'), 'datasets');`),
  // General cannot be renamed or deleted
  step('general-menu', `const s = sectionOf('datasets'); const g = rowOf(s, 'General'); if (!g) return 'NO ROW General'; g.scrollIntoView({ block: 'center' }); await __t.real.rightClick(g); if (!(await __t.waitFor(menuOpen, 2000))) return 'NO MENU'; const r = 'rename ' + off('Rename folder') + ' | delete ' + off('Delete folder…'); await close(); return r;`),
  // move an item out of General and back (real input), in a FolderList
  step('move-out', `await __t.view('AI Lab'); await __t.tab('Playground'); const s = await __t.waitFor(() => listOf('prompt'), 4000); const r = rowOf(s, 'Haiku (try with a real model)'); const ok = await moveTo(r, 'Offline demo model'); return 'moved: ' + ok + ' | now in: ' + parentName(rowOf(listOf('prompt'), 'Haiku (try with a real model)'));`),
  step('move-back', `const r = rowOf(listOf('prompt'), 'Haiku (try with a real model)'); const ok = await moveTo(r, 'General'); return 'moved: ' + ok + ' | now in: ' + parentName(rowOf(listOf('prompt'), 'Haiku (try with a real model)')) + ' | ' + report(listOf('prompt'), 'prompts');`),
  // the same in an explorer section
  step('move-dataset', `await __t.requests(); await __t.sleep(500); const s = sectionOf('datasets'); const name = [...s.querySelectorAll('[data-tree-row]')].filter(visible).find((b) => kindOf(b) === 'dataset')?.getAttribute('data-row-name'); if (!name) return 'NO ROW dataset'; const ok1 = await moveTo(rowOf(s, name), 'New folder…') ; return 'asked: ' + ok1 + ' | dialog: ' + !!document.querySelector('[role=dialog] input');`),
  step('new-folder-general', `const input = document.querySelector('[role=dialog] input'); if (!input) return 'NO DIALOG'; await __t.real.click(input); await __t.real.keys('General'); await __t.real.key('Enter'); await __t.sleep(900); const toast = [...document.querySelectorAll('[role=status], [role=alert], [aria-live]')].map((t) => t.textContent).join(' '); const g = [...sectionOf('datasets').querySelectorAll('[data-tree-row]')].filter((b) => b.getAttribute('data-row-name') === 'General').length; return 'General rows: ' + g + ' | said exists: ' + /General exists/.test(toast) + ' | ' + report(sectionOf('datasets'), 'datasets');`),
];

module.exports = withExpect(
  steps,
  {
    prompts: /^prompts \| items true \| loose: none \| first folder: General \| General once: true$/,
    'prompts-general': /^general: true \| Haiku in: General$/,
    evaluations: /^evaluations \| items true \| loose: none \| first folder: General \| General once: true$/,
    'load-tests': /^load tests \| items true \| loose: none \| first folder: General \| General once: true$/,
    monitors: /^monitors \| items true \| loose: none \| first folder: General \| General once: true \| health: General$/,
    explorer: /^ok$/,
    mcp: /^mcp servers \| items true \| loose: none \| first folder: General \| General once: true$/,
    specs: /^api definitions \| items true \| loose: none \| first folder: General \| General once: true$/,
    datasets: /^datasets \| items true \| loose: none \| first folder: General \| General once: true$/,
    'general-menu': /^rename disabled \| delete disabled$/,
    'move-out': /^moved: true \| now in: Offline demo model$/,
    'move-back': /^moved: true \| now in: General \| prompts \| items true \| loose: none/,
    'move-dataset': /^asked: true \| dialog: true$/,
    'new-folder-general': /^General rows: 1 \| said exists: true \| datasets \| items true \| loose: none/,
  },
  { prepare },
);
