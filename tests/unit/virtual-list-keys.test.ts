import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTreeRows, examplesOpenKey, findTreeRow, folderOpenKey, scopedNodeId, treeRowKey, type TreeRow } from '../../apps/desktop/src/lib/tree-rows';
import { listWindow, windowKeys } from '../../apps/desktop/src/lib/list-window';
import { dedupeKeys, forgetReportedKeys, reportDuplicateKeys, uniqueKeys } from '../../apps/desktop/src/lib/unique-keys';
import type { Collection, CollectionNode } from '../../apps/desktop/src/types';

// B-01: two collections that share request ids drew one request at several places and dropped others, because tree
// rows were keyed by the node id alone. Rows are keyed (and named in the DOM) by collection + node; every list makes
// its keys unique (a repeat is reported in development and drawn as a row of its own); the virtual list keeps the
// dragged row mounted. The DOM side (each [data-node-id] unique and inside the list after expand, collapse, scroll,
// select and drag) is the e2e plan tree-ghost.

const req = (id: string, name = id): CollectionNode => ({ kind: 'http', id, name, request: { method: 'GET', url: `https://x/${id}`, headers: [], params: [] } }) as unknown as CollectionNode;
const folder = (id: string, items: CollectionNode[]): CollectionNode => ({ kind: 'folder', id, name: id, items }) as CollectionNode;
const col = (id: string, items: CollectionNode[]): Collection => ({ schemaVersion: '1.0', id, name: id, version: 1, variables: [], items, updatedAt: '' }) as Collection;

/** Two collections with the same node ids (an older import, a copied file). */
const shared = () => [col('a', [folder('f', [req('r1'), req('r2')]), req('r3')]), col('b', [folder('f', [req('r1'), req('r2')]), req('r3')])];
const allOpen = (cols: Collection[]) => Object.fromEntries(cols.flatMap((c) => [[c.id, true], ...c.items.filter((n) => n.kind === 'folder').map((n) => [folderOpenKey(c.id, n.id), true])]));
const keys = (rows: TreeRow[]) => rows.map(treeRowKey);
const nodeRows = (rows: TreeRow[]) => rows.filter((r): r is Extract<TreeRow, { t: 'req' | 'folder' }> => r.t === 'req' || r.t === 'folder');

describe('tree rows of collections that share node ids', () => {
  it('draws every row of both collections once, with unique keys and DOM ids', () => {
    const cols = shared();
    for (const categorize of [false, true]) {
      const rows = buildTreeRows({ collections: cols, open: allOpen(cols), categorize });
      expect(new Set(keys(rows)).size).toBe(rows.length);
      const ids = nodeRows(rows).map((r) => r.key);
      expect(new Set(ids).size).toBe(ids.length);
      // each request once per collection
      for (const c of ['a', 'b']) for (const id of ['f', 'r1', 'r2', 'r3']) expect(ids.filter((x) => x === scopedNodeId(c, id))).toHaveLength(1);
    }
  });

  it('opens and closes a folder in one collection only (scoped open keys), and still reads the keys older versions saved', () => {
    const cols = shared();
    const onlyA = { a: true, b: true, [folderOpenKey('a', 'f')]: true, [folderOpenKey('b', 'f')]: false };
    const rows = buildTreeRows({ collections: cols, open: onlyA });
    expect(nodeRows(rows).map((r) => r.key)).toEqual(['a:f', 'a:r1', 'a:r2', 'a:r3', 'b:f', 'b:r3']);
    // an older version saved the folder's state under its id alone: both collections follow it until changed
    const legacy = buildTreeRows({ collections: cols, open: { a: true, b: true, f: true } });
    expect(nodeRows(legacy)).toHaveLength(8);
    const overridden = buildTreeRows({ collections: cols, open: { a: true, b: true, f: true, [folderOpenKey('b', 'f')]: false } });
    expect(nodeRows(overridden)).toHaveLength(6);
  });

  it('keys examples by collection too', () => {
    const r = req('e1') as CollectionNode & { examples?: unknown[] };
    r.examples = [{ id: 'x', name: 'ok', status: 200 }];
    const cols = [col('a', [r]), col('b', [structuredClone(r)])];
    const rows = buildTreeRows({ collections: cols, open: { a: true, b: true, [examplesOpenKey('a', 'e1')]: true, [examplesOpenKey('b', 'e1')]: true } });
    expect(rows.filter((x) => x.t === 'example')).toHaveLength(2);
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });

  it('finds the row to reveal in the right collection', () => {
    const cols = shared();
    const rows = buildTreeRows({ collections: cols, open: allOpen(cols) });
    expect(rows[findTreeRow(rows, 'r2', 'b')]!.key).toBe('b:r2');
    expect(rows[findTreeRow(rows, 'r2')]!.key).toBe('a:r2');
    expect(rows[findTreeRow(rows, 'b')]!.t).toBe('col');
  });

  it('keeps keys unique through expand, collapse and a filter, at 9,000 rows within budget', () => {
    const big = (id: string) =>
      col(
        id,
        Array.from({ length: 30 }, (_, f) =>
          folder(
            `f${f}`,
            Array.from({ length: 150 }, (_, i) => req(`r${f}-${i}`)),
          ),
        ),
      );
    const cols = [big('a'), big('b')];
    // the best of three: a real slowdown is slow every time, a one-off stall of a busy machine is not
    let rows = buildTreeRows({ collections: cols, open: allOpen(cols), categorize: true });
    let built = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      rows = buildTreeRows({ collections: cols, open: allOpen(cols), categorize: true });
      built = Math.min(built, performance.now() - t);
    }
    expect(rows.length).toBeGreaterThan(9000);
    expect(new Set(keys(rows)).size).toBe(rows.length);
    expect(built).toBeLessThan(250);
    const collapsed = buildTreeRows({ collections: cols, open: { ...allOpen(cols), [folderOpenKey('a', 'f3')]: false, b: false }, categorize: true });
    expect(new Set(keys(collapsed)).size).toBe(collapsed.length);
    const filtered = buildTreeRows({ collections: cols, open: {}, filter: 'r1-1', categorize: true });
    expect(new Set(keys(filtered)).size).toBe(filtered.length);
    expect(nodeRows(filtered).some((r) => r.key === 'b:r1-1')).toBe(true);
  });
});

describe('list keys', () => {
  beforeEach(() => forgetReportedKeys());

  it('dedupes repeats with a suffix that hits no other key, in list order', () => {
    expect(dedupeKeys(['a', 'b', 'a', 'a~2', 'a']).keys).toEqual(['a', 'b', 'a~3', 'a~2', 'a~4']);
    expect(dedupeKeys([1, 2, 3]).duplicates).toEqual([]);
    expect(dedupeKeys(['x', 'y', 'x']).duplicates).toEqual([{ key: 'x', first: 0, second: 2 }]);
  });

  it('reports a repeated key once per list, with the key and both items', () => {
    const log = vi.fn();
    const items = [{ id: 'a' }, { id: 'a' }];
    const d = dedupeKeys(items.map((i) => i.id)).duplicates;
    expect(reportDuplicateKeys('Tree', d, (i) => items[i], log)).toBe(1);
    expect(reportDuplicateKeys('Tree', d, (i) => items[i], log)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('"a"');
    expect(log.mock.calls[0]!.slice(1)).toEqual([items[0], items[1]]);
  });

  it('uniqueKeys reports in development builds (console.error) and always suffixes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(uniqueKeys([{ id: 'q' }, { id: 'q' }], (i) => i.id, 'List', true)).toEqual(['q', 'q~2']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(uniqueKeys([{ id: 'z' }, { id: 'z' }], (i) => i.id, 'Quiet', false)).toEqual(['z', 'z~2']);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('virtual list window', () => {
  it('draws the rows on screen plus overscan, clamped', () => {
    expect(listWindow({ count: 1000, rowHeight: 20, scrollTop: 2000, height: 200, overscan: 5 })).toMatchObject({ start: 95, end: 115 });
    expect(listWindow({ count: 10, rowHeight: 20, scrollTop: 5000, height: 200, overscan: 5 }).indexes).toEqual([]);
    expect(listWindow({ count: 3, rowHeight: 0, scrollTop: 0, height: 100, overscan: 0 }).indexes).toEqual([0, 1, 2]);
  });

  it('keeps the dragged row mounted while it is off screen, once', () => {
    const w = listWindow({ count: 1000, rowHeight: 20, scrollTop: 2000, height: 200, overscan: 5, keepIndex: 3 });
    expect(w.indexes).toContain(3);
    expect(w.indexes.filter((i) => i === 3)).toHaveLength(1);
    expect(listWindow({ count: 1000, rowHeight: 20, scrollTop: 2000, height: 200, overscan: 5, keepIndex: 100 }).indexes.filter((i) => i === 100)).toHaveLength(1);
    expect(listWindow({ count: 10, rowHeight: 20, scrollTop: 0, height: 100, overscan: 0, keepIndex: 99 }).indexes).not.toContain(99);
  });

  it('gives the drawn rows unique keys, with the repeats named by list position', () => {
    const items = ['a', 'b', 'a', 'c'];
    const r = windowKeys(items, [1, 2, 3, 0], (x) => x);
    expect(r.keys).toEqual(['b', 'a', 'c', 'a~2']);
    expect(r.duplicates).toEqual([{ key: 'a', first: 2, second: 0 }]);
    expect(windowKeys(items, [0, 1]).keys).toEqual([0, 1]);
  });

  it('scrolling a tree of two collections sharing ids never draws a key twice', () => {
    const cols = shared();
    const rows = buildTreeRows({ collections: cols, open: allOpen(cols), categorize: true });
    for (let top = 0; top < rows.length * 20; top += 7) {
      const w = listWindow({ count: rows.length, rowHeight: 20, scrollTop: top, height: 60, overscan: 1, keepIndex: 2 });
      const k = windowKeys(rows, w.indexes, treeRowKey);
      expect(k.duplicates).toEqual([]);
      expect(new Set(k.keys).size).toBe(w.indexes.length);
    }
  });

  it('the list contains its paint and every sidebar row carries a scoped data-node-id', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'apps', 'desktop', 'src', 'components', f), 'utf8');
    expect(src('VirtualList.tsx')).toMatch(/contain: CONTAIN/);
    expect(src('ui.tsx')).toMatch(/export \{ VirtualList \} from '\.\/VirtualList'/);
    // the rows (CollectionTreeRows.tsx) are drawn by the tree (CollectionTree.tsx): every row names its node
    const tree = src('CollectionTree.tsx') + src('CollectionTreeRows.tsx');
    // no row is named by its node id alone any more
    expect(tree).not.toMatch(/data-node-id=\{n\.id\}|data-rename-id=\{n\.id\}|menuFor === n\.id|keyOf=\{rowKey\}/);
    expect((tree.match(/nodeId=|data-node-id=/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});
