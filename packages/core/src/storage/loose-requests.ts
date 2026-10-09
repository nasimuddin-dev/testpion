import { existsSync } from 'node:fs';
import { ApsError } from '../errors.js';
import type { Collection, LibraryItem } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { COLLECTION_ITEM_KINDS } from '../runner/collection-realtime.js';
import { shortId, slugify } from '../util/ids.js';
import { listTrash } from './trash.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * A saved request always belongs to a collection. gRPC calls and connections are kept in the workspace library
 * (library/grpc.json, library/websocket.json) and point at their collection with `collectionId`; ones saved by
 * older versions may have none.
 */
export type CollectionItemKind = (typeof COLLECTION_ITEM_KINDS)[number];

/** The collection an item without a folder goes to, by kind. */
export const LOOSE_DEFAULT_COLLECTION: Record<CollectionItemKind, string> = { grpc: 'gRPC calls', websocket: 'Connections' };

export interface AdoptedRequests {
  /** Items moved, in total. */
  moved: number;
  /** Each collection that received items: created, or an existing one with exactly that name. */
  collections: Array<{ id: string; name: string; created: boolean; items: Array<{ kind: CollectionItemKind; id: string; name: string }> }>;
}

/**
 * Put every gRPC call and connection that isn't in a collection into one: grouped by their folder, each group goes
 * into a collection named after the folder (an existing collection with exactly that name, else a new one) and
 * leaves the folder; items without a folder go into "gRPC calls" or "Connections". An item whose collection is in
 * the trash is left alone (it comes back with the collection); one whose collection is gone for good is adopted.
 * Idempotent: a second call moves nothing and writes nothing.
 */
export function adoptLooseRequests(store: WorkspaceStore): AdoptedRequests {
  const libs = COLLECTION_ITEM_KINDS.map((kind) => ({ kind, lib: store.getLibrary(kind) }));
  const out: AdoptedRequests = { moved: 0, collections: [] };
  // the usual case: every item names a collection whose file is there; nothing else is read (listing the collections
  // would set a corrupted collection file aside before the app gets to report it)
  const fileOf = (id: string) => store.path('collections', `${slugify(id)}.json`);
  if (libs.every(({ lib }) => lib.items.every((i) => i.collectionId && existsSync(fileOf(i.collectionId))))) return out;
  const collections = store.listCollections();
  const live = new Set(collections.map((c) => c.id));
  let trashed: Set<string> | undefined;
  const isLoose = (i: LibraryItem) => {
    if (!i.collectionId) return true;
    if (live.has(i.collectionId)) return false;
    trashed ??= new Set(
      listTrash(store)
        .filter((t) => t.kind === 'collection')
        .map((t) => t.itemId),
    );
    return !trashed.has(i.collectionId);
  };
  const loose = libs.flatMap(({ kind, lib }) => lib.items.filter(isLoose).map((item) => ({ kind, item, group: item.folder?.trim() || LOOSE_DEFAULT_COLLECTION[kind] })));
  if (!loose.length) return out;

  const target = new Map<string, string>();
  for (const group of [...new Set(loose.map((l) => l.group))]) {
    const existing = collections.find((c) => c.name === group);
    let id = existing?.id;
    if (!id) {
      id = `${slugify(group) || 'collection'}-${shortId().slice(-4)}`;
      const c: Collection = { schemaVersion: SCHEMA_VERSION, id, name: group, version: 0, variables: [], items: [], updatedAt: new Date().toISOString() };
      store.saveCollection(c);
    }
    target.set(group, id);
    out.collections.push({ id, name: group, created: !existing, items: loose.filter((l) => l.group === group).map((l) => ({ kind: l.kind, id: l.item.id, name: l.item.name })) });
  }
  for (const { kind, lib } of libs) {
    const mine = new Map(loose.filter((l) => l.kind === kind).map((l) => [l.item.id, l.group]));
    if (!mine.size) continue;
    const items = lib.items.map((i) => {
      const group = mine.get(i.id);
      if (group === undefined) return i;
      const { folder: _folder, ...rest } = i;
      return { ...rest, collectionId: target.get(group)! };
    });
    // a folder that only held the moved items is now a collection
    const used = new Set(items.map((i) => i.folder).filter(Boolean));
    const emptied = new Set(loose.filter((l) => l.kind === kind && l.item.folder).map((l) => l.item.folder!));
    store.saveLibrary(kind, { folders: lib.folders.filter((f) => used.has(f) || !emptied.has(f)), items });
    out.moved += mine.size;
  }
  return out;
}

/** One line for logs and the workspace's "migrations applied on open". */
export function describeAdoption(r: AdoptedRequests): string {
  return `${r.moved} gRPC call${r.moved === 1 ? '' : 's'} / connection${r.moved === 1 ? '' : 's'} moved into collections (${r.collections.map((c) => `${c.name}${c.created ? ', new' : ''}`).join('; ')})`;
}

/**
 * Saving a gRPC call or connection needs a collection: the error lists the workspace's collections. `items` are the
 * new or changed items being saved.
 */
export function requireCollectionFor(store: Pick<WorkspaceStore, 'listCollections'>, kind: string, items: Array<Pick<LibraryItem, 'name' | 'collectionId'>>): void {
  if (!(COLLECTION_ITEM_KINDS as readonly string[]).includes(kind)) return;
  const missing = items.filter((i) => !i.collectionId);
  if (!missing.length) return;
  const names = store.listCollections().map((c) => c.name);
  const noun = kind === 'grpc' ? 'gRPC call' : 'connection';
  throw new ApsError('ConfigurationError', `Choose a collection to save the ${noun} "${missing[0]!.name}" in: every saved request belongs to a collection`, {
    suggestions: [names.length ? `Collections: ${names.join(', ')}.` : 'The workspace has no collections yet: create one first.', 'Unsaved tabs still send and connect without saving.'],
  });
}
