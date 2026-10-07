import type { CollectionNode } from '../types';
import { uid } from './format';

/** A collection's tree of folders and requests, changed without mutating it (every change makes new arrays). */

export function mapNodes(nodes: CollectionNode[], fn: (n: CollectionNode) => CollectionNode | null): CollectionNode[] {
  const out: CollectionNode[] = [];
  for (const n of nodes) {
    const r = fn(n);
    if (!r) continue;
    out.push(r.kind === 'folder' ? { ...r, items: mapNodes(r.items, fn) } : r);
  }
  return out;
}

export function findNode(nodes: CollectionNode[], id: string): CollectionNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === 'folder') {
      const f = findNode(n.items, id);
      if (f) return f;
    }
  }
  return undefined;
}

export function addToFolder(nodes: CollectionNode[], folderId: string | undefined, node: CollectionNode): CollectionNode[] {
  if (!folderId) return [...nodes, node];
  return mapNodes(nodes, (n) => (n.kind === 'folder' && n.id === folderId ? { ...n, items: [...n.items, node] } : n));
}

/** Insert a node right before the node with this id, wherever it is in the tree. */
export function insertBefore(nodes: CollectionNode[], beforeId: string, node: CollectionNode): CollectionNode[] {
  return nodes.flatMap((n) => (n.id === beforeId ? [node, n] : n.kind === 'folder' ? [{ ...n, items: insertBefore(n.items, beforeId, node) }] : [n]));
}

/** Ids of the folders from the top down to a node (empty at the top level; undefined when it isn't there). */
export function folderIdsTo(nodes: CollectionNode[], id: string): string[] | undefined {
  for (const n of nodes) {
    if (n.id === id) return [];
    if (n.kind === 'folder') {
      const inner = folderIdsTo(n.items, id);
      if (inner) return [n.id, ...inner];
    }
  }
  return undefined;
}

/** A deep copy of a request or folder with new ids throughout (a copied folder's requests are new requests). */
export function withNewIds(n: CollectionNode): CollectionNode {
  const copy = structuredClone(n);
  const renumber = (x: CollectionNode): CollectionNode => (x.kind === 'folder' ? { ...x, id: uid('fld-'), items: x.items.map(renumber) } : { ...x, id: uid('req-') });
  return renumber(copy);
}

/** Insert a copy right after the node with this id, wherever it is in the tree. */
export function duplicateNode(nodes: CollectionNode[], id: string, copy: (n: CollectionNode) => CollectionNode): CollectionNode[] {
  return nodes.flatMap((n) => (n.id === id ? [n, copy(n)] : n.kind === 'folder' ? [{ ...n, items: duplicateNode(n.items, id, copy) }] : [n]));
}

