import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The shape of the code base, kept by a test (see docs/contributing/architecture.md):
 *
 * - packages/core      the engine: no Electron, no React, nothing from the apps. Runs in the CLI, the desktop app and (later) a server.
 * - packages/cli       commands over core: no Electron, no React.
 * - apps/desktop/backend  RPC handlers over core: no React, nothing from the renderer (src/).
 * - apps/desktop/src   the renderer: talks to the backend only through RPC (api.ts); no Node, no Electron, no backend files,
 *                      and from core only types (the cloud version serves the same UI from a server).
 * - the big files stay as big as they are, at most: new tools and handlers go into their own modules.
 */
const root = resolve(__dirname, '..', '..');

function files(dir: string, exts = ['.ts', '.tsx', '.mts', '.cts']): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(join(root, dir));
  return out;
}

/** Every import specifier of a file, with whether it is a type-only import. */
function imports(file: string): Array<{ spec: string; typeOnly: boolean }> {
  const text = readFileSync(file, 'utf8');
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
    out.push({ spec: m[2] ?? m[3] ?? m[4] ?? m[5]!, typeOnly: !!m[1] });
  }
  return out;
}

const rel = (f: string) => relative(root, f).split(sep).join('/');

function offenders(dir: string, forbidden: (i: { spec: string; typeOnly: boolean }) => boolean): string[] {
  const out: string[] = [];
  for (const f of files(dir)) for (const i of imports(f)) if (forbidden(i)) out.push(`${rel(f)} imports ${i.spec}`);
  return out;
}

describe('architecture', () => {
  it('core knows nothing of Electron, React or the apps', () => {
    expect(offenders('packages/core/src', (i) => /^(electron|react|react-dom)(\/|$)/.test(i.spec) || i.spec.includes('apps/desktop'))).toEqual([]);
  });

  it('shared is for every host: no Node, no Electron, no React, no DOM library', () => {
    expect(
      offenders(
        'packages/shared/src',
        (i) => /^node:/.test(i.spec) || /^(electron|react|react-dom|fs|path|crypto|os|child_process|net|http|https|stream|buffer)(\/|$)/.test(i.spec) || i.spec.includes('@testpion/core'),
      ),
    ).toEqual([]);
    expect(readFileSync(join(root, 'packages/shared/tsconfig.json'), 'utf8')).not.toMatch(/"DOM"/);
  });

  it('the RAG metric engine (eval/rag) takes nothing from the runner but types: the runner lends it what it needs', () => {
    expect(offenders('packages/core/src/eval/rag', (i) => /(^|\/)runner\//.test(i.spec) && !i.typeOnly)).toEqual([]);
  });

  it('the RAG metric engine takes only types from the AI task service: the engine lends it prepare/run (no 60-file import cycle)', () => {
    expect(offenders('packages/core/src/eval/rag', (i) => /(^|\/)ai\/tasks\//.test(i.spec) && !i.typeOnly)).toEqual([]);
  });

  it('the CLI is core plus commands', () => {
    expect(offenders('packages/cli/src', (i) => /^(electron|react|react-dom)(\/|$)/.test(i.spec) || i.spec.includes('apps/desktop'))).toEqual([]);
  });

  it('the desktop backend never reaches into the renderer', () => {
    expect(offenders('apps/desktop/backend', (i) => /^(react|react-dom)(\/|$)/.test(i.spec) || /(^|\/)src\//.test(i.spec))).toEqual([]);
  });

  it('the renderer talks to the backend through RPC only (it must run in a browser, served by a cloud host)', () => {
    expect(
      offenders(
        'apps/desktop/src',
        (i) =>
          /^node:/.test(i.spec) ||
          /^(electron|fs|path|child_process|os|crypto|net|http|https|stream)(\/|$)/.test(i.spec) ||
          /(^|\/)backend(\/|$)/.test(i.spec) ||
          /(^|\/)electron(\/|$)/.test(i.spec) ||
          (i.spec === '@testpion/core' && !i.typeOnly), // @testpion/shared is fine: it is built for the browser
      ),
    ).toEqual([]);
  });

  it('a handler saves a file for the user through Backend.saveOrDownload (or saveText): a cancelled dialog must never fall back to a download', () => {
    const asks: string[] = [];
    for (const f of files('apps/desktop/backend/handlers')) if (/\bsaveDialog\b/.test(readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')) && !/handlers\/app\.ts$/.test(rel(f))) asks.push(rel(f));
    expect(asks).toEqual([]);
  });

  it('MCP tools live in mcp-server/tools (one home, composed by tools/index.ts); the server file holds none of its own', () => {
    const root = join(__dirname, '..', '..', 'packages/core/src/mcp-server');
    expect(readdirSync(root).filter((f) => /-tools\.ts$/.test(f))).toEqual([]);
    expect(readFileSync(join(root, 'testpion-mcp.ts'), 'utf8')).not.toMatch(/^ {6}name: '/m);
  });

  it('the big files do not grow: new tools, handlers and commands get their own module', () => {
    // the ceiling is a little above each file's size when this test was written; shrinking it is always welcome
    const ceilings: Record<string, number> = {
      'packages/core/src/mcp-server/testpion-mcp.ts': 250,
      'apps/desktop/backend/backend.ts': 950,
      'packages/cli/src/commands/data.ts': 1300,
      'packages/core/src/storage/workspace.ts': 900,
      'packages/core/src/model/types.ts': 900,
      // split in B-41 (hooks and subcomponents next to them); they were 1171, 1136 and 976 lines
      'apps/desktop/src/components/FlowDesigner.tsx': 800,
      'apps/desktop/src/components/FlowDiagram.tsx': 850,
      'packages/core/src/ai/spec-tests.ts': 600,
    };
    const over: string[] = [];
    for (const [f, max] of Object.entries(ceilings)) {
      const lines = readFileSync(join(root, f), 'utf8').split('\n').length;
      if (lines > max) over.push(`${f}: ${lines} lines (at most ${max}; put the new code in its own module)`);
    }
    expect(over).toEqual([]);
    // and nothing else gets that big either
    const large: string[] = [];
    for (const dir of ['packages/core/src', 'packages/cli/src', 'apps/desktop/backend', 'apps/desktop/src'])
      for (const f of files(dir)) {
        const r = rel(f);
        if (r in ceilings || /\.generated\.ts$|scripts\/prelude\.ts$/.test(r)) continue;
        const lines = readFileSync(f, 'utf8').split('\n').length;
        if (lines > 1200 && statSync(f).isFile()) large.push(`${r}: ${lines} lines`);
      }
    expect(large).toEqual([]);
  });
});

describe('the app speaks TestPion', () => {
  it('script snippets insert tp.*, never pm.* or postman.* (both still run)', () => {
    const text = readFileSync(join(root, 'apps/desktop/src/lib/snippets.ts'), 'utf8');
    const start = text.indexOf('export const SNIPPETS');
    const end = text.indexOf('];', start);
    const code = [...text.slice(start, end).matchAll(/code: `([^`]*)`/g)].map((m) => m[1]!);
    expect(code.length).toBeGreaterThan(10);
    expect(code.filter((c) => /\b(pm|postman)\./.test(c))).toEqual([]);
  });
});

describe('one mechanism per concern (B-41)', () => {
  const core = files('packages/core/src');
  const hosts = [...core, ...files('packages/shared/src'), ...files('packages/cli/src'), ...files('apps/desktop/backend')];
  const src = (f: string) => readFileSync(f, 'utf8');

  it('zip archives are parsed by one reader: the hardened one (transfer/zip.ts); the import reader is a policy over it', () => {
    // anything that inflates a zip entry (raw deflate) is a reader; only the hardened one may, and the import one is a policy over it
    const inflaters = hosts.filter((f) => /\binflateRaw(Sync)?\b/.test(src(f))).map(rel);
    expect(inflaters.sort()).toEqual(['packages/core/src/transfer/zip.ts']);
    expect(src(join(root, 'packages/core/src/import/zip.ts'))).toMatch(/readZip as readHardenedZip/);
    // nothing else reads the end-of-central-directory (0x06054b50) or central-directory (0x02014b50) signature
    const parsers = hosts
      .filter((f) => /0x06054b50|0x02014b50/.test(src(f)))
      .map(rel)
      .filter((f) => f !== 'packages/core/src/transfer/zip.ts' && f !== 'packages/shared/src/output/formats.ts'); // formats.ts only WRITES (stored, streaming, browser-safe)
    expect(parsers).toEqual([]);
  });

  it('zip archives are written by two writers only: the bundle one (deflates, core) and the streaming stored one (shared, browser-safe)', () => {
    const writers = hosts.filter((f) => /writeUInt32LE\(0x04034b50|setUint32\(0, 0x04034b50/.test(src(f))).map(rel);
    expect(writers.sort()).toEqual(['packages/core/src/transfer/zip.ts', 'packages/shared/src/output/formats.ts']);
    expect(src(join(root, 'packages/shared/src/output/formats.ts'))).not.toMatch(/export function zipFiles/);
  });

  it('small helpers have one home: isRecord (shared), sha1Hex / sha256Hex (util/hash.ts); importAny is not an engine export', () => {
    const copies: string[] = [];
    for (const f of core) {
      const r = rel(f);
      if (r.startsWith('packages/core/src/eval/rag/') || r === 'packages/core/src/util/hash.ts') continue; // (the RAG engine is owned apart; its copies are on the backlog)
      const text = src(f);
      if (/^const isRec\w* = \(v: unknown\)[^\n]*typeof v === 'object'/m.test(text)) copies.push(`${r}: its own isRecord`);
      if (/createHash\('sha(1|256)'\)\.update\([^()]*\)\.digest\('hex'\)/.test(text)) copies.push(`${r}: its own sha1Hex / sha256Hex`);
      if (/export function importAny\b/.test(text)) copies.push(`${r}: importAny (the CLI reads imports through importDocument)`);
    }
    expect(copies).toEqual([]);
  });

  it('no two diff modules share a name, and the flow step differs share one matcher (util/step-match.ts)', () => {
    const byName = new Map<string, string[]>();
    for (const f of [...core, ...files('packages/cli/src'), ...files('apps/desktop/backend'), ...files('apps/desktop/src')]) {
      const name = f.split(sep).pop()!;
      if (/-diff\.tsx?$/.test(name)) byName.set(name, [...(byName.get(name) ?? []), rel(f)]);
    }
    expect([...byName.values()].filter((l) => l.length > 1)).toEqual([]);
    for (const f of ['packages/core/src/git/flow-diff.ts', 'packages/core/src/ai/flow-step-review.ts']) expect(src(join(root, f)), f).toMatch(/util\/step-match\.js/);
  });
});
