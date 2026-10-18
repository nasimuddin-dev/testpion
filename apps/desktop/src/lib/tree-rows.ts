import type { Collection, CollectionFolder, CollectionNode, SavedHttpRequest } from '../types';
import type { NodeMenuCtx } from './node-menu-actions';
import { hasCategory, isEmptyFolder, matchIndex, requestCategory, countCategory, type RequestCategory } from './collection-filter';
import { treeKey } from './tree-state';

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
  cat: 'grpc' | 'websocket';
  items: Array<{ id: string; name: string; folder?: string; badge?: string }>;
  onOpen(id: string): void;
  /** What its menu can do (lib/node-menu.ts builds the menu from it, only while open). */
  menu?(id: string): NodeMenuCtx;
  /** What a folder's menu can do (rename it, delete it: its items move to the top level). */
  folderMenu?(folder: string): NodeMenuCtx;
  /** Rename an item in place (F2, or Rename in its menu). */
  rename?(id: string): { editing: boolean; start(): void; done(name?: string): void };
}

/** One row of the tree as drawn. `key` is unique in the tree (scoped by collection); `id` is the row's `data-node-id`. */
export type TreeRow =
  | { t: 'col'; key: string; c: Collection; open: boolean }
  | { t: 'cat'; key: string; c: Collection; cat: RequestCategory; count: number; open: boolean }
  | { t: 'folder'; key: string; c: Collection; n: CollectionFolder; depth: number; open: boolean }
  | { t: 'req'; key: string; c: Collection; n: Exclude<CollectionNode, CollectionFolder>; depth: number }
  | { t: 'example'; key: string; c: Collection; n: SavedHttpRequest; ex: { id: string; name: string; status: number }; depth: number }
  | { t: 'xfolder'; key: string; folder: string; count: number; open: boolean; depth: number; g: ExtraGroup }
  | { t: 'xitem'; key: string; g: ExtraGroup; i: ExtraGroup['items'][number]; depth: number; from?: string }
  | { t: 'empty'; key: string; c: Collection };

/** A node of a collection, named so that no other collection's node has the same name: `<collection id>:<node id>`. */
export const scopedNodeId = (collectionId: string, nodeId: string) => treeKey(collectionId, nodeId);

/** The open/closed key of a folder, and of a request's examples (scoped; the keys of older versions are still read). */
export const folderOpenKey = (collectionId: string, folderId: string) => scopedNodeId(collectionId, folderId);
export const examplesOpenKey = (collectionId: string, requestId: string) => treeKey(scopedNodeId(collectionId, requestId), 'examples');
/** The open/closed key of a collection's protocol category (REST, SOAP, GraphQL, gRPC, WebSocket). */
export const categoryOpenKey = (collectionId: string, cat: RequestCategory) => treeKey(collectionId, 'cat', cat);
/** The open/closed key of a folder of saved gRPC calls or connections shown under a collection. */
export const extraFolderOpenKey = (collectionId: string | undefined, cat: 'grpc' | 'websocket', folder: string) => treeKey(collectionId ?? '', cat, 'folder', folder);
/** Whether a scoped key is open: the scoped key wins; the unscoped key an older version saved is the fallback. */
export const isOpenKey = (open: Record<string, boolean>, scoped: string, legacy: string): boolean | undefined => open[scoped] ?? open[legacy];

/** The React key of a row: its kind and its scoped key (unique in the tree). */
export const treeRowKey = (r: TreeRow) => `${r.t}:${r.key}`;

export interface TreeRowsInput {
  collections: Collection[];
  open: Record<string, boolean>;
  filter?: string;
  favoritesOnly?: boolean;
  categorize?: boolean;
  extraGroups?(c: Collection): ExtraGroup[];
}

/** Every row that shows (the open collections, categories and folders), in order. */
export function buildTreeRows({ collections, open, filter, favoritesOnly = false, categorize = false, extraGroups }: TreeRowsInput): TreeRow[] {
  const f = filter?.trim().toLowerCase() || undefined;
  const out: TreeRow[] = [];
  // whether each node of the collection being added matches (one bottom-up pass per collection and query, cached)
  let matches: (n: CollectionNode) => boolean = () => true;
  // in a category, a folder shows when it holds requests of that category (empty folders: the first category)
  const inScope = (n: CollectionNode, scope?: { cat: RequestCategory; first: boolean }) =>
    !scope || (n.kind === 'folder' ? hasCategory(n.items, scope.cat) || (scope.first && isEmptyFolder(n)) : requestCategory(n) === scope.cat);
  const extraShown = (i: ExtraGroup['items'][number]) => !f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f);
  const addNodes = (c: Collection, nodes: CollectionNode[], depth: number, scope?: { cat: RequestCategory; first: boolean }) => {
    for (const n of nodes) {
      if (!matches(n) || !inScope(n, scope)) continue;
      const key = scopedNodeId(c.id, n.id);
      if (n.kind === 'folder') {
        const isOpen = isOpenKey(open, folderOpenKey(c.id, n.id), n.id) ?? !!f;
        out.push({ t: 'folder', key, c, n, depth, open: isOpen });
        if (isOpen) addNodes(c, n.items, depth + 1, scope);
        continue;
      }
      out.push({ t: 'req', key, c, n, depth });
      if (n.kind === 'http' && n.examples?.length && isOpenKey(open, examplesOpenKey(c.id, n.id), `${n.id}:examples`))
        for (const ex of n.examples) out.push({ t: 'example', key: `${key}:ex:${ex.id}`, c, n, ex, depth });
    }
  };
  const addExtra = (g: ExtraGroup, depth: number, from?: string) => {
    const shown = g.items.filter(extraShown);
    const folders = [...new Set(shown.map((i) => i.folder ?? ''))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    for (const folder of folders) {
      // a folder of saved gRPC calls / connections: the same row as a collection's folders
      const key = extraFolderOpenKey(from, g.cat, folder);
      const isOpen = !!f || (open[key] ?? true);
      const inside = shown.filter((i) => (i.folder ?? '') === folder);
      if (folder) out.push({ t: 'xfolder', key, folder, count: inside.length, open: isOpen, depth, g });
      if (isOpen || !folder) for (const i of inside) out.push({ t: 'xitem', key: treeKey(from ?? '', g.cat, i.id), g, i, depth: depth + (folder ? 1 : 0), from });
    }
  };
  /** A collection's contents: grouped by category when it holds more than one kind of request. */
  const addContents = (c: Collection, extras: ExtraGroup[]) => {
    if (!categorize) return addNodes(c, c.items, 1);
    const cats = (['rest', 'soap', 'graphql'] as const).filter((k) => hasCategory(c.items, k));
    if (!cats.length && c.items.some(isEmptyFolder)) cats.push('rest');
    // the category level shows even for one kind, so every collection reads the same way
    if (!cats.length && !extras.length) {
      addNodes(c, c.items, 1);
      return;
    }
    cats.forEach((cat, i) => {
      const key = categoryOpenKey(c.id, cat);
      const isOpen = !!f || (open[key] ?? true);
      const scope = { cat, first: i === 0 };
      if (f && !c.items.some((n) => matches(n) && inScope(n, scope))) return;
      out.push({ t: 'cat', key, c, cat, count: countCategory(c.items, cat), open: isOpen });
      if (isOpen) addNodes(c, c.items, 2, scope);
    });
    for (const g of extras) {
      const key = categoryOpenKey(c.id, g.cat);
      const isOpen = !!f || (open[key] ?? true);
      if (f && !g.items.some(extraShown)) continue;
      out.push({ t: 'cat', key, c, cat: g.cat, count: g.items.length, open: isOpen });
      if (isOpen) addExtra(g, 2, c.id);
    }
  };
  for (const c of collections) {
    matches = f || favoritesOnly ? matchIndex(c.items, f, favoritesOnly) : () => true;
    const extras = (extraGroups?.(c) ?? []).filter((g) => g.items.length);
    // grouped by category, collections start folded: the workspace lists them, expanding shows the categories
    // a collection opens when the user opens it (or something is revealed in it), not because its request is open
    const isOpen = categorize && f ? true : (open[c.id] ?? !categorize);
    if (categorize && f && !c.items.some(matches) && !extras.some((g) => g.items.some(extraShown))) continue;
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
