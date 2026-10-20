// Everything under Git, release A (planning/git-everything.md): a change shows as a mark on the item's own row and as a
// count on its section header (MCP servers, API definitions, datasets), and the Git view names it by the item ("MCP
// server DeepWiki docs", "API definition petstore.json: 1 operation added", "Dataset intents.jsonl: 1 line added") with
// its kind icon, Compare and the shared down arrow, not by its file. Real input for the rename and the clicks; the spec
// and the dataset are changed on disk, as another editor would.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const row = (id) => document.querySelector('[data-node-id="' + id + '"]');
  const mark = (id) => row(id)?.querySelector('[data-change-mark]');
  const markText = (id) => { const m = mark(id); return m ? m.getAttribute('data-change-mark') + (m.getAttribute('data-change-count') ? ':' + m.getAttribute('data-change-count') : '') : 'none'; };
  const items = () => vis('main [data-change-item]');
`;
const s = (name, body) => step(name, body, true, { extra: H, short: 400 });

const steps = [
  s('repo-init', `await window.aps.invoke('git.init', {}); await window.aps.invoke('git.check'); return 'initialized';`),
  // the examples hold demo passwords, which the commit's secret scan refuses for good (no "commit anyway"): the base commit is made with git itself
  [
    'base-commit',
    `main:
      const { execFileSync } = require('node:child_process'); const cwd = require('node:path').join(home, 'ws');
      execFileSync('git', ['add', '-A'], { cwd }); execFileSync('git', ['commit', '-m', 'Base'], { cwd });
      return 'committed';`,
    false,
  ],
  s('repo-ready', `await window.aps.invoke('git.stage', { paths: [] }); await __t.sleep(800); const st = await window.aps.invoke('git.status'); return 'committed | changes: ' + st.files.length;`),
  // real input: right-click the MCP server's row, Rename, type, Enter
  s(
    'rename-an-mcp-server',
    `await __t.requests();
     const r = await __t.waitFor(() => row('mcp:deepwiki')?.querySelector('[data-tree-row]'), 4000); if (!r) return 'NO ROW';
     r.scrollIntoView({ block: 'center' }); await __t.sleep(200);
     await __t.real.rightClick(r);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Rename')), 2000); if (!item) return 'NO MENU';
     await __t.real.click(item);
     const field = await __t.waitFor(() => row('mcp:deepwiki')?.querySelector('input'), 2000); if (!field) return 'NO INPUT';
     field.focus(); await __t.real.key('a', { ctrl: true });
     await __t.real.type('DeepWiki docs'); await __t.real.key('Enter');
     const got = await __t.waitFor(() => markText('mcp:deepwiki') !== 'none' && markText('mcp:deepwiki'), 10000);
     const header = await __t.waitFor(() => markText('section:mcp') !== 'none' && markText('section:mcp'), 4000);
     return 'row mark: ' + got + ' | section header: ' + header;`,
  ),
  s(
    'git-view-names-the-item',
    `await __t.view('Git');
     const li = await __t.waitFor(() => items().find((i) => /MCP server DeepWiki docs/.test(short(i.textContent))), 8000); if (!li) return 'NO ROW: ' + items().map((i) => short(i.textContent, 60)).join(' / ');
     const file = li.closest('[data-change-file]')?.getAttribute('data-change-file');
     return 'title: ' + short(li.querySelector('a, span.truncate')?.textContent) + ' | details: ' + /renamed from DeepWiki/.test(li.textContent) + ' | icon: ' + !!li.querySelector('svg') + ' | mark: ' + li.querySelector('[data-change-mark]')?.getAttribute('data-change-mark') + ' | file (muted): ' + file + ' | starts with the name, not the path: ' + !/^[A-Z!]?mcp-servers/.test(short(li.closest('li[data-change-file]')?.textContent));`,
  ),
  s(
    'compare-the-server',
    `const li = items().find((i) => /MCP server DeepWiki docs/.test(short(i.textContent))); if (!li) return 'NO ROW';
     const compare = [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Compare'); if (!compare) return 'NO BUTTON';
     await __t.real.click(compare);
     const name = await __t.waitFor(() => document.querySelector('[role=dialog] [data-item-diff] [data-part=Name]'), 6000); if (!name) return 'NO DIALOG';
     const text = short(name.textContent, 120);
     await __t.esc();
     return 'name part: ' + /DeepWiki/.test(text) + ' / ' + /DeepWiki docs/.test(text);`,
  ),
  [
    'outside-edits',
    `main:
      const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
      const { join } = require('node:path');
      const spec = join(home, 'ws', 'specs', 'petstore.json');
      const doc = JSON.parse(readFileSync(spec, 'utf8'));
      doc.paths['/owners'] = { get: { operationId: 'listOwners', responses: { '200': { description: 'ok' } } } };
      writeFileSync(spec, JSON.stringify(doc, null, 2) + '\\n');
      appendFileSync(join(home, 'ws', 'datasets', 'intents.jsonl'), '{"text":"a new row from outside"}\\n');
      return 'edited';`,
    false,
  ],
  s(
    'marks-on-rows-and-headers',
    `await __t.requests();
     const ok = await __t.waitFor(() => markText('specs:specs/petstore.json') !== 'none' && markText('datasets:intents.jsonl') !== 'none', 15000);
     return 'spec row: ' + markText('specs:specs/petstore.json') + ' | dataset row: ' + markText('datasets:intents.jsonl') + ' | server row: ' + markText('mcp:deepwiki') + ' | headers: specs ' + markText('section:specs') + ', datasets ' + markText('section:datasets') + ', mcp ' + markText('section:mcp') + ' | settled: ' + !!ok;`,
  ),
  s(
    'git-view-rows-for-spec-and-dataset',
    `await __t.view('Git');
     const spec = await __t.waitFor(() => items().find((i) => /API definition petstore\\.json/.test(short(i.textContent))), 8000);
     const data = items().find((i) => /Dataset intents\\.jsonl/.test(short(i.textContent)));
     if (!spec || !data) return 'NO ROW: ' + items().map((i) => short(i.textContent, 60)).join(' / ');
     return 'spec: ' + short(spec.textContent, 90) + ' | dataset: ' + short(data.textContent, 90) + ' | icons: ' + (!!spec.querySelector('svg') && !!data.querySelector('svg'));`,
  ),
  s(
    'the-down-arrow',
    `const bar = document.querySelector('[data-output="git.diff"]');
     const control = bar?.querySelector('[data-output-control="git.diff"]');
     const download = control?.querySelector('[data-output-download]');
     return 'surface: ' + !!bar + ' | control: ' + !!control + ' | download enabled: ' + (!!download && !download.disabled) + ' | formats: ' + !!control?.querySelector('[data-output-formats]');`,
  ),
  s(
    'discarded-changes-lose-their-marks',
    `const st = await window.aps.invoke('git.status');
     await window.aps.invoke('git.discard', { files: st.files });
     await __t.requests();
     const gone = await __t.waitFor(() => markText('specs:specs/petstore.json') === 'none' && markText('datasets:intents.jsonl') === 'none' && markText('mcp:deepwiki') === 'none' && markText('section:mcp') === 'none', 15000);
     return 'marks gone: ' + !!gone + ' | server name back: ' + (/^DeepWiki$/.test(short(row('mcp:deepwiki')?.querySelector('.truncate')?.textContent)));`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'repo-init': /^initialized$/,
    'base-commit': /^committed$/,
    'repo-ready': /^committed \| changes: 0$/,
    'rename-an-mcp-server': /^row mark: R \| section header: M:1$/,
    'git-view-names-the-item': /^title: MCP server DeepWiki docs \| details: true \| icon: true \| mark: R \| file \(muted\): mcp-servers\.json \| starts with the name, not the path: true$/,
    'compare-the-server': /^name part: true \/ true$/,
    'outside-edits': /^edited$/,
    'marks-on-rows-and-headers': /^spec row: M \| dataset row: M \| server row: R \| headers: specs M:1, datasets M:1, mcp M:1 \| settled: true$/,
    'git-view-rows-for-spec-and-dataset': /^spec: .?API definition petstore\.json.*1 operation added.* \| dataset: .?Dataset intents\.jsonl.*1 line added.* \| icons: true$/,
    'the-down-arrow': /^surface: true \| control: true \| download enabled: true \| formats: true$/,
    'discarded-changes-lose-their-marks': /^marks gone: true \| server name back: true$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
