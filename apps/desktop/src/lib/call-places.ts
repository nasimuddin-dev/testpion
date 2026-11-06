import { AT_START, placeBefore, siblingBefore } from '@testpion/shared';
import type { Collection, CollectionNode } from '../types';
import { findNode, folderIdsTo } from './collection-nodes';

/**
 * Where a collection's gRPC calls and connections sit among its requests (any kind of request in any folder), for the
 * moves and deletes of the tree: the children of a folder, and which calls follow something else once an item is
 * dropped before a sibling or is gone. Pure: the tree (CollectionTree) and the lists' owner (useCollectionCalls) share it.
 */
export interface PlacedItem {
  id: string;
  name: string;
  folderId?: string;
  after?: string;
}

/** The folder of the collection a call sits in ('': its top level, also when its folder is gone). */
const folderOfCall = (c: Collection, i: PlacedItem): string => (i.folderId && findNode(c.items, i.folderId)?.kind === 'folder' ? i.folderId : '');

/** The children of a folder of a collection ('' or none: of its top level): its requests and folders, and the calls placed in it. `calls`: the collection's. */
export function folderChildren<I extends PlacedItem>(c: Collection, calls: readonly I[], folderId: string | undefined): { nodes: CollectionNode[]; calls: I[] } {
  const folder = folderId ? findNode(c.items, folderId) : undefined;
  const at = folder?.kind === 'folder' ? folder.id : '';
  return { nodes: folder?.kind === 'folder' ? folder.items : c.items, calls: calls.filter((i) => folderOfCall(c, i) === at) };
}

/** The folder that holds a request, a folder or a call ('': the top level; undefined: it is not in the collection). */
export function folderHolding(c: Collection, calls: readonly PlacedItem[], id: string): string | undefined {
  const call = calls.find((i) => i.id === id);
  if (call) return folderOfCall(c, call);
  const up = folderIdsTo(c.items, id);
  return up ? (up[up.length - 1] ?? '') : undefined;
}

/**
 * A request, a folder or a call is about to be deleted or moved away: the calls that followed it, and what each follows
 * now (what it followed; none: they are the first of the folder). Empty when nothing followed it.
 */
export function followersOf(c: Collection, calls: readonly PlacedItem[], id: string): Map<string, string> {
  const out = new Map<string, string>();
  const at = folderHolding(c, calls, id);
  if (at === undefined) return out;
  const here = folderChildren(c, calls, at);
  const before = siblingBefore(here.nodes, here.calls, id) ?? AT_START;
  for (const i of here.calls) if (i.after === id && i.id !== id) out.set(i.id, before);
  return out;
}

/**
 * Several requests about to be deleted or moved away together (the tree's picked requests): the calls that followed any
 * of them, and what each follows now: what the first of a run of them followed, past the others that go too.
 */
export function followersOfMany(c: Collection, calls: readonly PlacedItem[], ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const at = folderHolding(c, calls, id);
    if (at === undefined) continue;
    const here = folderChildren(c, calls, at);
    let before = siblingBefore(here.nodes, here.calls, id) ?? AT_START;
    for (let n = 0; ids.has(before) && n < 10_000; n++) before = siblingBefore(here.nodes, here.calls, before) ?? AT_START;
    for (const i of here.calls) if (i.after === id && !ids.has(i.id)) out.set(i.id, before);
  }
  return out;
}

/**
 * An item dropped just before a request, a folder or a call of a collection (`moved`: a call, or with `node` a request
 * or folder): the folder it lands in, the node a moved node is inserted before (none: the folder's end) and the calls
 * whose `after` changes (shared `placeBefore`). Undefined when the sibling is not in the collection.
 */
export function dropBefore(
  c: Collection,
  calls: readonly PlacedItem[],
  moved: { id: string; node?: boolean },
  beforeId: string,
): { folderId?: string; beforeNode?: string; after: Map<string, string> } | undefined {
  const at = folderHolding(c, calls, beforeId);
  if (at === undefined) return undefined;
  const here = folderChildren(c, calls, at);
  return { folderId: at || undefined, ...placeBefore(here.nodes, here.calls, moved, beforeId) };
}
