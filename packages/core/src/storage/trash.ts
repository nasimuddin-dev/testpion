import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ApsError } from '../errors.js';
import type { McpServerConfig } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import type { WorkspaceStore } from './workspace.js';
import { readJson, renameOwned, writeJson } from './fsutil.js';
import { COLLECTION_ITEM_KINDS } from '../runner/collection-realtime.js';
import { KIND_INFO, kindsWith, type KindId } from '@testpion/shared';

/**
 * Recently deleted collections, environments, datasets, API definitions (specs/) and MCP servers. Deleting moves the
 * item to the workspace's `trash/` folder (never committed: it holds its own `.gitignore`), from where it can be
 * restored for 30 days. Secret values stay in the secret store, so a restored environment still has them. A deleted
 * collection's gRPC calls and connections stay in the library, hidden, and come back with it; purged, they are deleted
 * with it. An MCP server keeps its id and its place in the list; an API definition its path.
 */
/** The kinds whose `trash` capability is true in the item-kind registry (each needs a KindDef below). */
type TrashKind = Extract<KindId, 'collection' | 'environment' | 'dataset' | 'spec' | 'mcp-server'>;
export const TRASH_DAYS = 30;

export interface TrashItem {
  /** Trash entry id (`<kind>/<file>`). */
  id: string;
  kind: TrashKind;
  /** The item's own id and name when it was deleted (a spec: its path, `specs/x.yaml`). */
  itemId: string;
  name: string;
  deletedAt: string;
  /** Requests in a collection, variables in an environment, bytes of a dataset or spec, tools … nothing for a server (0). */
  size: number;
}

/** What one kind of trashed item is: how one is listed and put back (where its entries live comes from the registry's storage). */
interface KindDef {
  /** What the items are called, plural ("API definitions"): help texts list the kinds from here. */
  label: string;
  /** An entry's file name after `<time>--`: JSON files for items saved as JSON, the file itself for datasets and specs. */
  entry: RegExp;
  describe(store: WorkspaceStore, path: string, name: string): Pick<TrashItem, 'itemId' | 'name' | 'size'>;
  restore(store: WorkspaceStore, path: string, name: string): { id: string; name: string };
}

/** A saved JSON item's id and name; one with the same id or name again gets a new id and "(restored)". */
function unclash<T extends { id: string; name: string }>(data: T, existing: Array<{ id: string; name: string }>): T {
  const clash = existing.some((x) => x.id === data.id || x.name.toLowerCase() === String(data.name).toLowerCase());
  return clash ? { ...data, id: `${slugify(String(data.name))}-${shortId().slice(-4)}`, name: `${data.name} (restored)` } : data;
}

/** A file put back in its folder, as name-restored.ext when the name is taken again. */
function restoreFile(path: string, dir: string, rel: string): string {
  let dest = join(dir, ...rel.split('/'));
  if (existsSync(dest)) dest = dest.replace(/(\.[^./\\]+)?$/, '-restored$1');
  mkdirSync(join(dest, '..'), { recursive: true });
  renameOwned(path, dest);
  return dest;
}

const count = (data: Record<string, unknown>): number => {
  const walk = (nodes: unknown): number => (Array.isArray(nodes) ? nodes.reduce<number>((n, x) => n + ((x as { kind?: string }).kind === 'folder' ? walk((x as { items?: unknown }).items) : 1), 0) : 0);
  return walk(data.items);
};

/** A spec's path inside specs/ as one file name (`asyncapi/x.yaml` → `asyncapi%2Fx.yaml`), and back (never out of specs/). */
const specEntryName = (rel: string) => encodeURIComponent(rel.replace(/^specs\//, ''));
function specRelOf(name: string): string {
  let rel = '';
  try {
    rel = decodeURIComponent(name);
  } catch {
    /* a malformed %-sequence (a file put there by hand): not an entry */
  }
  if (!rel || rel.split('/').some((n) => n === '..' || n === '' || n.includes('\\')) || /^[a-z]:/i.test(rel)) throw new ApsError('ValidationError', `Not a trash entry: ${name}`, { suggestions: [] });
  return rel;
}

const KINDS: Record<TrashKind, KindDef> = {
  collection: {
    label: 'collections',
    entry: /^(.+)\.json$/,
    describe: (_s, path, name) => {
      const data = readJson<Record<string, unknown>>(path);
      return { itemId: String(data.id ?? name), name: String(data.name ?? name), size: count(data) };
    },
    restore: (store, path) => {
      const data = readJson<{ id: string; name: string } & Record<string, unknown>>(path);
      const existing = store.listCollections().map((c) => ({ id: c.id, name: c.name }));
      const item = unclash(data, existing);
      store.saveCollection(item as never);
      // restored under a new id (its name or id is taken again): its gRPC calls and connections follow it,
      // unless a live collection has the old id (then they can't be told apart and stay where they are)
      if (item.id !== data.id && !existing.some((x) => x.id === data.id))
        for (const k of COLLECTION_ITEM_KINDS) {
          const lib = store.getLibrary(k);
          if (lib.items.some((i) => i.collectionId === data.id)) store.saveLibrary(k, { folders: lib.folders, items: lib.items.map((i) => (i.collectionId === data.id ? { ...i, collectionId: item.id } : i)) });
        }
      rmSync(path, { force: true });
      return { id: item.id, name: item.name };
    },
  },
  environment: {
    label: 'environments',
    entry: /^(.+)\.json$/,
    describe: (_s, path, name) => {
      const data = readJson<Record<string, unknown>>(path);
      return { itemId: String(data.id ?? name), name: String(data.name ?? name), size: Array.isArray(data.variables) ? data.variables.length : 0 };
    },
    restore: (store, path) => {
      const item = unclash(readJson<{ id: string; name: string } & Record<string, unknown>>(path), store.listEnvironments());
      store.saveEnvironment(item as never);
      rmSync(path, { force: true });
      return { id: item.id, name: item.name };
    },
  },
  // a dataset keeps its own name and extension (users.csv)
  dataset: {
    label: 'datasets',
    entry: /^(.+)$/,
    describe: (_s, path, name) => ({ itemId: name, name, size: statSync(path).size }),
    restore: (store, path, name) => {
      const dest = restoreFile(path, store.path('datasets'), name);
      return { id: basename(dest), name: basename(dest) };
    },
  },
  // an API definition keeps its path under specs/ (asyncapi/x.yaml), encoded as one file name
  spec: {
    label: 'API definitions',
    entry: /^(.+)$/,
    describe: (_s, path, name) => {
      const rel = `specs/${specRelOf(name)}`;
      return { itemId: rel, name: rel.replace(/^specs\//, ''), size: statSync(path).size };
    },
    restore: (store, path, name) => {
      const dest = restoreFile(path, store.path('specs'), specRelOf(name));
      const rel = `specs/${dest.slice(store.path('specs').length + 1).split(/[\\/]/).join('/')}`;
      return { id: rel, name: rel.replace(/^specs\//, '') };
    },
  },
  // an MCP server: its config and its place in the list (it goes back there)
  'mcp-server': {
    label: 'MCP servers',
    entry: /^(.+)\.json$/,
    describe: (_s, path, name) => {
      const { server } = readJson<{ server: McpServerConfig }>(path);
      return { itemId: String(server?.id ?? name), name: String(server?.name ?? name), size: 0 };
    },
    restore: (store, path) => {
      const { server, position } = readJson<{ server: McpServerConfig; position?: number }>(path);
      const list = store.getMcpServers();
      const item = unclash(server, list);
      const at = Math.max(0, Math.min(Number.isInteger(position) ? position! : list.length, list.length));
      store.saveMcpServers([...list.slice(0, at), item, ...list.slice(at)]);
      rmSync(path, { force: true });
      return { id: item.id, name: item.name };
    },
  },
};

/** The registry's kinds with the `trash` capability, in its order; each one must have its KindDef here. */
const TRASH_KINDS = kindsWith('trash').map((k) => k.id) as TrashKind[];
for (const k of TRASH_KINDS) if (!KINDS[k]) throw new Error(`The kind ${k} has the trash capability but no trash entry`);

/** The kinds Recently deleted keeps, in words ("collections, environments, … and MCP servers"), for help texts. */
export function trashKindsText(): string {
  const labels = TRASH_KINDS.map((k) => KINDS[k].label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels.join('');
}
const ENTRY_ID = new RegExp(`^(${TRASH_KINDS.join('|')})\\/(\\d+--[^/\\\\]+)$`);

/** Where a kind's entries live under trash/: the kind's storage folder (collections/, datasets/ …), or its file's name for a kind kept as a list in one file (mcp-servers). */
function trashDirOf(kind: TrashKind): string {
  const s = KIND_INFO[kind].storage;
  return 'dir' in s ? s.dir : 'file' in s ? s.file.replace(/\.json$/, '') : kind;
}

const trashDir = (store: WorkspaceStore, kind?: TrashKind) => (kind ? store.path('trash', trashDirOf(kind)) : store.path('trash'));

/** The trash folder for a kind, made (with the .gitignore that keeps the trash out of commits) when needed. */
function ensureTrashDir(store: WorkspaceStore, kind: TrashKind): string {
  const dir = trashDir(store, kind);
  mkdirSync(dir, { recursive: true });
  const ignore = join(trashDir(store), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# deleted items (restorable in TestPion for 30 days); never commit them\n*\n');
  return dir;
}

/** Move a workspace file (collections/x.json, environments/x.json, datasets/x.csv) into the trash; the entry id, or undefined when there was no file. */
export function moveToTrash(store: WorkspaceStore, kind: TrashKind, file: string, entryName = basename(file)): string | undefined {
  if (!existsSync(file)) return undefined;
  const name = `${Date.now()}--${entryName}`;
  renameOwned(file, join(ensureTrashDir(store, kind), name));
  return `${kind}/${name}`;
}

/** Delete an API definition (`specs/x.yaml`, `specs/asyncapi/y.yaml`) to the trash; the entry id. */
export function trashSpec(store: WorkspaceStore, rel: string): string {
  const path = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^specs\/./.test(path)) throw new ApsError('ValidationError', `Not an API definition in specs/: ${rel}`, { suggestions: [] });
  const file = store.safePath(path);
  if (!store.isInside(file, 'specs')) throw new ApsError('ValidationError', `Not an API definition in specs/: ${rel}`, { suggestions: [] });
  const id = moveToTrash(store, 'spec', file, specEntryName(path));
  if (!id) throw new ApsError('ConfigurationError', `No API definition ${rel}`, { suggestions: [] });
  return id;
}

/** Delete an MCP server to the trash (its config and place in the list); the entry id and the server. */
export function trashMcpServer(store: WorkspaceStore, serverId: string): { trashId: string; server: McpServerConfig } {
  const list = store.getMcpServers();
  const position = list.findIndex((s) => s.id === serverId);
  if (position < 0) throw new ApsError('ConfigurationError', `Unknown MCP server ${serverId}`, { suggestions: [] });
  const server = list[position]!;
  const name = `${Date.now()}--${slugify(server.id) || 'server'}.json`;
  // the entry first, then the list without it: a failure in between never loses the server
  writeJson(join(ensureTrashDir(store, 'mcp-server'), name), { server, position });
  store.saveMcpServers(list.filter((s) => s.id !== serverId));
  return { trashId: `mcp-server/${name}`, server };
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

/**
 * Removes the trash entries older than 30 days. A separate step (at open, then now and then), never a side effect of looking: a listing on
 * a computer whose clock is wrong must not empty the trash.
 */
export function expireTrash(store: WorkspaceStore, now = Date.now()): number {
  let n = 0;
  for (const kind of TRASH_KINDS) {
    const dir = trashDir(store, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)--(.+)$/.exec(f);
      if (!m || !KINDS[kind].entry.exec(m[2]!)) continue;
      if (now - Number(m[1]) <= TRASH_DAYS * 86_400_000) continue;
      const path = join(dir, f);
      const gone = kind === 'collection' ? trashedCollectionId(path) : undefined;
      rmSync(path, { recursive: true, force: true });
      if (gone) dropCollectionItems(store, [gone]);
      n++;
    }
  }
  return n;
}

/** Deleted items, newest first; entries older than 30 days are left out (expireTrash removes them), nothing is deleted here. */
export function listTrash(store: WorkspaceStore, now = Date.now()): TrashItem[] {
  const out: TrashItem[] = [];
  for (const kind of TRASH_KINDS) {
    const dir = trashDir(store, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)--(.+)$/.exec(f);
      const name = m && KINDS[kind].entry.exec(m[2]!)?.[1];
      if (!m || !name) continue;
      const at = Number(m[1]);
      const path = join(dir, f);
      if (now - at > TRASH_DAYS * 86_400_000) continue;
      try {
        out.push({ id: `${kind}/${f}`, kind, ...KINDS[kind].describe(store, path, name), deletedAt: new Date(at).toISOString() });
      } catch {
        /* unreadable entry: leave it for "Empty trash" */
      }
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

function entryPath(store: WorkspaceStore, id: string): { kind: TrashKind; path: string; name: string } {
  const m = ENTRY_ID.exec(id);
  const kind = m?.[1] as TrashKind | undefined;
  const name = kind && KINDS[kind].entry.exec(m![2]!.replace(/^\d+--/, ''))?.[1];
  if (!kind || !name) throw new ApsError('ValidationError', `Not a trash entry: ${id}`, { suggestions: [] });
  const path = join(trashDir(store, kind), m![2]!);
  if (!existsSync(path)) throw new ApsError('ValidationError', 'That item is no longer in the trash', { suggestions: [] });
  return { kind, path, name };
}

/**
 * Put a deleted item back. If the workspace has an item with the same id or name again, the restored one gets a new id
 * and "(restored)" after its name, so nothing is overwritten. A dataset or an API definition goes back to its folder (as
 * name-restored.ext when the name is taken again); an MCP server to its place in the list.
 */
export function restoreFromTrash(store: WorkspaceStore, id: string): { kind: TrashKind; id: string; name: string } {
  const { kind, path, name } = entryPath(store, id);
  return { kind, ...KINDS[kind].restore(store, path, name) };
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
  for (const kind of TRASH_KINDS) rmSync(trashDir(store, kind), { recursive: true, force: true });
  dropCollectionItems(store, gone);
  return items.length;
}
