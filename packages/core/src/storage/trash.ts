import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import type { WorkspaceStore } from './workspace.js';
import { readJson } from './fsutil.js';
import { COLLECTION_ITEM_KINDS } from '../runner/collection-realtime.js';

/**
 * Recently deleted collections, environments and datasets. Deleting moves the file to the workspace's `trash/`
 * folder (never committed: it holds its own `.gitignore`), from where it can be restored for 30 days.
 * Secret values stay in the secret store, so a restored environment still has them. A deleted collection's gRPC
 * calls and connections stay in the library, hidden, and come back with it; purged, they are deleted with it.
 */
export type TrashKind = 'collection' | 'environment' | 'dataset';
export const TRASH_DAYS = 30;

export interface TrashItem {
  /** Trash entry id (`<kind>/<file>`). */
  id: string;
  kind: TrashKind;
  /** The item's own id and name when it was deleted. */
  itemId: string;
  name: string;
  deletedAt: string;
  /** Requests in a collection, variables in an environment, bytes of a dataset. */
  size: number;
}

const DIRS: Record<TrashKind, string> = { collection: 'collections', environment: 'environments', dataset: 'datasets' };

const trashDir = (store: WorkspaceStore, kind?: TrashKind) => (kind ? store.path('trash', DIRS[kind]) : store.path('trash'));

/** Move a workspace file (collections/x.json, environments/x.json, datasets/x.csv) into the trash. */
export function moveToTrash(store: WorkspaceStore, kind: TrashKind, file: string): void {
  if (!existsSync(file)) return;
  const dir = trashDir(store, kind);
  mkdirSync(dir, { recursive: true });
  const ignore = join(trashDir(store), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# deleted items (restorable in TestPion for 30 days); never commit them\n*\n');
  renameSync(file, join(dir, `${Date.now()}--${basename(file)}`));
}

/** The id a trashed collection file had (undefined for an unreadable file). */
function trashedCollectionId(path: string): string | undefined {
  try {
    const id = readJson<{ id?: unknown }>(path).id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A collection is gone for good: delete its gRPC calls and connections too (unless a live collection has its id again). */
function dropCollectionItems(store: WorkspaceStore, collectionIds: Array<string | undefined>): void {
  const live = new Set(store.listCollections().map((c) => c.id));
  const gone = new Set(collectionIds.filter((id): id is string => !!id && !live.has(id)));
  if (!gone.size) return;
  for (const kind of COLLECTION_ITEM_KINDS) {
    const lib = store.getLibrary(kind);
    const keep = lib.items.filter((i) => !i.collectionId || !gone.has(i.collectionId));
    if (keep.length !== lib.items.length) store.saveLibrary(kind, { folders: lib.folders, items: keep });
  }
}

function count(kind: TrashKind, data: Record<string, unknown>): number {
  if (kind === 'environment') return Array.isArray(data.variables) ? data.variables.length : 0;
  const walk = (nodes: unknown): number => (Array.isArray(nodes) ? nodes.reduce<number>((n, x) => n + ((x as { kind?: string }).kind === 'folder' ? walk((x as { items?: unknown }).items) : 1), 0) : 0);
  return walk(data.items);
}

/** Deleted items, newest first; entries older than 30 days are removed on the way. */
export function listTrash(store: WorkspaceStore, now = Date.now()): TrashItem[] {
  const out: TrashItem[] = [];
  for (const kind of Object.keys(DIRS) as TrashKind[]) {
    const dir = trashDir(store, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      // a dataset keeps its own name and extension (users.csv); collections and environments are JSON files
      const m = kind === 'dataset' ? /^(\d+)--(.+)$/.exec(f) : /^(\d+)--(.+)\.json$/.exec(f);
      if (!m) continue;
      const at = Number(m[1]);
      const path = join(dir, f);
      if (now - at > TRASH_DAYS * 86_400_000) {
        const gone = kind === 'collection' ? trashedCollectionId(path) : undefined;
        rmSync(path, { force: true });
        if (gone) dropCollectionItems(store, [gone]);
        continue;
      }
      if (kind === 'dataset') {
        out.push({ id: `${kind}/${f}`, kind, itemId: m[2]!, name: m[2]!, deletedAt: new Date(at).toISOString(), size: statSync(path).size });
        continue;
      }
      try {
        const data = readJson<Record<string, unknown>>(path);
        out.push({ id: `${kind}/${f}`, kind, itemId: String(data.id ?? m[2]), name: String(data.name ?? m[2]), deletedAt: new Date(at).toISOString(), size: count(kind, data) });
      } catch {
        /* unreadable entry: leave it for "Empty trash" */
      }
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

function entryPath(store: WorkspaceStore, id: string): { kind: TrashKind; path: string } {
  const m = /^(collection|environment|dataset)\/(\d+--[^/\\]+)$/.exec(id);
  if (!m) throw new ApsError('ValidationError', `Not a trash entry: ${id}`, { suggestions: [] });
  const path = join(trashDir(store, m[1] as TrashKind), m[2]!);
  if (!existsSync(path)) throw new ApsError('ValidationError', 'That item is no longer in the trash', { suggestions: [] });
  return { kind: m[1] as TrashKind, path };
}

/**
 * Put a deleted item back. If the workspace has an item with the same id or name again, the restored one
 * gets a new id and "(restored)" after its name, so nothing is overwritten. A dataset goes back to datasets/
 * (as name-restored.csv when the name is taken again).
 */
export function restoreFromTrash(store: WorkspaceStore, id: string): { kind: TrashKind; id: string; name: string } {
  const { kind, path } = entryPath(store, id);
  if (kind === 'dataset') {
    const name = basename(path).replace(/^\d+--/, '');
    const dir = store.path('datasets');
    mkdirSync(dir, { recursive: true });
    let dest = join(dir, name);
    if (existsSync(dest)) dest = join(dir, name.replace(/(\.[^.]+)?$/, '-restored$1'));
    renameSync(path, dest);
    return { kind, id: basename(dest), name: basename(dest) };
  }
  const data = readJson<{ id: string; name: string } & Record<string, unknown>>(path);
  const existing = kind === 'collection' ? store.listCollections().map((c) => ({ id: c.id, name: c.name })) : store.listEnvironments().map((e) => ({ id: e.id, name: e.name }));
  const clash = existing.some((x) => x.id === data.id || x.name.toLowerCase() === String(data.name).toLowerCase());
  const item = clash ? { ...data, id: `${slugify(String(data.name))}-${shortId().slice(-4)}`, name: `${data.name} (restored)` } : data;
  if (kind === 'collection') {
    store.saveCollection(item as never);
    // restored under a new id (its name or id is taken again): its gRPC calls and connections follow it,
    // unless a live collection has the old id (then they can't be told apart and stay where they are)
    if (item.id !== data.id && !existing.some((x) => x.id === data.id))
      for (const k of COLLECTION_ITEM_KINDS) {
        const lib = store.getLibrary(k);
        if (lib.items.some((i) => i.collectionId === data.id)) store.saveLibrary(k, { folders: lib.folders, items: lib.items.map((i) => (i.collectionId === data.id ? { ...i, collectionId: item.id } : i)) });
      }
  } else store.saveEnvironment(item as never);
  rmSync(path, { force: true });
  return { kind, id: item.id, name: item.name };
}

/** Delete trash entries for good: one, or all. */
export function purgeTrash(store: WorkspaceStore, id?: string): number {
  if (id) {
    const { kind, path } = entryPath(store, id);
    const gone = kind === 'collection' ? trashedCollectionId(path) : undefined;
    rmSync(path, { force: true });
    dropCollectionItems(store, [gone]);
    return 1;
  }
  const items = listTrash(store);
  const dir = trashDir(store, 'collection');
  const gone = existsSync(dir) ? readdirSync(dir).map((f) => trashedCollectionId(join(dir, f))) : [];
  for (const kind of Object.keys(DIRS) as TrashKind[]) rmSync(trashDir(store, kind), { recursive: true, force: true });
  dropCollectionItems(store, gone);
  return items.length;
}
