/**
 * The lookups every kind's `resolve` shares: by id through an index, never a scan of the workspace. A per-file id map,
 * rebuilt only when the file changed, for collections and libraries; a stat for files. So a ref resolves as fast in a
 * 9,000-request workspace as in an empty one.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ItemRef, RefResolution, RequestProtocol } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { CollectionNode } from '../model/types.js';
import { readJson } from '../storage/fsutil.js';

export interface Indexed {
  mtime: number;
  size: number;
  name: string;
  byId: Map<string, { name: string; kind: string; protocol?: RequestProtocol; path: string[] }>;
}
// per file: the ids in it (bounded: one entry per collection or library file of the open workspaces)
const indexes = new Map<string, Indexed>(); // bounded: INDEX_LIMIT files
const INDEX_LIMIT = 500;

function stamp(file: string): { mtime: number; size: number } | undefined {
  try {
    const s = statSync(file);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

function indexed(file: string, build: () => Omit<Indexed, 'mtime' | 'size'>): Indexed | undefined {
  const st = stamp(file);
  if (!st) return undefined;
  const hit = indexes.get(file);
  if (hit && hit.mtime === st.mtime && hit.size === st.size) return hit;
  const next = { ...build(), ...st };
  if (indexes.size >= INDEX_LIMIT) indexes.delete(indexes.keys().next().value!);
  indexes.set(file, next);
  return next;
}

/** SOAP is an HTTP request with an XML envelope or a SOAPAction header (as the explorer files it). */
function protocolOf(n: CollectionNode): RequestProtocol | undefined {
  if (n.kind === 'graphql') return 'graphql';
  if (n.kind !== 'http') return undefined;
  const r = n.request;
  const soap =
    r.headers?.some((h) => h.key.toLowerCase() === 'soapaction' || (h.key.toLowerCase() === 'content-type' && /application\/soap\+xml/i.test(h.value))) ||
    (r.body && 'content' in r.body && /<(\w+:)?Envelope[\s>]/.test(r.body.content));
  return soap ? 'soap' : 'http';
}

/** The ids of a collection's requests and folders (with their protocol and path of names); undefined when the collection isn't there. */
export function collectionIndex(store: WorkspaceStore, collectionId: string): Indexed | undefined {
  let rel: string;
  try {
    rel = store.collectionFileOf(collectionId);
  } catch {
    return undefined;
  }
  return indexed(join(store.root, rel), () => {
    const c = store.getCollection(collectionId);
    const byId: Indexed['byId'] = new Map();
    const walk = (nodes: CollectionNode[], path: string[]) => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          byId.set(n.id, { name: n.name, kind: 'folder', path });
          walk(n.items, [...path, n.name]);
        } else byId.set(n.id, { name: n.name, kind: n.kind, protocol: protocolOf(n), path });
      }
    };
    walk(c.items, []);
    return { name: c.name, byId };
  });
}

/** The ids of a library's items (library/<library>.json); undefined when the file isn't there or the name is not a library's. */
export function libraryIndex(store: WorkspaceStore, library: string): Indexed | undefined {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(library)) return undefined;
  return indexed(store.path('library', `${library}.json`), () => ({
    name: library,
    byId: new Map(store.getLibrary<Record<string, unknown>>(library).items.map((i) => [i.id, { name: i.name, kind: library, path: i.folder ? [i.folder] : [] }])),
  }));
}

/**
 * An environment's name and variable keys (as `var:<key>` ids), from its own file (found by its id's slug, never by
 * reading every environment); undefined when there is no such environment. An unreadable file still names it, as the
 * list does.
 */
export function environmentIndex(store: WorkspaceStore, environmentId: string): Indexed | undefined {
  let rel: string;
  try {
    rel = store.environmentFileOf(environmentId);
  } catch {
    return undefined;
  }
  const file = join(store.root, rel);
  const index = indexed(file, () => {
    const base = basename(rel, '.json');
    const byId: Indexed['byId'] = new Map();
    try {
      const e = readJson<{ id?: unknown; name?: unknown; variables?: unknown }>(file);
      const id = typeof e.id === 'string' && e.id ? e.id : base;
      byId.set(id, { name: typeof e.name === 'string' && e.name ? e.name : id, kind: 'environment', path: [] });
      if (Array.isArray(e.variables)) for (const v of e.variables) if (v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string') byId.set(`var:${(v as { key: string }).key}`, { name: (v as { key: string }).key, kind: 'variable', path: [] });
      return { name: typeof e.name === 'string' && e.name ? e.name : id, byId };
    } catch {
      byId.set(base, { name: base, kind: 'environment', path: [] });
      return { name: base, byId };
    }
  });
  // the file found by name (environmentFileOf falls back to it) is not this id's
  return index && index.byId.get(environmentId)?.kind === 'environment' ? index : undefined;
}

/** The ids of a list kept in one workspace file (mcp-servers.json `servers`, providers.json `providers`); undefined without the file. */
export function fileListIndex(store: WorkspaceStore, file: string, key: string): Indexed | undefined {
  return indexed(store.path(file), () => {
    const list = readJson<Record<string, unknown>>(store.path(file), {})[key];
    const byId: Indexed['byId'] = new Map();
    if (Array.isArray(list)) for (const it of list) if (it && typeof it === 'object' && typeof (it as { id?: unknown }).id === 'string') byId.set((it as { id: string }).id, { name: String((it as { name?: unknown }).name ?? (it as { id: string }).id), kind: key, path: [] });
    return { name: file, byId };
  });
}

/** The file `rel` inside `base` when it exists and is a file (never outside `base`). */
export const fileIn = (store: WorkspaceStore, base: string, rel: string): string | undefined => {
  try {
    const p = store.safePath(rel, base);
    return existsSync(p) && statSync(p).isFile() ? p : undefined;
  } catch {
    return undefined;
  }
};

export const ok = (ref: ItemRef, label: string, detail?: string): RefResolution => ({ ok: true, ref, label, ...(detail ? { detail } : {}) });
export const missing = (ref: ItemRef, message: string, next?: { label: string; ref?: ItemRef; view?: string }): RefResolution => ({
  ok: false,
  ref,
  reason: 'missing',
  message,
  ...(next ? { next } : {}),
});
