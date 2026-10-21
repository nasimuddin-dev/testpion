import { collectNodeIds, ensureUniqueIds as ensureUniqueIdsWith, type IdNode, type NewNodeId } from '@testpion/shared';
import { shortId } from '../util/ids.js';

/**
 * Node ids (folders and requests) are unique across a workspace's collections (see @testpion/shared node-ids). The
 * engine's entry points: every path that brings nodes in from outside calls `ensureUniqueIds` with the ids the
 * workspace already holds (`workspaceNodeIds`), e.g. an import, a bundle import, an examples update.
 */
export { collectNodeIds, duplicateNodeIds, type IdNode, type NewNodeId } from '@testpion/shared';

/** A new node id (`fld-…` or `req-…`). */
const newNodeId: NewNodeId = (prefix) => shortId(prefix);

/**
 * The collection with fresh ids for nodes whose id is already taken (by another collection, or earlier in this one).
 * Nodes with a free id keep it. Pure; `renamed` maps old ids to new ones.
 */
export function ensureUniqueIds<C extends { items: IdNode[] }>(collection: C, takenIds: Iterable<string>, newId: NewNodeId = newNodeId): { collection: C; renamed: Map<string, string> } {
  return ensureUniqueIdsWith(collection, takenIds, newId);
}

/** Every node id held by these collections, except the collection `exceptId` (the one being saved or replaced). */
export function workspaceNodeIds(collections: ReadonlyArray<{ id: string; items?: readonly IdNode[] }>, exceptId?: string): Set<string> {
  const out = new Set<string>();
  for (const c of collections) if (c.id !== exceptId) for (const id of collectNodeIds(c.items)) out.add(id);
  return out;
}
