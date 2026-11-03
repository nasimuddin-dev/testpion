import type { Collection, CollectionFolder, CollectionNode, SavedHttpRequest } from '../types';
import type { NodeMenuCtx } from './node-menu-actions';
import { matchIndex } from './collection-filter';
import { treeKey } from './tree-state';
import { interleave, type CollectionCallLibrary, type KindId } from '@testpion/shared';

/**
 * The rows of the Collections tree (CollectionTree), as a pure function of the collections and what is open: the
 * open part of every collection, flattened, so only the rows on screen are drawn.
 *
 * Everything that names a row is scoped by its collection (B-01): two collections may hold nodes with the same id
 * (an older import, a copied file), and a row key, a DOM id (`data-node-id`) or an open/closed key made of the node
 * id alone would make React merge two rows into one and draw it at a stale place. One scheme for all of them:
 * `scopedNodeId(collectionId, nodeId)` = `<collection id>:<node id>`.
 */

/** Saved items of a collection that aren't collection requests (gRPC calls, WebSocket connections). */
export interface ExtraGroup {
  cat: CollectionCallLibrary;
  /** The item kind of its items (grpc-call, ws-connection): `collectionCallKind(cat)`. */
  kind: KindId;
  /** `folderId` / `after`: its place among the collection's requests (core storage/collection-calls.ts); `folder`: the folder text of an older version. */
  items: Array<{ id: string; name: string; folder?: string; folderId?: string; after?: string; badge?: string }>;
  onOpen(id: string): void;
  /** What its menu can do (lib/node-menu.ts builds the menu from it, only while open). */
  menu?(id: string): NodeMenuCtx;
  /** Rename an item in place (F2, or Rename in its menu). */
  rename?(id: string): { editing: boolean; start(): void; done(name?: string): void };
}

/** One row of the tree as drawn. `key` is unique in the tree (scoped by collection); `id` is the row's `data-node-id`. */
export type TreeRow =
  | { t: 'col'; key: string; c: Collection; open: boolean }
  | { t: 'folder'; key: string; c: Collection; n: CollectionFolder; depth: number; open: boolean; /** gRPC calls and connections inside (any kind in any folder). */ calls?: number }
  | { t: 'req'; key: string; c: Collection; n: Exclude<CollectionNode, CollectionFolder>; depth: number }
  | { t: 'example'; key: string; c: Collection; n: SavedHttpRequest; ex: { id: string; name: string; status: number }; depth: number }
  | { t: 'xitem'; key: string; g: ExtraGroup; i: ExtraGroup['items'][number]; depth: number; from?: string }
  | { t: 'empty'; key: string; c: Collection };

/** A node of a collection, named so that no other collection's node has the same name: `<collection id>:<node id>`. */
export const scopedNodeId = (collectionId: string, nodeId: string) => treeKey(collectionId, nodeId);

/** The open/closed key of a folder, and of a request's examples (scoped; the keys of older versions are still read). */
export const folderOpenKey = (collectionId: string, folderId: string) => scopedNodeId(collectionId, folderId);
export const examplesOpenKey = (collectionId: string, requestId: string) => treeKey(scopedNodeId(collectionId, requestId), 'examples');
/** Whether a scoped key is open: the scoped key wins; the unscoped key an older version saved is the fallback. */
export const isOpenKey = (open: Record<string, boolean>, scoped: string, legacy: string): boolean | undefined => open[scoped] ?? open[legacy];

/** The React key of a row: its kind and its scoped key (unique in the tree). */
export const treeRowKey = (r: TreeRow) => `${r.t}:${r.key}`;

export interface TreeRowsInput {
  collections: Collection[];
  open: Record<string, boolean>;
  filter?: string;
  favoritesOnly?: boolean;
  /** The explorer's tree: collections start folded, and their gRPC calls and connections (`extraGroups`) sit in their folders. */
  explorer?: boolean;
  extraGroups?(c: Collection): ExtraGroup[];
}

/** Every row that shows (the open collections and folders), in order. */
export function buildTreeRows({ collections, open, filter, favoritesOnly = false, explorer = false, extraGroups }: TreeRowsInput): TreeRow[] {
  const f = filter?.trim().toLowerCase() || undefined;
  const out: TreeRow[] = [];
  // whether each node of the collection being added matches (one bottom-up pass per collection and query, cached)
  let matches: (n: CollectionNode) => boolean = () => true;
  const extraShown = (i: ExtraGroup['items'][number]) => !f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f);
  /**
   * A collection's contents by its folders, every kind of request in them: the collection's requests in their order and
   * its gRPC calls and connections at their place (`folderId`, `after`; a folder that is gone: the top level).
   */
  const addContents = (c: Collection, extras: ExtraGroup[]) => {
    const parent = new Map<string, string | undefined>();
    const walk = (nodes: CollectionNode[], up?: string) => {
      for (const n of nodes) if (n.kind === 'folder') (parent.set(n.id, up), walk(n.items, n.id));
    };
    walk(c.items);
    type Call = { id: string; name: string; after?: string; g: ExtraGroup; i: ExtraGroup['items'][number] };
    const byFolder = new Map<string, Call[]>();
    // the folders that hold a call the filter shows (and the folders around them)
    const withCalls = new Set<string>();
    for (const g of extras)
      for (const i of g.items) {
        const at = i.folderId && parent.has(i.folderId) ? i.folderId : '';
        byFolder.set(at, [...(byFolder.get(at) ?? []), { id: i.id, name: i.name, after: i.after, g, i }]);
        if (f && extraShown(i)) for (let up: string | undefined = at || undefined; up; up = parent.get(up)) withCalls.add(up);
      }
    const countCalls = (id: string): number => (byFolder.get(id)?.length ?? 0) + [...parent].filter(([, up]) => up === id).reduce((n, [child]) => n + countCalls(child), 0);
    const add = (nodes: CollectionNode[], depth: number, folderId: string) => {
      for (const x of interleave(nodes, byFolder.get(folderId) ?? [])) {
        if ('call' in x) {
          if (extraShown(x.call.i)) out.push({ t: 'xitem', key: treeKey(c.id, x.call.g.cat, x.call.id), g: x.call.g, i: x.call.i, depth, from: c.id });
          continue;
        }
        const n = x.node;
        if (!matches(n) && !(n.kind === 'folder' && withCalls.has(n.id))) continue;
        const key = scopedNodeId(c.id, n.id);
        if (n.kind === 'folder') {
          const isOpen = isOpenKey(open, folderOpenKey(c.id, n.id), n.id) ?? !!f;
          const calls = countCalls(n.id);
          out.push({ t: 'folder', key, c, n, depth, open: isOpen, ...(calls ? { calls } : {}) });
          if (isOpen) add(n.items, depth + 1, n.id);
          continue;
        }
        out.push({ t: 'req', key, c, n, depth });
        if (n.kind === 'http' && n.examples?.length && isOpenKey(open, examplesOpenKey(c.id, n.id), treeKey(n.id, 'examples')))
          for (const ex of n.examples) out.push({ t: 'example', key: treeKey(key, 'ex', ex.id), c, n, ex, depth });
      }
    };
    add(c.items, 1, '');
  };
  for (const c of collections) {
    matches = f || favoritesOnly ? matchIndex(c.items, f, favoritesOnly) : () => true;
    const extras = explorer ? (extraGroups?.(c) ?? []).filter((g) => g.items.length) : [];
    // in the explorer, collections start folded: the workspace lists them; a collection opens when the user opens it (or
    // something is revealed in it), not because its request is open
    const isOpen = explorer && f ? true : (open[c.id] ?? !explorer);
    if (explorer && f && !c.items.some(matches) && !extras.some((g) => g.items.some(extraShown))) continue;
    out.push({ t: 'col', key: c.id, c, open: isOpen });
    if (!isOpen) continue;
    addContents(c, extras);
    if (!f && !favoritesOnly && !c.problem && !c.items.length && !extras.length) out.push({ t: 'empty', key: treeKey(c.id, 'empty'), c });
  }
  return out;
}

/** The row of a collection, folder, request or saved item (`target` is a collection id, a node id or an item id; `collectionId` narrows it). */
export function findTreeRow(rows: readonly TreeRow[], target: string, collectionId?: string): number {
  return rows.findIndex((r) =>
    r.t === 'col' ? r.c.id === target : r.t === 'req' || r.t === 'folder' ? r.n.id === target && (!collectionId || r.c.id === collectionId) : r.t === 'xitem' ? r.i.id === target : false,
  );
}
