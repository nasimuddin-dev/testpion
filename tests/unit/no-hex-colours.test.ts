import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The colour of a kind of item (GraphQL, gRPC, WebSocket, SOAP, an API definition, a script, an MCP server, an agent,
 * an AI item, a dataset) is one token in styles.css (`--k-*`, with a `.kind-*` class each), so a badge in a tree, a
 * tab and a run list is the same colour, in both themes. A hex literal in a utility class (`text-[#e535ab]`) is a
 * colour nobody else can match: a new one fails here; the files that still have one are listed, and the list only
 * shrinks (a file that lost its last literal must leave it).
 */
const root = join(__dirname, '..', '..');
const src = join(root, 'apps', 'desktop', 'src');
const rel = (f: string) => relative(src, f).split(sep).join('/');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const HEX_UTILITY = /\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|shadow)-\[#[0-9a-fA-F]{3,8}\]/g;

/** The files that still carry a hex utility, each with why it is not done yet (the tree and explorer rows are moved to the tokens with the tree work). */
const NOT_YET: Record<string, string> = {
};

/**
 * A hex colour in a JS string or a style object (`'#0969da'`, `background: '#888'`) is a colour nobody else can match,
 * and it does not change with the theme (the trace waterfall was GitHub-light in dark mode). The files that may carry
 * one, each with why (data, not styling, or a library that reads hex only); the list only shrinks.
 */
const HEX_STRING = /(['"`])[^'"`\n]*#[0-9a-fA-F]{3,8}\b[^'"`\n]*\1/g;
const HEX_ALLOWED: Record<string, string> = {
  'monaco.ts': "the code editor's two themes: Monaco reads hex colours only, one table per theme",
  'components/TerminalPanel.tsx': 'the two xterm ANSI palettes (one per theme): xterm reads hex colours only',
  'lib/drag-ref.ts': "fallbacks of var(--panel2, #333) for a drag image drawn outside the app's styles",
  'views/EnvironmentsView.tsx': "the default value of an <input type=color> (an environment's colour is data)",
  'components/debugger/DockRules.tsx': "a highlight rule's colours: data the person picks with <input type=color>, one per theme",
  'components/debugger/DebuggerGrid.tsx': "a new highlight rule's starting colours (data stored in the rule, editable)",
};
/** The text without comments (a comment may quote a colour). */
const uncommented = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('kind colours are tokens', () => {
  const sources = files(src).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));
  const offenders = new Map<string, string[]>();
  for (const s of sources) {
    const found = [...s.text.matchAll(HEX_UTILITY)].map((m) => m[0]);
    if (found.length) offenders.set(s.file, [...new Set(found)]);
  }

  it('no hex colour in a utility class outside the files that are not done yet', () => {
    const fresh = [...offenders].filter(([f]) => !(f in NOT_YET)).map(([f, hex]) => `${f}: ${hex.join(', ')} (use .kind-* or a token from styles.css)`);
    expect(fresh).toEqual([]);
  });

  it('one selected-row colour: the bg-accent-soft token (light and dark), never the accent at 10 % over whatever is behind', () => {
    expect(sources.filter((s) => s.text.includes('bg-accent/10')).map((s) => s.file)).toEqual([]);
  });

  it('the list of files not done yet only shrinks', () => {
    expect(Object.keys(NOT_YET).filter((f) => !offenders.has(f))).toEqual([]);
    for (const why of Object.values(NOT_YET)) expect(why).toMatch(/.{12,}/);
  });

  it('no hex colour in a JS string or a style object either, outside the files that hold data or feed a hex-only library', () => {
    const found = sources.filter((s) => [...uncommented(s.text).matchAll(HEX_STRING)].length).map((s) => s.file);
    expect(found.filter((f) => !(f in HEX_ALLOWED))).toEqual([]);
    // the list only shrinks
    expect(Object.keys(HEX_ALLOWED).filter((f) => !found.includes(f))).toEqual([]);
    for (const why of Object.values(HEX_ALLOWED)) expect(why).toMatch(/.{20,}/);
  });

  it('one dim overlay behind a dialog or a palette: the --overlay token, never bg-black/ or bg-white/ at an alpha', () => {
    expect(sources.filter((s) => s.file !== 'components/ui.tsx' && /\bbg-(black|white)\//.test(s.text)).map((s) => s.file)).toEqual([]);
    expect(sources.filter((s) => s.text.includes('bg-[var(--overlay)]')).map((s) => s.file).sort()).toEqual(['components/Shell.tsx', 'components/ui.tsx']);
  });

  it('the tokens the kinds use exist, each with its class, in both themes', () => {
    const css = readFileSync(join(src, 'styles.css'), 'utf8');
    const dark = css.slice(css.indexOf("[data-theme='dark'] {"), css.indexOf('@theme inline'));
    for (const k of ['graphql', 'grpc', 'ws', 'soap', 'api', 'script', 'mcp', 'agent', 'ai', 'dataset', 'http', 'tool', 'evaluation', 'test', 'internal']) {
      expect(css, `--k-${k}`).toMatch(new RegExp(`--k-${k}:`));
      expect(dark, `--k-${k} (dark)`).toMatch(new RegExp(`--k-${k}:`));
      expect(css, `.kind-${k}`).toMatch(new RegExp(`\\.kind-${k}\\s*\\{`));
    }
  });
});
