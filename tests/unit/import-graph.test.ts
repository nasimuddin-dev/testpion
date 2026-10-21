import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The import graph of the engine and the apps, kept by a test: modules that import each other (a cycle) load in an order that
 * decides behaviour and cannot be loaded lazily. One 60-file cycle (runner, AI tasks, RAG metrics, import, OpenAPI) was cut at a
 * single edge (eval/rag/judge.ts -> ai/tasks/run.ts); what is left are small cycles, and none may grow or appear.
 * Only value imports count (`import type` is erased).
 */
const root = resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(resolve(p));
    }
  };
  walk(join(root, dir));
  return out;
}

/** The strongly connected components (two or more files) of the value-import graph of a folder. */
function cycles(dir: string): string[][] {
  const files = sources(dir);
  const set = new Set(files);
  const graph = new Map<string, string[]>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const out = new Set<string>();
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[2] ?? m[3]!;
      if (m[1] || !spec.startsWith('.')) continue;
      const base = resolve(dirname(f), spec.replace(/\.js$/, ''));
      const hit = [base + '.ts', base + '.tsx', join(base, 'index.ts')].find((c) => set.has(c));
      if (hit) out.add(hit);
    }
    graph.set(f, [...out]);
  }
  let n = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const found: string[][] = [];
  const visit = (v: string) => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const c: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        c.push(w);
      } while (w !== v);
      if (c.length > 1) found.push(c.map((x) => relative(join(root, dir), x).split(sep).join('/')).sort());
    }
  };
  for (const f of files) if (!index.has(f)) visit(f);
  return found.sort((a, b) => b.length - a.length);
}

describe('import graph', () => {
  it('the engine (packages/core) has no import cycle bigger than 5 files, and no more of them than today', () => {
    const found = cycles('packages/core/src');
    expect(found.filter((c) => c.length > 5).map((c) => `${c.length} files: ${c.slice(0, 6).join(', ')}`)).toEqual([]);
    // the small ones left; lower this number whenever one is broken, never raise it
    expect(found.length).toBeLessThanOrEqual(6);
  });

  it('the CLI has no import cycle bigger than 5 files', () => {
    expect(cycles('packages/cli/src').filter((c) => c.length > 5).map((c) => c.join(', '))).toEqual([]);
  });

  it('the shared package has no import cycle', () => {
    expect(cycles('packages/shared/src').map((c) => c.join(', '))).toEqual([]);
  });
});
