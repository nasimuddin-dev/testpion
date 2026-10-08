import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import type { WorkspaceStore } from './workspace.js';
import { readJson } from './fsutil.js';

/**
 * Recently deleted collections and environments. Deleting moves the file to the workspace's `trash/`
 * folder (never committed: it holds its own `.gitignore`), from where it can be restored for 30 days.
 * Secret values stay in the secret store, so a restored environment still has them.
 */
export type TrashKind = 'collection' | 'environment';
export const TRASH_DAYS = 30;

export interface TrashItem {
  /** Trash entry id (`<kind>/<file>`). */
  id: string;
  kind: TrashKind;
  /** The item's own id and name when it was deleted. */
  itemId: string;
  name: string;
  deletedAt: string;
  /** Requests in a collection, variables in an environment. */
  size: number;
}

const DIRS: Record<TrashKind, string> = { collection: 'collections', environment: 'environments' };

const trashDir = (store: WorkspaceStore, kind?: TrashKind) => (kind ? store.path('trash', DIRS[kind]) : store.path('trash'));

/** Move a workspace file (collections/x.json, environments/x.json) into the trash. */
export function moveToTrash(store: WorkspaceStore, kind: TrashKind, file: string): void {
  if (!existsSync(file)) return;
  const dir = trashDir(store, kind);
  mkdirSync(dir, { recursive: true });
  const ignore = join(trashDir(store), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# deleted items (restorable in TestPion for 30 days); never commit them\n*\n');
  renameSync(file, join(dir, `${Date.now()}--${basename(file)}`));
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
      const m = /^(\d+)--(.+)\.json$/.exec(f);
      if (!m) continue;
      const at = Number(m[1]);
      const path = join(dir, f);
      if (now - at > TRASH_DAYS * 86_400_000) {
        rmSync(path, { force: true });
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
  const m = /^(collection|environment)\/(\d+--[^/\\]+\.json)$/.exec(id);
  if (!m) throw new ApsError('ValidationError', `Not a trash entry: ${id}`, { suggestions: [] });
  const path = join(trashDir(store, m[1] as TrashKind), m[2]!);
  if (!existsSync(path)) throw new ApsError('ValidationError', 'That item is no longer in the trash', { suggestions: [] });
  return { kind: m[1] as TrashKind, path };
}

/**
 * Put a deleted item back. If the workspace has an item with the same id or name again, the restored one
 * gets a new id and "(restored)" after its name, so nothing is overwritten.
 */
export function restoreFromTrash(store: WorkspaceStore, id: string): { kind: TrashKind; id: string; name: string } {
  const { kind, path } = entryPath(store, id);
  const data = readJson<{ id: string; name: string } & Record<string, unknown>>(path);
  const existing = kind === 'collection' ? store.listCollections().map((c) => ({ id: c.id, name: c.name })) : store.listEnvironments().map((e) => ({ id: e.id, name: e.name }));
  const clash = existing.some((x) => x.id === data.id || x.name.toLowerCase() === String(data.name).toLowerCase());
  const item = clash ? { ...data, id: `${slugify(String(data.name))}-${shortId().slice(-4)}`, name: `${data.name} (restored)` } : data;
  if (kind === 'collection') store.saveCollection(item as never);
  else store.saveEnvironment(item as never);
  rmSync(path, { force: true });
  return { kind, id: item.id, name: item.name };
}

/** Delete trash entries for good: one, or all. */
export function purgeTrash(store: WorkspaceStore, id?: string): number {
  if (id) {
    rmSync(entryPath(store, id).path, { force: true });
    return 1;
  }
  const items = listTrash(store);
  for (const kind of Object.keys(DIRS) as TrashKind[]) rmSync(trashDir(store, kind), { recursive: true, force: true });
  return items.length;
}
