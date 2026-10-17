import { describe, expect, it } from 'vitest';
import { collectNodeIds, duplicateNodeIds, ensureUniqueIds, workspaceNodeIds, type IdNode } from '@testpion/core';

// Node ids are unique across a workspace's collections: anything brought in (import, copy, examples update) gets
// fresh ids for the ones already taken, and keeps the free ones (references to them keep working).
const req = (id: string): IdNode => ({ kind: 'http', id });
const folder = (id: string, items: IdNode[]): IdNode => ({ kind: 'folder', id, items });
const counter = () => {
  let n = 0;
  return (prefix: 'fld-' | 'req-') => `${prefix}${++n}`;
};

describe('ensureUniqueIds', () => {
  it('renames only the taken ids, folders and requests alike, and keeps the free ones', () => {
    const col = { id: 'b', name: 'B', items: [req('a1'), folder('f1', [req('a2'), req('free')]), req('own')] };
    const { collection, renamed } = ensureUniqueIds(col, ['a1', 'f1', 'a2'], counter());
    expect(collectNodeIds(collection.items)).toEqual(['req-1', 'fld-2', 'req-3', 'free', 'own']);
    expect([...renamed]).toEqual([
      ['a1', 'req-1'],
      ['f1', 'fld-2'],
      ['a2', 'req-3'],
    ]);
    // pure: the input is untouched; nothing else of a node changes
    expect(collectNodeIds(col.items)).toEqual(['a1', 'f1', 'a2', 'free', 'own']);
    expect(collection.name).toBe('B');
  });

  it('returns the same object when nothing collides', () => {
    const col = { items: [req('x'), folder('y', [req('z')])] };
    const r = ensureUniqueIds(col, ['other'], counter());
    expect(r.collection).toBe(col);
    expect(r.renamed.size).toBe(0);
  });

  it('fixes a duplicate inside one tree and a missing id, and never repeats a generated id', () => {
    const col = { items: [req('d'), folder('f', [req('d')]), { kind: 'http', id: '' } as IdNode] };
    // a generator that always says the same thing still yields unique ids
    const r = ensureUniqueIds(col, ['req-x'], () => 'req-x');
    const ids = collectNodeIds(r.collection.items);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('d');
    expect(ids).not.toContain('');
  });

  it('defaults to engine ids and handles a large tree quickly', () => {
    const items = Array.from({ length: 9000 }, (_, i) => req(`r${i}`));
    const taken = new Set(items.map((n) => n.id));
    // the best of three: a real slowdown is slow every time, a one-off stall of a busy machine is not
    let r = ensureUniqueIds({ items }, taken);
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      r = ensureUniqueIds({ items }, taken);
      ms = Math.min(ms, performance.now() - t);
    }
    expect(ms).toBeLessThan(500);
    const ids = collectNodeIds(r.collection.items);
    expect(ids.every((id) => id.startsWith('req-') && !taken.has(id))).toBe(true);
    expect(new Set(ids).size).toBe(9000);
  });
});

describe('workspace node ids', () => {
  it('collects every id except the collection being replaced, and finds duplicates across collections', () => {
    const cols = [
      { id: 'a', items: [req('1'), folder('f', [req('2')])] },
      { id: 'b', items: [req('2'), req('3')] },
    ];
    expect([...workspaceNodeIds(cols)].sort()).toEqual(['1', '2', '3', 'f']);
    expect([...workspaceNodeIds(cols, 'b')].sort()).toEqual(['1', '2', 'f']);
    expect(duplicateNodeIds(cols)).toEqual(['2']);
  });
});
