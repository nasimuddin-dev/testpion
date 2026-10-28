import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AI_JARGON, AI_JARGON_SCREEN_ONLY, BUNDLE_HINT, JARGON, LABEL, MENU_GROUPS, MENU_TEXT, RETIRED_LABELS, SET_ASIDE_HINT, STAGE_HINT } from '../../apps/desktop/src/lib/vocabulary';
import { railOrder, railShortcut, railTarget } from '../../apps/desktop/src/lib/rail';
import { CHECK_DEFS } from '../../apps/desktop/src/lib/check-defs';
import { metricCatalogueRows } from '../../packages/core/src/index';

// WF-13: one word per action and one menu order everywhere; the shortcuts follow the rail.
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
/** Files other work owns right now (WF-13 left their call sites as they are; see the plan's Built note). */
const NOT_YET = new Set(['components/RunPanel.tsx']);

describe('vocabulary', () => {
  it('the retired words are gone from menus, buttons and the palette', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel === 'lib/vocabulary.ts' || NOT_YET.has(rel)) continue;
      const text = readFileSync(f, 'utf8');
      for (const w of RETIRED_LABELS)
        if (text.includes(`'${w}'`) || text.includes(`>${w}<`) || new RegExp(`>\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`).test(text)) found.push(`${rel}: ${w}`);
    }
    expect(found).toEqual([]);
  });

  it('a menu item that deletes says so the one way', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (NOT_YET.has(rel)) continue;
      if (/label: 'Delete',\s*icon: <Trash2/.test(readFileSync(f, 'utf8'))) found.push(rel);
    }
    expect(found).toEqual([]);
    expect(LABEL.delete).toBe('Delete…');
  });

  // the files whose rows are nodes (MENU-1…3): their menus come from buildNodeMenu, labels from LABEL
  const NODE_VIEWS = [
      'components/CollectionTree.tsx',
      'components/Explorer.tsx',
      'components/ExplorerParts.tsx',
      'components/FolderList.tsx',
      'components/SidebarPanes.tsx',
      'components/TreeRowShell.tsx',
      'views/MonitorsView.tsx',
      'views/LoadView.tsx',
      'views/EvaluationsView.tsx',
      'views/ai/Playground.tsx',
      'views/TestsView.tsx',
      'views/TestsRunsList.tsx',
      'views/TestsTreeRows.tsx',
      'views/HistoryView.tsx',
      'views/TracesView.tsx',
      'views/EnvironmentsView.tsx',
      'views/ai/Providers.tsx',
      // UI audit 2026-10-21 A1-A5: their lists were rows of their own
      'views/McpView.tsx',
      'views/CollectionsView.tsx',
      'views/GitView.tsx',
      'components/TraceView.tsx',
    ];

  it('every list of items draws the one row: TreeRowShell (or FolderList, which is made of it), no row of its own', () => {
    // a list's own right-click handler or treeitem role is a row that is not TreeRowShell (an area's empty-space menu, `onContextMenu={area…}`, is allowed)
    const own = /onContextMenu=\{\(|role="treeitem"/;
    const off = NODE_VIEWS.filter((rel) => {
      const text = readFileSync(join(SRC, rel), 'utf8');
      return !/\b(TreeRowShell|FolderList|CollectionTreeRows)\b/.test(text) || (rel !== 'components/TreeRowShell.tsx' && own.test(text));
    });
    expect(off).toEqual([]);
    // the same selected colour everywhere: the token TreeRowShell paints (bg-accent-soft), never accent at an alpha
    const tinted = files(SRC).filter((f) => readFileSync(f, 'utf8').includes('bg-accent/10'));
    expect(tinted.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('tree and list menus are built by lib/node-menu.ts only: no menu literals in the views that show nodes', () => {
    const LITERAL = /label: (['"])(Open|Open in new tab|Rename|Rename folder|Duplicate|Delete|Delete…|Delete folder…|Move to…|Move to folder|Expand all|Collapse all|Expand|Collapse|Copy link|Run|Run now|Run folder|Run collection|Monitor on a schedule…|Run in CI…|History in git…|Make active|Edit|Pause|Resume|Settings)\1/;
    // (a tab of a view's tab strip, `{ id: 'run', label: 'Run' }`, names a page, not a menu item)
    const found = NODE_VIEWS.filter((rel) =>
      readFileSync(join(SRC, rel), 'utf8')
        .split('\n')
        .some((line) => LITERAL.test(line) && !/\bid: '[\w-]+'(?: as const)?, label:/.test(line)),
    );
    expect(found).toEqual([]);
  });

  it('one menu order', () => {
    expect(MENU_GROUPS).toEqual(['create', 'open', 'tree', 'run', 'share', 'tools', 'git', 'edit', 'danger']);
  });

  it('Ctrl+Alt+n follows the rail: Collections second, the request editors not numbered', () => {
    const nav = [
      { id: 'home', group: 'Start' },
      { id: 'rest', group: 'Requests' },
      { id: 'graphql', group: 'Requests' },
      { id: 'debugger', group: 'Testing' },
      { id: 'tests', group: 'Testing' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, group: 'Workspace' })),
    ];
    const order = railOrder(nav);
    expect(order.slice(0, 4)).toEqual(['home', 'collections', 'debugger', 'tests']);
    expect(railShortcut(order, 'collections', 'Ctrl')).toBe('Ctrl+Alt+2');
    expect(railShortcut(order, 'rest', 'Ctrl')).toBeUndefined();
    expect(railShortcut(order, 'v7', 'Ctrl')).toBeUndefined(); // past 9
    expect(railTarget(order, 3)).toBe('debugger');
    expect(railTarget(order, 0)).toBeUndefined();
  });

  // the docs name what the screen says: the words the app retired or hides are not in the docs either (2026-10-27 review). The release
  // notes and the generated migration pages keep the words of their day; DOCS_KNOWN is the older pages still to be reworded: it only shrinks.
  const DOCS = join(__dirname, '../../docs');
  const mdFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (/^(node_modules|\.vitepress|public|migrate)$/.test(f) ? [] : statSync(join(dir, f)).isDirectory() ? mdFiles(join(dir, f)) : f.endsWith('.md') ? [join(dir, f)] : []));
  const DOCS_KNOWN = new Set<string>([
    'ai-testing/ai-features.md: preferStable',
    'ai-testing/ai-features.md: TODO(import)',
    'ai-testing/ai-features.md: Suggest assertions',
    'ai-testing/mcp-server.md: stable format',
    'ai-testing/mcp-server.md: merge and diff drivers',
    'ai-testing/mcp-server.md: runtime variables',
    'ai-testing/overview.md: Suggest assertions',
    'api-testing/collections.md: TODO(import)',
    'api-testing/grpc.md: Move to',
    'api-testing/rest.md: Suggest assertions',
    'api-testing/websocket.md: Move to',
    'architecture/design.md: Suggest assertions',
    'architecture/execution-engine.md: runtime variables',
    'cli/reference.md: textconv',
    'cli/reference.md: stable format',
    'cli/reference.md: pre-commit hook',
    'cli/reference.md: tracked files',
    'cli/reference.md: merge and diff drivers',
    'cli/reference.md: TODO(import)',
    'getting-started/git.md: textconv',
    'getting-started/git.md: stable format',
    'getting-started/git.md: pre-commit hook',
    'getting-started/git.md: attribute files',
    'getting-started/git.md: LFS server',
    'getting-started/git.md: .ref file',
    'getting-started/import-fidelity.md: TODO(import)',
    'getting-started/import-fidelity.md: runtime variables',
    'test-runner/overview.md: runtime variables',
  ]);
  it('the docs use no jargon word and no retired label as a label (the HTTP Debugger page: none at all)', () => {
    const found: string[] = [];
    for (const f of mdFiles(DOCS)) {
      const rel = f.slice(DOCS.length + 1).replace(/\\/g, '/');
      if (/^(changelog\.md|getting-started\/whats-new\.md)$/.test(rel)) continue;
      const text = readFileSync(f, 'utf8');
      for (const w of JARGON) if (text.includes(w) && !DOCS_KNOWN.has(`${rel}: ${w}`)) found.push(`${rel}: ${w}`);
      for (const w of AI_JARGON) if (text.includes(w) && !DOCS_KNOWN.has(`${rel}: ${w}`)) found.push(`${rel}: ${w}`);
      // a retired label named as a current one: in bold (**Start capturing**) or as a button
      for (const w of RETIRED_LABELS) if (text.includes(`**${w}**`) && !DOCS_KNOWN.has(`${rel}: ${w}`)) found.push(`${rel}: ${w}`);
    }
    expect(found).toEqual([]);
    // the Debugger page is clean without an allowance
    expect([...DOCS_KNOWN].filter((k) => k.startsWith('api-testing/http-debugger.md'))).toEqual([]);
  });

  it('the words of the tools underneath are not in what a screen shows: each is said in plain words', () => {
    // the text a person reads: string literals and JSX text (comments and identifiers are not), in every component and view
    const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g;
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (!/^(components|views)\//.test(rel)) continue;
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      for (const m of code.matchAll(literal)) for (const w of JARGON) if (m[0].includes(w)) found.push(`${rel}: ${w}`);
    }
    expect(found).toEqual([]);
  });

  it('what a screen says is in sentence case: a label, a title, a placeholder, an option, a button (UI audit H1)', () => {
    // names of products, formats and the app's own named places keep their capitals; everything else after the first word is lower case
    const PHRASES = ['TestPion HTTP Debugger Root', 'Claude Code', 'Claude Desktop', 'VS Code', 'GitHub Actions', 'Azure Pipelines', 'Azure DevOps', 'JSON Schema', 'JSON Lines', 'AWS Signature', 'Basic Auth', 'AI Lab', 'HTTP Debugger', 'REST Client', 'Socket.IO', 'Quick Open', 'Collections explorer'];
    const PROPER = new Set(
      'TestPion Postman Insomnia Bruno Hoppscotch GraphQL OpenAPI AsyncAPI WebSocket Kafka Claude Cursor Windsurf Codex Copilot GitHub GitLab Bitbucket Azure Jenkins Windows Linux Firefox Chrome Fiddler Markdown Python Node Docker OpenSSL JetBrains Ragas DeepEval PowerShell Git Ollama OpenAI Anthropic Gemini Authorization You'.split(' '),
    );
    // a short label (a long text with a full stop, a colon, brackets or ▸ is a sentence or a hint, not a label)
    const PATTERNS = [/\b(?:label|title|hint|placeholder|empty)(?:=|: )'([^'\n]+)'/g, /\b(?:label|title|placeholder|aria-label)="([^"\n]+)"/g, /<option\b[^>]*>([^<{]+)<\/option>/g, />([A-Z][^<>{}\n]*?)</g];
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel === 'monaco.ts') continue;
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      for (const re of PATTERNS)
        for (const m of code.matchAll(re)) {
          const text = m[1]!.trim();
          if (/[(▸:;?!—]|\. |https?|\$\{|\{\{/.test(text) || text.split(/\s+/).length > 6) continue;
          let s = text.replace(/^[^A-Za-z]+/, '');
          for (const p of PHRASES) s = s.split(p).join('x');
          const capitalised = s
            .split(/[\s/]+/)
            .slice(1)
            .map((w) => w.replace(/[^A-Za-z0-9.'’-]/g, ''))
            .filter((w) => /^[A-Z][a-z]+$/.test(w) && !PROPER.has(w));
          if (capitalised.length) found.push(`${rel}: "${text}" (${capitalised.join(', ')})`);
        }
    }
    expect(found).toEqual([]);
  });

  it('the AI quality screens use plain names: no field or check label of the tools underneath (AU-2)', () => {
    const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g;
    const AI_FILES = /^(components\/AssertionEditor\.tsx|components\/rag\/|views\/EvaluationsView\.tsx|views\/ai\/|lib\/check-defs\.ts)/;
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (!AI_FILES.test(rel)) continue;
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      for (const m of code.matchAll(literal)) for (const w of [...AI_JARGON, ...AI_JARGON_SCREEN_ONLY]) if (m[0].includes(w)) found.push(`${rel}: ${w}`);
    }
    expect(found).toEqual([]);
  });

  it('every check says in one sentence what it decides; so does every metric of the catalogue (AU-3)', () => {
    expect(CHECK_DEFS.length).toBeGreaterThan(40);
    expect(new Set(CHECK_DEFS.map((d) => d.type)).size).toBe(CHECK_DEFS.length);
    for (const d of CHECK_DEFS) {
      expect(d.what, d.type).toMatch(/^[A-Z].{12,}\.$/);
      expect(d.what.split('. ').length, `${d.type} is one sentence`).toBe(1);
    }
    const rows = metricCatalogueRows();
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => !r.what || r.what.trim().length < 10).map((r) => r.id)).toEqual([]);
  });

  it('stage, set aside and bundle are explained once, in plain words', () => {
    expect(STAGE_HINT).toMatch(/^Stage means choose what the next commit includes/);
    expect(SET_ASIDE_HINT).toMatch(/^Set aside puts your uncommitted changes away/);
    expect(BUNDLE_HINT).toMatch(/^A bundle is one file that holds several items/);
    for (const text of [STAGE_HINT, SET_ASIDE_HINT, BUNDLE_HINT]) for (const w of JARGON) expect(text).not.toContain(w);
    // the whole-workspace entries of File ▸ Export say which is which, in the menu of the window too
    expect(MENU_TEXT.exportBundle).toBe('Workspace as a Bundle…');
    expect(MENU_TEXT.exportLegacy).toContain('older format');
    const menu = readFileSync(join(SRC, '..', 'electron', 'app-menu.ts'), 'utf8');
    expect(menu).toContain(`label: '${MENU_TEXT.exportBundle}'`);
    expect(menu).toContain(`label: '${MENU_TEXT.exportLegacy}'`);
    expect(menu).toContain(`label: '${MENU_TEXT.importBundle}'`);
  });
});
