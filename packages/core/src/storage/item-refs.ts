/**
 * Whether an ItemRef (@testpion/shared) still points at something, what it is called, and, when it doesn't, the nearest
 * thing that is still there. Every lookup is by id through an index: the metadata database for history, traces and
 * runs; a per-file id map, rebuilt only when the file changed, for collections and libraries; a stat for files. So it is
 * as fast in a 9,000-request workspace as in an empty one (one click, one answer, no scan of the workspace).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ITEM_KIND_LABEL, LIBRARY_LABEL, toItemRef, type ItemRef, type RefResolution, type RequestProtocol } from '@testpion/shared';
import type { WorkspaceStore } from './workspace.js';
import type { CollectionNode } from '../model/types.js';

export type { ItemRef, RefResolution } from '@testpion/shared';

interface Indexed {
  mtime: number;
  size: number;
  name: string;
  byId: Map<string, { name: string; kind: string; protocol?: RequestProtocol; path: string[] }>;
}
// per file: the ids in it (bounded: one entry per collection or library file of the open workspaces)
const indexes = new Map<string, Indexed>();
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

function libraryIndex(store: WorkspaceStore, library: string): Indexed | undefined {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(library)) return undefined;
  return indexed(store.path('library', `${library}.json`), () => ({
    name: library,
    byId: new Map(store.getLibrary<Record<string, unknown>>(library).items.map((i) => [i.id, { name: i.name, kind: library, path: i.folder ? [i.folder] : [] }])),
  }));
}

const fileIn = (store: WorkspaceStore, base: string, rel: string): string | undefined => {
  try {
    const p = store.safePath(rel, base);
    return existsSync(p) && statSync(p).isFile() ? p : undefined;
  } catch {
    return undefined;
  }
};

const ok = (ref: ItemRef, label: string, detail?: string): RefResolution => ({ ok: true, ref, label, ...(detail ? { detail } : {}) });
const missing = (ref: ItemRef, message: string, next?: { label: string; ref?: ItemRef; view?: string }): RefResolution => ({ ok: false, ref, reason: 'missing', message, ...(next ? { next } : {}) });

/**
 * Resolve a ref against a workspace: `ok` with its name (and, for a request, its protocol filled in), or why not with
 * the nearest thing that is still there. Kinds that live outside the workspace files (a Debugger exchange, a docs
 * page) resolve as they are; the host checks those.
 */
export function resolveItemRef(store: WorkspaceStore, value: unknown): RefResolution {
  const ref = toItemRef(value);
  if (!ref) return { ok: false, ref: value as ItemRef, reason: 'invalid', message: 'That is not a link to something in TestPion' };
  const r = ref;
  switch (r.kind) {
    case 'request':
    case 'folder': {
      const c = collectionIndex(store, r.collectionId);
      if (!c) return missing(r, 'Its collection is no longer in this workspace (deleted, or in another workspace).', { label: 'Search the workspace', view: 'search' });
      const id = r.kind === 'request' ? r.requestId : r.folderId;
      const n = c.byId.get(id);
      const want = r.kind === 'request' ? n && n.kind !== 'folder' : n?.kind === 'folder';
      if (!n || !want)
        return missing(r, `It is no longer in the collection "${c.name}" (deleted or moved to another collection).`, {
          label: `Open ${c.name}`,
          ref: { kind: 'collection', collectionId: r.collectionId },
        });
      const label = [c.name, ...n.path, n.name].join(' / ');
      return r.kind === 'request' ? ok({ ...r, ...(n.protocol ? { protocol: n.protocol } : {}) }, n.name, label) : ok(r, n.name, label);
    }
    case 'collection':
    case 'mock': {
      const c = collectionIndex(store, r.collectionId);
      return c ? ok(r, c.name) : missing(r, 'That collection is no longer in this workspace (deleted, or in another workspace).', { label: 'Open Collections', view: 'collections' });
    }
    case 'saved': {
      const lib = libraryIndex(store, r.library);
      const it = lib?.byId.get(r.itemId);
      const what = LIBRARY_LABEL[r.library] ?? 'saved item';
      return it
        ? ok(r, it.name, what)
        : missing(r, `That ${what.toLowerCase()} is no longer saved in this workspace (deleted, or in another workspace).`, { label: 'Search the workspace', view: 'search' });
    }
    case 'monitor': {
      const it = libraryIndex(store, 'monitors')?.byId.get(r.monitorId);
      return it ? ok(r, it.name, 'Monitor') : missing(r, 'That monitor no longer exists (deleted, or in another workspace).', { label: 'Open Monitors', view: 'monitors' });
    }
    case 'environment': {
      if (!r.environmentId) return ok(r, r.scope === 'globals' ? 'Globals' : r.scope === 'workspace' ? 'Workspace variables' : r.scope === 'collection' ? 'Collection variables' : 'Environments');
      const e = store.listEnvironments().find((x) => x.id === r.environmentId);
      return e ? ok(r, e.name, 'Environment') : missing(r, 'That environment no longer exists (deleted or renamed in another workspace).', { label: 'Open Environments', view: 'environments' });
    }
    case 'variable': {
      if (!r.environmentId) return ok(r, r.key, 'Variable');
      const e = store.listEnvironments().find((x) => x.id === r.environmentId);
      if (!e) return missing(r, 'The environment of that variable no longer exists.', { label: 'Open Environments', view: 'environments' });
      return e.variables.some((v) => v.key === r.key)
        ? ok(r, r.key, `Variable in ${e.name}`)
        : missing(r, `"${r.key}" is no longer a variable of ${e.name}.`, { label: `Open ${e.name}`, ref: { kind: 'environment', environmentId: e.id } });
    }
    case 'test':
    case 'flow':
      return fileIn(store, store.path('tests'), r.path)
        ? ok(r, r.path.replace(/^.*\//, ''), `tests/${r.path}`)
        : missing(r, `tests/${r.path} is no longer there (deleted, renamed or moved).`, { label: 'Open Tests', view: 'tests' });
    case 'test-case':
      return ok(r, r.testId, 'Test');
    case 'run': {
      let dir: string | undefined;
      try {
        dir = store.runDir(r.runId);
      } catch {
        dir = undefined;
      }
      return dir && existsSync(dir) ? ok(r, r.runId, 'Run') : missing(r, 'That run is no longer kept (deleted, cleaned up, or from another workspace).', { label: 'Open the runs', view: 'tests' });
    }
    case 'history': {
      const h = store.meta.getHistory(r.historyId);
      return h ? ok(r, h.name, `${h.kind} · ${h.timestamp}`) : missing(r, 'That history entry is gone (cleared, or from another workspace).', { label: 'Open History', view: 'history' });
    }
    case 'trace': {
      const t = store.meta.getTrace(r.traceId);
      return t ? ok(r, t.name, 'Trace') : missing(r, 'That trace is gone (cleared, or from another workspace).', { label: 'Open Traces', view: 'traces' });
    }
    case 'mcp-server': {
      const s = store.getMcpServers().find((x) => x.id === r.serverId);
      return s ? ok(r, s.name, 'MCP server') : missing(r, 'That MCP server is no longer set up in this workspace.', { label: 'Open MCP', view: 'mcp' });
    }
    case 'provider': {
      const p = store.getProviders().find((x) => x.id === r.providerId);
      return p ? ok(r, p.name, 'AI provider') : missing(r, 'That AI provider is no longer set up.', { label: 'Open AI providers', view: 'ai' });
    }
    case 'spec':
      return /^specs\//.test(r.path) && fileIn(store, store.root, r.path)
        ? ok(r, r.path.replace(/^.*\//, ''), r.path)
        : missing(r, `${r.path} is no longer there (deleted or renamed).`, { label: 'Search the workspace', view: 'search' });
    case 'dataset':
      return fileIn(store, store.path('datasets'), r.name)
        ? ok(r, r.name, `datasets/${r.name}`)
        : missing(r, `datasets/${r.name} is no longer there (deleted or renamed).`, { label: 'Search the workspace', view: 'search' });
    case 'git-file':
      return ok(r, r.path, 'Changed file');
    case 'certificate':
      return ok(r, r.host, 'Certificate');
    case 'exchange':
      return ok(r, r.exchangeId, ITEM_KIND_LABEL.exchange);
    case 'doc':
      return ok(r, r.url, ITEM_KIND_LABEL.doc);
  }
}
