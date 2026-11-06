import { describe, expect, it } from 'vitest';
import { placesOf, putBackNodes } from '../../apps/desktop/src/lib/collection-nodes';
import type { CollectionNode } from '../../apps/desktop/src/types';

// Undo of a delete in the Collections tree puts the removed requests back where they were, into the collection as it is
// now: an edit made between the delete and the Undo stays.
const req = (id: string, name = id): CollectionNode => ({ kind: 'http', id, name, request: { method: 'GET', url: `https://x/${id}` } }) as unknown as CollectionNode;
const folder = (id: string, items: CollectionNode[]): CollectionNode => ({ kind: 'folder', id, name: id, items }) as CollectionNode;
const ids = (nodes: CollectionNode[]): unknown[] => nodes.map((n) => (n.kind === 'folder' ? { [n.id]: ids(n.items) } : n.id));
const remove = (nodes: CollectionNode[], gone: Set<string>): CollectionNode[] =>
  nodes.filter((n) => !gone.has(n.id)).map((n) => (n.kind === 'folder' ? { ...n, items: remove(n.items, gone) } : n));

describe('putting deleted requests back', () => {
  const tree = [req('a'), folder('f', [req('b'), req('c'), req('d')]), req('e')];

  it('a run of siblings, in its order, before what came after it', () => {
    const gone = new Set(['b', 'c']);
    const places = placesOf(tree, gone);
    expect(places.map((p) => [p.node.id, p.folderId, p.beforeId])).toEqual([
      ['b', 'f', 'd'],
      ['c', 'f', 'd'],
    ]);
    expect(ids(putBackNodes(remove(tree, gone), places))).toEqual(ids(tree));
  });

  it('keeps an edit made since; the last of a folder goes back at its end; a folder that is gone: the top level', () => {
    const gone = new Set(['d', 'e']);
    const places = placesOf(tree, gone);
    // meanwhile `a` was renamed and a request added to the folder
    const now = remove(tree, gone).map((n) => (n.id === 'a' ? req('a', 'renamed') : n.kind === 'folder' ? { ...n, items: [...n.items, req('new')] } : n));
    const back = putBackNodes(now, places);
    expect(ids(back)).toEqual(['a', { f: ['b', 'c', 'new', 'd'] }, 'e']);
    expect(back[0]!.name).toBe('renamed');
    // the folder deleted meanwhile: its request comes back at the top level
    expect(ids(putBackNodes([req('a'), req('e')], placesOf(tree, new Set(['c']))))).toEqual(['a', 'e', 'c']);
    // already back (another window): not twice
    expect(ids(putBackNodes(tree, placesOf(tree, new Set(['b']))))).toEqual(ids(tree));
  });
});
