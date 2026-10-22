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

  it('the tokens the kinds use exist, each with its class', () => {
    const css = readFileSync(join(src, 'styles.css'), 'utf8');
    for (const k of ['graphql', 'grpc', 'ws', 'soap', 'api', 'script', 'mcp', 'agent', 'ai', 'dataset']) {
      expect(css, `--k-${k}`).toMatch(new RegExp(`--k-${k}:`));
      expect(css, `.kind-${k}`).toMatch(new RegExp(`\\.kind-${k}\\s*\\{`));
    }
  });
});
