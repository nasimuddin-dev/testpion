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

/** What a collection shows that is kept outside its file: the two call libraries, and the MCP servers placed in it (mcp-servers.json). */
export type PlacedKind = CollectionCallLibrary | 'mcp';

/** Saved items of a collection that aren't collection requests (gRPC calls, WebSocket connections, MCP servers). */
export interface ExtraGroup {
  cat: PlacedKind;
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
  | { t: 'xitem'; key: string; c: Collection; g: ExtraGroup; i: ExtraGroup['items'][number]; depth: number; from?: string }
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
  /** The explorer's tree: collections start folded. */
  explorer?: boolean;
  /** A collection's gRPC calls and connections: they sit in its folders, among its requests. */
  extraGroups?(c: Collection): ExtraGroup[];
}

/**
 * Whether a gRPC call or connection shows for a filter (`f`: trimmed, lower case). A call cannot be a favourite
 * (favourites are saved requests), so the favourites-only tree shows none, as it shows no request that is not one.
 */
export const callShown = (i: ExtraGroup['items'][number], f: string | undefined, favoritesOnly = false): boolean =>
  !favoritesOnly && (!f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f));

/** Every row that shows (the open collections and folders), in order. */
export function buildTreeRows({ collections, open, filter, favoritesOnly = false, explorer = false, extraGroups }: TreeRowsInput): TreeRow[] {
  const f = filter?.trim().toLowerCase() || undefined;
  const out: TreeRow[] = [];
  // whether each node of the collection being added matches (one bottom-up pass per collection and query, cached)
  let matches: (n: CollectionNode) => boolean = () => true;
  const extraShown = (i: ExtraGroup['items'][number]) => callShown(i, f, favoritesOnly);
  /**
   * A collection's contents by its folders, every kind of request in them: the collection's requests in their order and
   * its gRPC calls and connections at their place (`folderId`, `after`; a folder that is gone: the top level).
   */
  const addContents = (c: Collection, extras: ExtraGroup[]) => {
    type Call = { id: string; name: string; after?: string; g: ExtraGroup; i: ExtraGroup['items'][number] };
    // all of this only when the collection has calls: a collection of requests alone is drawn from its nodes as they are
    let byFolder: Map<string, Call[]> | undefined;
    // how many calls each folder holds, the folders inside it included
    const counts = new Map<string, number>();
    // the folders that hold a call the filter shows (and the folders around them)
    const withCalls = new Set<string>();
    if (extras.length) {
      // every folder's parent, and the folders in the order they are met (a folder before the folders inside it)
      const parent = new Map<string, string | undefined>();
      const folders: string[] = [];
      const walk = (nodes: CollectionNode[], up?: string) => {
        for (const n of nodes) if (n.kind === 'folder') (parent.set(n.id, up), folders.push(n.id), walk(n.items, n.id));
      };
      walk(c.items);
      byFolder = new Map();
      for (const g of extras)
        for (const i of g.items) {
          const at = i.folderId && parent.has(i.folderId) ? i.folderId : '';
          const call = { id: i.id, name: i.name, after: i.after, g, i };
          const list = byFolder.get(at);
          if (list) list.push(call);
          else byFolder.set(at, [call]);
          if (f && extraShown(i)) for (let up: string | undefined = at || undefined; up && !withCalls.has(up); up = parent.get(up)) withCalls.add(up);
        }
      // bottom-up in one pass: backwards, every folder is met after the folders inside it and adds its count to its parent's
      for (let k = folders.length - 1; k >= 0; k--) {
        const id = folders[k]!;
        const n = (counts.get(id) ?? 0) + (byFolder.get(id)?.length ?? 0);
        if (!n) continue;
        counts.set(id, n);
        const up = parent.get(id);
        if (up) counts.set(up, (counts.get(up) ?? 0) + n);
      }
    }
    const addNode = (n: CollectionNode, depth: number) => {
      if (!matches(n) && !(n.kind === 'folder' && withCalls.has(n.id))) return;
      const key = scopedNodeId(c.id, n.id);
      if (n.kind === 'folder') {
        const isOpen = isOpenKey(open, folderOpenKey(c.id, n.id), n.id) ?? !!f;
        const calls = counts.get(n.id);
        out.push({ t: 'folder', key, c, n, depth, open: isOpen, ...(calls ? { calls } : {}) });
        if (isOpen) add(n.items, depth + 1, n.id);
        return;
      }
      out.push({ t: 'req', key, c, n, depth });
      if (n.kind === 'http' && n.examples?.length && isOpenKey(open, examplesOpenKey(c.id, n.id), treeKey(n.id, 'examples')))
        for (const ex of n.examples) out.push({ t: 'example', key: treeKey(key, 'ex', ex.id), c, n, ex, depth });
    };
    const add = (nodes: CollectionNode[], depth: number, folderId: string) => {
      const calls = byFolder?.get(folderId);
      if (!calls) {
        for (const n of nodes) addNode(n, depth);
        return;
      }
      for (const x of interleave(nodes, calls)) {
        if ('node' in x) addNode(x.node, depth);
        else if (extraShown(x.call.i)) out.push({ t: 'xitem', key: treeKey(c.id, x.call.g.cat, x.call.id), c, g: x.call.g, i: x.call.i, depth, from: c.id });
      }
    };
    add(c.items, 1, '');
  };
  for (const c of collections) {
    matches = f || favoritesOnly ? matchIndex(c.items, f, favoritesOnly) : () => true;
    const extras = (extraGroups?.(c) ?? []).filter((g) => g.items.length);
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
