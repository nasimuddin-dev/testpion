/**
 * Any kind of request in any folder of a collection. REST, SOAP and GraphQL requests are nodes of the collection file;
 * gRPC calls and WebSocket / Socket.IO / MQTT / Kafka connections are kept in the workspace library (library/grpc.json,
 * library/websocket.json) with the collection they belong to (`collectionId`). Their place in that collection is
 * `folderId` (a folder of the collection; none: its top level) and `after` (the sibling they follow, a request, a folder or
 * another call; none: after the collection's own nodes). The tree, the save dialog, Move and the importers read and write
 * these two fields; the item's data never moves, so its ref (`saved/grpc/<id>`), its history and its tests stay the same.
 *
 * Older versions kept a call's folder as text of its own (`folder: "Payments/Refunds"`), apart from the collection's
 * folders. `placeCollectionCalls` turns such a text into the collection folder of that path (made when missing), once,
 * and keeps the text for an older app that still reads it.
 */
import { COLLECTION_CALL_LIBRARIES, type CollectionCallLibrary } from '@testpion/shared';
export { interleave, callsInFolders, moveCallsWithFolders, copyCallsWithFolders } from '@testpion/shared';
import type { Collection, CollectionFolder, CollectionNode, LibraryItem } from '../model/types.js';
import { slugify } from '../util/ids.js';
import type { WorkspaceStore } from './workspace.js';

/** The folders of a collection by id, with their path of names from the top ("Payments / Refunds"). */
export function collectionFolders(c: Pick<Collection, 'items'>): Map<string, { folder: CollectionFolder; path: string[] }> {
  const out = new Map<string, { folder: CollectionFolder; path: string[] }>();
  const walk = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes)
      if (n.kind === 'folder') {
        out.set(n.id, { folder: n, path: [...path, n.name] });
        walk(n.items, [...path, n.name]);
      }
  };
  walk(c.items ?? [], []);
  return out;
}

/** A call's folder as a path of names ("Payments / Refunds"), from its collection folder, else the text folder of an older version. */
export function callFolderPath(c: Pick<Collection, 'items'>, item: Pick<LibraryItem, 'folderId' | 'folder'>, folders = collectionFolders(c)): string | undefined {
  const f = item.folderId ? folders.get(item.folderId) : undefined;
  return f ? f.path.join(' / ') : item.folder?.trim() || undefined;
}

/** The folder a path of names leads to, when the collection has it (names compared without case). */
export function folderByPath(c: Pick<Collection, 'items'>, path: string[]): CollectionFolder | undefined {
  let nodes = c.items ?? [];
  let found: CollectionFolder | undefined;
  for (const name of path) {
    found = nodes.find((n): n is CollectionFolder => n.kind === 'folder' && n.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!found) return undefined;
    nodes = found.items;
  }
  return found;
}

/** A text folder of an older version as a path of names ("Payments/Refunds"). */
export const textFolderPath = (text?: string): string[] =>
  (text ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The folder of this path in the collection's items, made when missing (`made` counts the new ones). A new folder's id
 * comes from the collection and the path, not from chance: two people who open the same older workspace make the same
 * folder, so git has nothing to merge (`taken`: every id in use; a clash gets -2, -3 …, the same on every computer).
 */
function folderOfPath(items: CollectionNode[], path: string[], made: { n: number }, scope: { collectionId: string; taken: Set<string>; done?: string[] }): { items: CollectionNode[]; id: string } {
  const [head, ...rest] = path;
  const done = [...(scope.done ?? []), head!];
  const at = items.findIndex((n) => n.kind === 'folder' && n.name.trim().toLowerCase() === head!.toLowerCase());
  let folder = at >= 0 ? (items[at] as CollectionFolder) : undefined;
  if (!folder) {
    const base = `fld-${slugify(`${scope.collectionId} ${done.join(' ')}`) || 'folder'}`;
    let id = base;
    for (let n = 2; scope.taken.has(id); n++) id = `${base}-${n}`;
    scope.taken.add(id);
    folder = { kind: 'folder', id, name: head!, items: [] };
    made.n++;
  }
  let id = folder.id;
  if (rest.length) {
    const inner = folderOfPath(folder.items, rest, made, { ...scope, done });
    folder = { ...folder, items: inner.items };
    id = inner.id;
  }
  const next = at >= 0 ? items.map((n, i) => (i === at ? folder! : n)) : [...items, folder];
  return { items: next, id };
}

/**
 * Give every gRPC call and connection that has a text folder but no collection folder the collection folder of that path
 * (made when the collection has none). Writes the collections and libraries that changed; returns how many calls moved.
 * A collection that cannot be read is left alone.
 */
export function placeCollectionCalls(store: WorkspaceStore, libraries: readonly CollectionCallLibrary[] = COLLECTION_CALL_LIBRARIES): number {
  const collections = new Map<string, Collection>();
  const changedCollections = new Set<string>();
  let moved = 0;
  for (const library of libraries) {
    const lib = store.getLibrary(library);
    let changed = false;
    const items = lib.items.map((it) => {
      const text = it.folder?.trim();
      // (a folderId whose folder is gone is not placed again: the person deleted or moved that folder)
      if (!it.collectionId || it.folderId || !text) return it;
      let c = collections.get(it.collectionId);
      if (!c) {
        try {
          c = store.getCollection(it.collectionId);
        } catch {
          return it;
        }
        if ((c as { problem?: string }).problem) return it;
        collections.set(c.id, c);
      }
      const path = textFolderPath(text);
      if (!path.length) return it;
      const made = { n: 0 };
      const taken = new Set<string>();
      const ids = (nodes: CollectionNode[]) => {
        for (const n of nodes) (taken.add(n.id), n.kind === 'folder' && ids(n.items));
      };
      ids(c.items);
      const placed = folderOfPath(c.items, path, made, { collectionId: c.id, taken });
      if (made.n) {
        collections.set(c.id, { ...c, items: placed.items });
        changedCollections.add(c.id);
      }
      changed = true;
      moved++;
      return { ...it, folderId: placed.id };
    });
    if (changed) store.saveLibrary(library, { folders: lib.folders, items });
  }
  for (const id of changedCollections) store.saveCollection(collections.get(id)!);
  return moved;
}
