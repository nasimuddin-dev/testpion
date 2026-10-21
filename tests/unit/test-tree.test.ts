import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { WorkspaceStore, type TestFileNode } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * `testTree` lists tests/ for the explorer: folders first, then by name; dot files left out; only test-like extensions.
 * The reference below is the implementation before it built each path by joining the parent's (and sorted with a
 * Collator): the same tree, node for node, on names that exercise the order (case, accents, digits, dots).
 */
const reference = (ws: WorkspaceStore, dir = ws.path('tests')): TestFileNode[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => {
      const p = join(dir, e.name);
      const rel = relative(ws.path('tests'), p).split(sep).join('/');
      return e.isDirectory() ? { name: e.name, path: rel, kind: 'dir' as const, children: reference(ws, p) } : { name: e.name, path: rel, kind: 'file' as const };
    })
    .filter((n) => n.kind === 'dir' || /\.(ya?ml|json|jsonl|csv|md)$/i.test(n.name));
};

const t = tempDir('tp-tree-');
afterAll(() => t.cleanup());

describe('testTree', () => {
  it('gives what the path.relative / localeCompare implementation gave', () => {
    const ws = WorkspaceStore.create(t.dir, 'tree');
    const names = ['b.yaml', 'a.yaml', 'B.yml', 'é.json', 'e.json', 'z10.md', 'z9.md', '.hidden.yaml', 'notes.txt', 'data.csv', 'Data.CSV', 'x.jsonl', 'run.test.yaml'];
    for (const d of ['', 'rest', 'rest/deep/er', 'Zeta', 'alpha', '.git', 'empty']) {
      mkdirSync(join(ws.path('tests'), d), { recursive: true });
      for (const n of names) writeFileSync(join(ws.path('tests'), d, n), 'name: x\n');
    }
    const got = ws.testTree();
    expect(got).toEqual(reference(ws));
    expect(JSON.stringify(got)).toBe(JSON.stringify(reference(ws)));
    expect(ws.testTree(join(ws.path('tests'), 'rest'))).toEqual(reference(ws, join(ws.path('tests'), 'rest')));
    expect(got.some((n) => n.name === '.git')).toBe(false);
    ws.close();
  });

  it('lists 20,000 files in a folder without a path.relative per file', () => {
    const ws = WorkspaceStore.open(t.dir);
    for (let i = 0; i < 20000; i++) writeFileSync(join(ws.path('tests'), 'empty', `t${i}.yaml`), 'name: x\n');
    const ms = Math.min(...Array.from({ length: 3 }, () => { const s = performance.now(); ws.testTree(); return performance.now() - s; }));
    console.log(`testTree of 20,000 files: ${ms.toFixed(0)} ms`);
    expect(ws.testTree()).toEqual(reference(ws));
    expect(ms).toBeLessThan(1500);
    ws.close();
  });
});
