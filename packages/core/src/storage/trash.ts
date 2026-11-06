import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ApsError } from '../errors.js';
import type { LibraryItem, McpServerConfig } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import type { WorkspaceStore } from './workspace.js';
import { readJson, removeOwned, renameOwned, writeJson } from './fsutil.js';
import { COLLECTION_ITEM_KINDS } from '../runner/collection-realtime.js';
import { KIND_INFO, kindsWith, type KindId } from '@testpion/shared';

/**
 * Recently deleted collections, environments, datasets, API definitions (specs/) and MCP servers. Deleting moves the
 * item to the workspace's `trash/` folder (never committed: it holds its own `.gitignore`), from where it can be
 * restored for 30 days. Secret values stay in the secret store, so a restored environment still has them. An MCP
 * server keeps its id and its place in the list; an API definition its path.
 *
 * A deleted collection's gRPC calls and connections (kept in library/grpc.json and library/websocket.json) travel in its
 * trash entry (`trashedCalls`): they leave the libraries with the collection, come back with it (under its new id when
 * it gets one), and are gone when the entry is purged. The trash is per computer, so nothing of a deleted collection may
 * stay in the committed files: a call left there would look like one without a collection on every other computer and
 * be adopted into a new collection (loose-requests.ts). An entry made by an older version has no `trashedCalls`: its
 * calls are still in the libraries, hidden, and are handled as before (re-pointed on restore, deleted on purge).
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

/**
 * A saved JSON item's id and name when it is put back. Its id is what the rest of the workspace knows it by (an
 * environment's secrets, a collection's history and monitors), so it changes only when it must: when an item with that
 * id (or `idTaken`: a file that would hold it) is there again. A name that is taken again gets "(restored)" after it
 * ("(restored 2)" … when that is taken too); the two are told apart, so a name clash never costs the id.
 */
function unclash<T extends { id: string; name: string }>(data: T, existing: Array<{ id: string; name: string }>, idTaken: (id: string) => boolean = () => false): T {
  const hasId = (id: string) => existing.some((x) => x.id === id) || idTaken(id);
  const names = new Set(existing.map((x) => String(x.name).toLowerCase()));
  let { id, name } = data;
  if (names.has(String(name).toLowerCase())) {
    name = `${data.name} (restored)`;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${data.name} (restored ${n})`;
  }
  while (hasId(id)) id = `${slugify(String(data.name)) || 'item'}-${shortId().slice(-4)}`;
  return id === data.id && name === data.name ? data : { ...data, id, name };
}

/** A file put back in its folder; when the name is taken again as name-restored.ext, then name-restored-2.ext … (never over a file). */
function restoreFile(path: string, dir: string, rel: string): string {
  const wanted = join(dir, ...rel.split('/'));
  let dest = wanted;
  for (let n = 1; existsSync(dest); n++) dest = wanted.replace(/(\.[^./\\]+)?$/, `-restored${n > 1 ? `-${n}` : ''}$1`);
  mkdirSync(join(dest, '..'), { recursive: true });
  renameOwned(path, dest);
  return dest;
}

/** The gRPC calls and connections a trashed collection carries, by library. */
type TrashedCalls = Partial<Record<CollectionItemKind, LibraryItem[]>>;
type CollectionItemKind = (typeof COLLECTION_ITEM_KINDS)[number];
const callsOf = (data: Record<string, unknown>): TrashedCalls | undefined => (data.trashedCalls && typeof data.trashedCalls === 'object' ? (data.trashedCalls as TrashedCalls) : undefined);

const count = (data: Record<string, unknown>): number => {
  const walk = (nodes: unknown): number => (Array.isArray(nodes) ? nodes.reduce<number>((n, x) => n + ((x as { kind?: string }).kind === 'folder' ? walk((x as { items?: unknown }).items) : 1), 0) : 0);
  const calls = Object.values(callsOf(data) ?? {}).reduce((n, items) => n + (Array.isArray(items) ? items.length : 0), 0);
  return walk(data.items) + calls;
};

/**
 * A collection file on its way to the trash takes its gRPC calls and connections along: the entry at `dest` is the
 * collection with its calls (`trashedCalls`, written even when it has none: that is how an entry says its calls are
 * not in the libraries), the libraries are saved without them, and the collection file is removed last, so a failure
 * on the way leaves the collection where it was. False when the calls cannot be taken (a file that is not a readable
 * collection, a library that cannot be read, a caller without the libraries): the file is then moved as it is.
 */
function trashCollectionWithCalls(store: WorkspaceStore, file: string, dest: string): boolean {
  if (typeof store.getLibrary !== 'function') return false;
  let data: Record<string, unknown>;
  const libs: Array<{ kind: CollectionItemKind; lib: ReturnType<WorkspaceStore['getLibrary']> }> = [];
  try {
    data = readJson<Record<string, unknown>>(file);
    if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !data.id) return false;
    // a second file with the id of a collection that stays (a copy made by hand, a stray the template update merges): the calls are the other one's
    const named = store.path('collections', `${slugify(data.id)}.json`);
    if (resolve(named) !== resolve(file) && existsSync(named)) return false;
    for (const kind of COLLECTION_ITEM_KINDS) libs.push({ kind, lib: store.getLibrary(kind) });
  } catch {
    return false;
  }
  const id = data.id as string;
  const trashedCalls: TrashedCalls = {};
  for (const { kind, lib } of libs) {
    const mine = (lib.items as LibraryItem[]).filter((i) => i.collectionId === id);
    if (mine.length) trashedCalls[kind] = mine;
  }
  writeJson(dest, { ...data, trashedCalls });
  const saved: typeof libs = [];
  try {
    for (const l of libs) {
      if (!trashedCalls[l.kind]) continue;
      store.saveLibrary(l.kind, { folders: l.lib.folders, items: (l.lib.items as LibraryItem[]).filter((i) => i.collectionId !== id) });
      saved.push(l);
    }
    removeOwned(file);
  } catch (e) {
    // nothing half done: the libraries as they were, no entry
    for (const l of saved)
      try {
        store.saveLibrary(l.kind, { folders: l.lib.folders, items: l.lib.items });
      } catch {
        /* the entry is removed below only when every library is back */
      }
    rmSync(dest, { force: true });
    throw e;
  }
  return true;
}

/**
 * A restored collection's calls go back into the libraries, in that collection (`collectionId`: its id now; `was`: the
 * id it was deleted with). A call whose id another call has taken since gets a new one. A call that is in the library
 * again as it was deleted (same id, still naming the deleted collection, which no live collection is: a window that
 * saved the library from an older copy) is that call: the restored one takes its place instead of standing beside it.
 */
function putBackCalls(store: WorkspaceStore, calls: TrashedCalls, collectionId: string, was: string, wasLive: boolean): void {
  const back = COLLECTION_ITEM_KINDS.map((kind) => ({ kind, items: (Array.isArray(calls[kind]) ? calls[kind]! : []).filter((i) => i && typeof i === 'object' && typeof i.id === 'string') })).filter((b) => b.items.length);
  if (!back.length) return;
  const libs = new Map(back.map((b) => [b.kind, store.getLibrary<unknown>(b.kind)]));
  // new ids first, for both libraries: a call that follows a renamed one (`after`) follows it under its new id
  const renamed = new Map<string, string>();
  const replaced = new Set<string>();
  for (const b of back) {
    const there = new Map((libs.get(b.kind)!.items as LibraryItem[]).map((i) => [i.id, i]));
    for (const i of b.items) {
      const twin = there.get(i.id);
      if (!twin) continue;
      if (!wasLive && twin.collectionId === was) replaced.add(`${b.kind}/${i.id}`);
      else renamed.set(i.id, shortId('lib-'));
    }
  }
  for (const b of back) {
    const lib = libs.get(b.kind)!;
    const items = b.items.map((i) => ({ ...i, id: renamed.get(i.id) ?? i.id, collectionId, ...(i.after && renamed.has(i.after) ? { after: renamed.get(i.after)! } : {}) }));
    store.saveLibrary(b.kind, { folders: lib.folders, items: [...(lib.items as LibraryItem[]).filter((i) => !replaced.has(`${b.kind}/${i.id}`)), ...items] });
  }
}

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
      const { trashedCalls: _calls, ...data } = readJson<{ id: string; name: string } & Record<string, unknown>>(path);
      const calls = callsOf({ trashedCalls: _calls });
      const existing = store.listCollections().map((c) => ({ id: c.id, name: c.name }));
      // (a file named after the id that holds another collection would be replaced by the save: the id counts as taken)
      const item = unclash(data, existing, (id) => existsSync(store.path('collections', `${slugify(id)}.json`)));
      store.saveCollection(item as never);
      // its gRPC calls and connections come back with it, in the collection as it is called now
      if (calls) putBackCalls(store, calls, item.id, data.id, existing.some((x) => x.id === data.id));
      // an entry of an older version: its calls stayed in the libraries. Restored under a new id (its id is taken again),
      // they follow it, unless a live collection has the old id (then they can't be told apart and stay where they are)
      else if (item.id !== data.id && !existing.some((x) => x.id === data.id))
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
      // the id stays whenever it can: the environment's secret values are kept under it
      const item = unclash(readJson<{ id: string; name: string } & Record<string, unknown>>(path), store.listEnvironments(), (id) => existsSync(store.path('environments', `${slugify(id)}.json`)));
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
  const dir = ensureTrashDir(store, kind);
  // (two items of one name deleted in the same millisecond: the second entry never replaces the first)
  let at = Date.now();
  while (existsSync(join(dir, `${at}--${entryName}`))) at++;
  const name = `${at}--${entryName}`;
  const dest = join(dir, name);
  // a collection takes its gRPC calls and connections along (see the top of this file)
  if (kind !== 'collection' || !trashCollectionWithCalls(store, file, dest)) renameOwned(file, dest);
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

/**
 * The id of a trashed collection whose calls are still in the libraries (an entry of an older version); undefined for
 * an entry that carries its calls (nothing of it is in the libraries) and for an unreadable file.
 */
function legacyCollectionId(path: string): string | undefined {
  try {
    const data = readJson<Record<string, unknown>>(path);
    return typeof data.id === 'string' && !callsOf(data) ? data.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collections of older entries are gone for good: delete their gRPC calls and connections from the libraries too.
 * Not those of an id a live collection has again, nor of an id another older entry still in the trash has (two
 * deleted collections with one id: the calls go with the last of them).
 */
function dropCollectionItems(store: WorkspaceStore, collectionIds: Array<string | undefined>): void {
  if (!collectionIds.some(Boolean)) return;
  const kept = new Set(store.listCollections().map((c) => c.id));
  const dir = trashDir(store, 'collection');
  if (existsSync(dir))
    for (const f of readdirSync(dir)) {
      const id = legacyCollectionId(join(dir, f));
      if (id) kept.add(id);
    }
  const gone = new Set(collectionIds.filter((id): id is string => !!id && !kept.has(id)));
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
      const gone = kind === 'collection' ? legacyCollectionId(path) : undefined;
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
 * Put a deleted item back. Nothing is overwritten: if the workspace has an item with the same name again, the restored
 * one gets "(restored)" after its name and keeps its id; only when its id is taken again does it get a new one (and
 * keeps its name when that is free). A
 * dataset or an API definition goes back to its folder (as name-restored.ext, name-restored-2.ext … when the name is
 * taken again); an MCP server to its place in the list.
 */
export function restoreFromTrash(store: WorkspaceStore, id: string): { kind: TrashKind; id: string; name: string } {
  const { kind, path, name } = entryPath(store, id);
  return { kind, ...KINDS[kind].restore(store, path, name) };
}

/** Delete trash entries for good: one, or all. */
export function purgeTrash(store: WorkspaceStore, id?: string): number {
  if (id) {
    const { kind, path } = entryPath(store, id);
    // (an entry that carries its calls takes them with it; only an older entry's calls are in the libraries)
    const gone = kind === 'collection' ? legacyCollectionId(path) : undefined;
    rmSync(path, { force: true });
    dropCollectionItems(store, [gone]);
    return 1;
  }
  const items = listTrash(store);
  const dir = trashDir(store, 'collection');
  const gone = existsSync(dir) ? readdirSync(dir).map((f) => legacyCollectionId(join(dir, f))) : [];
  for (const kind of TRASH_KINDS) rmSync(trashDir(store, kind), { recursive: true, force: true });
  dropCollectionItems(store, gone);
  return items.length;
}
