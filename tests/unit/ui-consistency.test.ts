import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tabKeyTarget } from '../../apps/desktop/src/lib/tablist-keys';
import { TRAFFIC_KIND, trafficKindLabel } from '../../apps/desktop/src/lib/traffic-kinds';

/**
 * One shared component per UI pattern, identical in every view (UI audit 2026-10-21, groups C, D, E, G, K and the P2
 * list), kept by reading the source. Each rule says which component owns the pattern; an allow-list says why a file
 * may differ and only shrinks (an entry whose file no longer needs it fails too).
 */
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string, re = /\.tsx$/): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f), re) : re.test(f) ? [join(dir, f)] : []));
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');
const sources = files(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));
const scripts = files(SRC, /\.tsx?$/).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));
/** The text of a source without its comments (a comment may quote the old way). */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n');
const lineOf = (text: string, i: number) => text.slice(0, i).split('\n').length;

/** Every `<Name …>` opening tag of a source, JSX braces balanced, with its line. */
function tags(text: string, name: string): Array<{ tag: string; line: number; at: number }> {
  const out: Array<{ tag: string; line: number; at: number }> = [];
  for (let i = text.indexOf(`<${name}`); i >= 0; i = text.indexOf(`<${name}`, i + 1)) {
    if (/\w/.test(text[i + 1 + name.length] ?? '')) continue;
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push({ tag: text.slice(i, j + 1), line: lineOf(text, i), at: i });
  }
  return out;
}

/** The files of an allow-list that no longer need their entry (the list only shrinks). */
const stale = (allow: Record<string, string>, offenders: string[]) => Object.keys(allow).filter((f) => !offenders.some((o) => o.startsWith(`${f}:`) || o === f));

describe('tab strips: one component, named, with arrow keys (C1, C2, J2)', () => {
  it('a role="tab" is drawn only by the shared strips: Tabs (ui.tsx), DocTabStrip and the sidebar switch', () => {
    const OWNERS = ['components/ui.tsx', 'components/DocTabStrip.tsx', 'components/SidebarShell.tsx'];
    const off = sources.filter((s) => !OWNERS.includes(s.file) && /role="tab(list)?"/.test(code(s.text))).map((s) => s.file);
    expect(off).toEqual([]);
  });

  it('every <Tabs> names its tablist (label=)', () => {
    const off = sources.flatMap((s) =>
      tags(s.text, 'Tabs')
        .filter((t) => !/\slabel=/.test(t.tag))
        .map((t) => `${s.file}:${t.line}`),
    );
    expect(off).toEqual([]);
    // the prop is required, so a new strip can't forget it
    expect(readFileSync(join(SRC, 'components/ui.tsx'), 'utf8')).toMatch(/onChange\(v: NoInfer<T>\): void;\n\s+label: string;/);
  });

  it('← → Home End move between the tabs, wrapping round', () => {
    const ids = ['a', 'b', 'c'];
    expect(tabKeyTarget('ArrowRight', ids, 'a')).toBe('b');
    expect(tabKeyTarget('ArrowRight', ids, 'c')).toBe('a');
    expect(tabKeyTarget('ArrowLeft', ids, 'a')).toBe('c');
    expect(tabKeyTarget('Home', ids, 'b')).toBe('a');
    expect(tabKeyTarget('End', ids, 'a')).toBe('c');
    expect(tabKeyTarget('Enter', ids, 'a')).toBeUndefined();
    expect(tabKeyTarget('ArrowRight', [], undefined)).toBeUndefined();
    // and every strip uses them
    for (const f of ['components/ui.tsx', 'components/DocTabStrip.tsx', 'components/SidebarShell.tsx']) expect(readFileSync(join(SRC, f), 'utf8'), f).toContain('tabKeyTarget(');
  });
});

describe('header bars: one height (G1)', () => {
  /** A pane's one-line bar: a box with a line under it and a fixed height. */
  const BAR = /(?:^| )h-(\d+)(?: |$)/;
  const ALLOW: Record<string, string> = {
    'components/Shell.tsx': "the window's top bar (h-12) and the command palette's input (h-11) are not a pane's header",
    'views/HomeView.tsx': "a Home card's header (h-12), the card's title row, not a pane's bar",
    'components/AttentionCard.tsx': "Home's attention card: the same card header as HomeView's cards",
    'components/debugger/DebuggerGrid.tsx': "the traffic grid's column header row (role=row, h-7): a table's head, not a pane's bar",
    'components/debugger/DockRules.tsx': "the rules grid's column header row (h-7): a table's head, not a pane's bar",
    'views/DebuggerView.tsx': 'the requests-over-time chart (h-20): a chart area with a base line, not a bar',
  };
  it('a bar with a line under it is h-9 (Bar, OutputHeader, Tabs and DocTabStrip are), anywhere else', () => {
    const off: string[] = [];
    for (const s of sources) {
      if (s.file === 'components/ui.tsx') continue;
      for (const m of code(s.text).matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
        const c = m[1] ?? m[2] ?? '';
        const h = BAR.exec(c)?.[1];
        if (h && h !== '9' && /(?:^| )border-b border-line(?: |$)/.test(c)) off.push(`${s.file}:${lineOf(s.text, m.index!)} h-${h}`);
      }
    }
    expect(off.filter((o) => !Object.keys(ALLOW).some((f) => o.startsWith(`${f}:`)))).toEqual([]);
    expect(stale(ALLOW, off)).toEqual([]);
  });

  it('the bottom panel and its four panels draw the shared bars: the strip is Tabs, the panels Bar (or the terminal strip, DocTabStrip)', () => {
    const shell = readFileSync(join(SRC, 'components/Shell.tsx'), 'utf8');
    expect(shell).toMatch(/<Tabs\s+label="Bottom panel"/);
    for (const f of ['components/ProblemsPanel.tsx', 'components/ConsolePanel.tsx']) expect(readFileSync(join(SRC, f), 'utf8'), f).toContain('<Bar ');
    expect(shell).toMatch(/function AppLogs[\s\S]*<Bar /);
    expect(readFileSync(join(SRC, 'components/TerminalPanel.tsx'), 'utf8')).toMatch(/<DocTabStrip\s+label="Terminals"/);
    expect(readFileSync(join(SRC, 'components/output/OutputFrame.tsx'), 'utf8')).toContain('BAR_CLASS');
  });
});

describe('filter boxes: one component (D1)', () => {
  it('a text box whose placeholder or name starts with "Filter" is the shared FilterInput (one height, a name, Esc clears)', () => {
    const off: string[] = [];
    for (const s of sources) for (const name of ['Input', 'input']) for (const t of tags(s.text, name)) if (/\b(placeholder|aria-label)=(\{`|")Filter\b/.test(t.tag)) off.push(`${s.file}:${t.line}`);
    expect(off).toEqual([]);
  });

  it('FilterInput requires its name, and the list filters use it', () => {
    const ui = readFileSync(join(SRC, 'components/ui.tsx'), 'utf8');
    expect(ui).toContain('{ value: string; onChange(v: string): void; label: string }>(');
    expect(ui).toMatch(/export const FilterInput[\s\S]*?aria-label=\{label\}[\s\S]*?e\.key !== 'Escape'/);
    const USERS = [
      'views/TracesView.tsx',
      'views/HistoryView.tsx',
      'views/McpView.tsx',
      'views/GraphQLView.tsx',
      'views/WebSocketView.tsx',
      'components/JsonTable.tsx',
      'components/mcp/ToolsPanel.tsx',
      'components/SidebarPanes.tsx',
      'components/RunPanel.tsx',
      'components/JsonView.tsx',
      'components/ConsolePanel.tsx',
      'components/Explorer.tsx',
      'components/FolderList.tsx',
    ];
    for (const f of USERS) expect(readFileSync(join(SRC, f), 'utf8'), f).toContain('<FilterInput');
    // no box of its own size next to them
    const sized = sources.flatMap((s) =>
      tags(s.text, 'FilterInput')
        .filter((t) => /className="[^"]*\b(h-\d|min-h-|text-xs|text-sm)\b/.test(t.tag))
        .map((t) => `${s.file}:${t.line}`),
    );
    expect(sized).toEqual([]);
  });
});

describe('copy: one helper, one feedback (E1, E2)', () => {
  it('the clipboard is written in lib/clipboard.ts only, and nothing turns into a tick of its own', () => {
    const writes = scripts.filter((s) => s.file !== 'lib/clipboard.ts' && code(s.text).includes('navigator.clipboard.writeText')).map((s) => s.file);
    expect(writes).toEqual([]);
    expect(scripts.filter((s) => /\buseCopied\b/.test(code(s.text))).map((s) => s.file)).toEqual([]);
    expect(scripts.filter((s) => /textContent = 'Copied'|\? 'Copied' :/.test(code(s.text))).map((s) => s.file)).toEqual([]);
  });

  it('every copy button has a name: an IconButton labelled "Copy …", or a Button that says Copy', () => {
    const off: string[] = [];
    for (const s of sources) {
      for (const t of tags(s.text, 'IconButton'))
        if (/<Copy\b/.test(s.text.slice(t.at + t.tag.length, s.text.indexOf('</IconButton>', t.at))) && !/label=(\{`|")Copy\b/.test(t.tag)) off.push(`${s.file}:${t.line}`);
      for (const m of s.text.matchAll(/<button\b[^>]*>\s*(?:<Copy\b|\{copied)/g)) off.push(`${s.file}:${lineOf(s.text, m.index!)} (a button of its own)`);
    }
    expect(off).toEqual([]);
  });
});

describe('section titles, text sizes, icon sizes (G2, K3, K4)', () => {
  it('small capitals (uppercase + letter-spacing) are SectionTitle / SECTION_LABEL only, defined in ui.tsx', () => {
    const off = sources.filter((s) => s.file !== 'components/ui.tsx' && /\buppercase\b[^"'\n]*\btracking-|\btracking-[^"'\n]*\buppercase\b/.test(code(s.text))).map((s) => s.file);
    expect(off).toEqual([]);
  });

  it('text sizes come from the theme scale (text-3xs … text-hero in styles.css), never text-[11px] / text-[0.7rem]', () => {
    const ALLOW: Record<string, string> = {
      'components/FlowNode.tsx': "SVG text on the flow canvas: sizes in the canvas's own units, scaled by its zoom, not the page's",
      'components/FlowDrop.tsx': 'SVG text on the flow canvas (the drop hints): canvas units, scaled by its zoom',
    };
    const off = sources.flatMap((s) => [...code(s.text).matchAll(/(?<![\w-])text-\[\d+(\.\d+)?(px|rem)\]/g)].map((m) => `${s.file}:${m[0]}`));
    expect(off.filter((o) => !Object.keys(ALLOW).some((f) => o.startsWith(`${f}:`)))).toEqual([]);
    expect(stale(ALLOW, off)).toEqual([]);
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
    for (const t of ['2xs', '3xs', 'title', 'hero']) expect(css, `--text-${t}`).toMatch(new RegExp(`--text-${t}:`));
  });

  it('an IconButton sizes its own icon (one icon size per button size): no size={n} on the icon inside it', () => {
    const off: string[] = [];
    for (const s of sources) {
      if (s.file === 'components/ui.tsx') continue;
      for (const t of tags(s.text, 'IconButton')) {
        if (t.tag.endsWith('/>')) continue;
        const body = s.text.slice(t.at + t.tag.length, s.text.indexOf('</IconButton>', t.at));
        if (/<[A-Z]\w*\b[^<>]*\ssize=\{\d+\}/.test(body)) off.push(`${s.file}:${t.line}`);
        if (/className=(?:"|\{cx\(')[^"']*\b[hw]-\d\b/.test(t.tag)) off.push(`${s.file}:${t.line} (its size is the size prop)`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe('the rest of the P2 list', () => {
  it('a count says its noun with the shared plural(), never by hand', () => {
    const off = scripts.filter((s) => /=== 1 \? '' : 's'|=== 1 \? '\w*y' : '\w*ies'|=== 1 \? '(\w+)' : '\1(e?s)'/.test(code(s.text))).map((s) => s.file);
    expect(off).toEqual([]);
  });

  it('a kind of call has one name everywhere (lib/traffic-kinds.ts; item kinds are KIND_INFO): no KIND_LABEL map of a view', () => {
    expect(scripts.filter((s) => /const KIND_LABEL\b/.test(s.text)).map((s) => s.file)).toEqual([]);
    expect(trafficKindLabel('graphql')).toBe('GraphQL');
    expect(trafficKindLabel('llm')).toBe('AI');
    expect(trafficKindLabel('something-new')).toBe('something-new');
    for (const k of Object.values(TRAFFIC_KIND)) expect(k.label).toMatch(/^[A-Za-z]/);
    expect(scripts.filter((s) => s.file !== 'lib/traffic-kinds.ts' && /\bgraphql: 'GraphQL'/.test(code(s.text))).map((s) => s.file)).toEqual([]);
  });

  it('a drop-down is the shared Select: no native <select> outside ui.tsx', () => {
    const ALLOW: Record<string, string> = { 'components/KeyValueEditor.tsx': "a table cell's own editor (cell-input), drawn like the cell's text boxes, not a field" };
    const off = sources.filter((s) => s.file !== 'components/ui.tsx' && /<select\b/.test(code(s.text))).map((s) => s.file);
    expect(off.filter((f) => !(f in ALLOW))).toEqual([]);
    expect(Object.keys(ALLOW).filter((f) => !off.includes(f))).toEqual([]);
  });

  it('a status dot is StatusDot (one size, one shape); a colour swatch carries its colour in style', () => {
    const off = sources.flatMap((s) =>
      s.file === 'components/ui.tsx'
        ? []
        : code(s.text)
            .split('\n')
            .map((l, i) => ({ l, i }))
            .filter(({ l }) => /\b[wh]-(1\.5|2)\b[^"']*\brounded-full\b/.test(l) && /\bbg-(ok|bad|warn|accent|muted)\b/.test(l))
            .map(({ i }) => `${s.file}:${i + 1}`),
    );
    expect(off).toEqual([]);
  });

  it("an output's header row keeps its control in view: a bar with OutputActions shrinks its start (K1)", () => {
    const mcp = readFileSync(join(SRC, 'views/McpView.tsx'), 'utf8');
    const bar = mcp.slice(mcp.lastIndexOf('<Bar', mcp.indexOf('<OutputActions spec={spec} />')), mcp.indexOf('<OutputActions spec={spec} />'));
    expect(bar).toMatch(/overflow-clip/);
    expect(bar).toContain('<OutputBarStart>');
  });

  it('one name for one export: the collection export choices are one list (CollectionsView exportItems)', () => {
    const hits = scripts.filter((s) => s.text.includes("'Postman collection v2.1'")).map((s) => s.file);
    expect(hits).toEqual(['views/CollectionsView.tsx']);
    expect(scripts.filter((s) => /'as (Postman|Bruno|OpenAPI)/.test(s.text)).map((s) => s.file)).toEqual([]);
  });
});
