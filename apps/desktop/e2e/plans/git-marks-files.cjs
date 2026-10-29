// Everything under Git: the kinds with no list of their own show their change mark where the window shows them: Environments ▸
// Workspace variables (workspace.json) and the MCP server's mock file field. Both files are changed on disk, as another editor
// would; the mark is the one shared change mark (data-change-mark) and goes away when the change is discarded.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const tabs = () => [...document.querySelectorAll('main [role=tab]')].filter((t) => t.offsetParent && !t.closest('[aria-label="Open environments"]'));
  const markIn = (root) => { const m = root?.querySelector('[data-change-mark]'); return m ? m.getAttribute('data-change-mark') : 'none'; };
  const wsPane = () => [...document.querySelectorAll('main div')].find((d) => d.offsetParent && /^Workspace variables/.test(d.textContent.trim()) && d.children.length <= 1 && d.classList.contains('font-medium'));
`;
const s = (name, body) => step(name, body, true, { extra: H, short: 400 });

const steps = [
  s('repo-init', `await window.aps.invoke('git.init', {}); await window.aps.invoke('git.check'); return 'initialized';`),
  [
    'base-commit',
    `main:
      const { execFileSync } = require('node:child_process'); const cwd = require('node:path').join(home, 'ws');
      execFileSync('git', ['add', '-A'], { cwd }); execFileSync('git', ['commit', '-m', 'Base'], { cwd });
      return 'committed';`,
    false,
  ],
  [
    'outside-edits',
    `main:
      const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
      const { join } = require('node:path');
      const ws = join(home, 'ws', 'workspace.json');
      const doc = JSON.parse(readFileSync(ws, 'utf8'));
      doc.variables = [...(doc.variables ?? []), { key: 'team_id', value: 'platform', enabled: true }];
      writeFileSync(ws, JSON.stringify(doc, null, 2) + '\\n');
      appendFileSync(join(home, 'ws', 'mocks', 'weather.mcp-mock.yaml'), '\\n# edited outside\\n');
      return 'edited';`,
    false,
  ],
  s(
    'workspace-variables-show-the-mark',
    `await __t.view('Environments'); await __t.sleep(800);
     const t = tabs().find((x) => x.textContent.trim().startsWith('Workspace variables')); if (!t) return 'NO TAB';
     t.click(); await __t.sleep(600);
     const ok = await __t.waitFor(() => markIn(wsPane()) !== 'none', 15000);
     return 'mark: ' + markIn(wsPane()) + (markIn(wsPane()) === 'none' ? ' | ' + JSON.stringify((await window.aps.invoke('git.changes')).changes.map((c) => [c.file, c.kindId, c.ref])).slice(0, 400) + ' | pane: ' + !!wsPane() : '');`,
  ),
  s(
    'discarded-workspace-change-loses-its-mark',
    `const st = await window.aps.invoke('git.status');
     await window.aps.invoke('git.discard', { files: st.files.filter((f) => f.path === 'workspace.json') });
     const gone = await __t.waitFor(() => markIn(wsPane()) === 'none', 15000);
     return 'mark gone: ' + !!gone;`,
  ),
  s(
    'mock-file-shows-the-mark',
    `await __t.esc(); const went = await __t.rail('Collections'); await __t.sleep(1500);
     const f = document.querySelector('aside input[placeholder^="Filter"]'); if (!f) return 'NO FILTER | ' + [...document.querySelectorAll('aside input')].map((i) => i.placeholder).join(',') + ' | nav: ' + [...document.querySelectorAll('nav [aria-label]')].map((n) => n.getAttribute('aria-label')).join(',') + ' | went: ' + went + ' | current: ' + document.querySelector('nav [aria-current=page]')?.getAttribute('aria-label');
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'Weather'); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(800);
     const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('Weather (offline mock)')); if (!r) return 'NO ROW';
     r.click(); await __t.sleep(1200);
     const st2 = [...document.querySelectorAll('main [role=tab]')].find((x) => x.offsetParent && x.textContent.trim() === 'Settings'); if (!st2) return 'NO SETTINGS TAB';
     st2.click(); await __t.sleep(800);
     const input = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && !i.getAttribute('aria-label') && /\\.mcp-mock\\.yaml$/.test(i.value)); if (!input) return 'NO MOCK FIELD';
     const ok = await __t.waitFor(() => markIn(input.closest(".flex.items-center") ?? input.parentElement) !== 'none', 15000);
     return 'file: ' + input.value + ' | mark: ' + markIn(input.closest(".flex.items-center") ?? input.parentElement);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'repo-init': /^initialized$/,
    'base-commit': /^committed$/,
    'outside-edits': /^edited$/,
    'workspace-variables-show-the-mark': /^mark: [AM]$/,
    'discarded-workspace-change-loses-its-mark': /^mark gone: true$/,
    'mock-file-shows-the-mark': /^file: mocks\/weather\.mcp-mock\.yaml \| mark: M$/,
  },
  { env: { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } },
);
