import type { Collection, CollectionNode } from '../types';
import { collectNodeIds, ensureUniqueIds } from '@testpion/shared';
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


/** Every node id of these collections except one (the collection a node is leaving). */
export function nodeIdsExcept(collections: readonly Pick<Collection, 'id' | 'items'>[], exceptId: string): Set<string> {
  const out = new Set<string>();
  for (const c of collections) if (c.id !== exceptId) collectNodeIds(c.items, []).forEach((id) => out.add(id));
  return out;
}

/**
 * A request or folder moved or copied into another collection, with fresh ids for those already taken there or in any
 * other collection (`taken`), so no two rows of the tree share an id (B-01). Free ids are kept, so tabs and links follow.
 */
export function moveIntoCollection<N extends CollectionNode>(node: N, taken: Iterable<string>): { node: N; renamed: Map<string, string> } {
  const r = ensureUniqueIds({ items: [node] }, taken, (prefix) => uid(prefix));
  return { node: r.collection.items[0] as N, renamed: r.renamed };
}

/** Where a node was, to put it back after a delete: its folder ('' : the top level) and the node that came after it. */
export interface NodePlace {
  node: CollectionNode;
  folderId: string;
  /** The sibling it stood before (none: it was the last of its folder). */
  beforeId?: string;
}

/** The places of these nodes before they are removed (in tree order). */
export function placesOf(nodes: CollectionNode[], ids: ReadonlySet<string>, folderId = ''): NodePlace[] {
  const out: NodePlace[] = [];
  nodes.forEach((n, i) => {
    if (ids.has(n.id)) {
      // the next sibling that stays (a removed one cannot be put back before)
      const after = nodes.slice(i + 1).find((x) => !ids.has(x.id));
      out.push({ node: n, folderId, ...(after ? { beforeId: after.id } : {}) });
    } else if (n.kind === 'folder') out.push(...placesOf(n.items, ids, n.id));
  });
  return out;
}

/**
 * Removed nodes put back into the collection as it is now (Undo of a delete): each before the sibling it stood before,
 * else at the end of its folder, else (the folder is gone too) at the top level. What changed meanwhile stays.
 */
export function putBackNodes(nodes: CollectionNode[], places: readonly NodePlace[]): CollectionNode[] {
  let out = nodes;
  // in tree order: a run of removed siblings, each before the same next sibling, keeps its order
  for (const p of places) {
    if (findNode(out, p.node.id)) continue; // back already (another window, an agent)
    if (p.beforeId && findNode(out, p.beforeId)) out = insertBefore(out, p.beforeId, p.node);
    else if (p.folderId && findNode(out, p.folderId)?.kind === 'folder') out = addToFolder(out, p.folderId, p.node);
    else out = [...out, p.node];
  }
  return out;
}
