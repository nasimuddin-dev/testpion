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
    expect(offenders('packages/shared/src', (i) => /^node:/.test(i.spec) || /^(electron|react|react-dom|fs|path|crypto|os|child_process|net|http|https|stream|buffer)(\/|$)/.test(i.spec) || i.spec.includes('@testpion/core'))).toEqual([]);
    expect(readFileSync(join(root, 'packages/shared/tsconfig.json'), 'utf8')).not.toMatch(/"DOM"/);
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

  it('the big files do not grow: new tools, handlers and commands get their own module', () => {
    // the ceiling is a little above each file's size when this test was written; shrinking it is always welcome
    const ceilings: Record<string, number> = {
      'packages/core/src/mcp-server/testpion-mcp.ts': 1500,
      'apps/desktop/backend/backend.ts': 1450,
      'packages/cli/src/commands/data.ts': 1300,
      'packages/core/src/storage/workspace.ts': 900,
      'packages/core/src/model/types.ts': 900,
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
