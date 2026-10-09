import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../api';
import type { Collection, CollectionNode } from '../types';

/**
 * The workspace's collections, fetched once for the whole app and kept current by the backend's `data.changed`
 * events. Two lists:
 *
 * - the outline (`col.tree`, `useCollectionTree`): ids, names, methods and URLs, folders, favourites, examples (name
 *   and status). No bodies, headers or scripts: what the explorer, the breadcrumbs and the pickers show, a fraction of
 *   the bytes. An outline is marked `slim` and is never saved (read the collection with `fullCollection` first).
 * - the whole collections (`col.list`, `useCollections`): only for views that read or edit what is in them. It is
 *   read only while such a view is mounted; otherwise a change only marks it stale.
 *
 * A change refreshes only what it touched: a saved collection (or a file changed on disk) is read on its own; a
 * change that is not about collections (a library, an environment, a monitor, a run) reads nothing.
 */
export type CollectionOutline = Collection & { slim?: true; variableCount?: number };

interface ListState {
  list: Collection[];
  loaded: boolean;
}

/** One list (outline or whole) with its fetches: overlapping fetches never put an older read over a newer one. */
function makeList(listMethod: string, someMethod: (ids: string[]) => Promise<Array<Collection | undefined>>, shape: (c: Collection) => Collection = (c) => c) {
  const store = create<ListState>(() => ({ list: [], loaded: false }));
  let pending: Promise<Collection[]> | undefined;
  let gen = 0;
  const readAt = new Map<string, number>();
  const all = (): Promise<Collection[]> => {
    const g = ++gen;
    pending ??= call<Collection[]>(listMethod)
      .then((got) => {
        const fetched = got.map(shape);
        const now = new Map(store.getState().list.map((c) => [c.id, c]));
        const list = fetched.map((c) => ((readAt.get(c.id) ?? 0) > g && now.has(c.id) ? now.get(c.id)! : c));
        store.setState({ list, loaded: true });
        return list;
      })
      .catch(() => store.getState().list)
      .finally(() => (pending = undefined));
    return pending;
  };
  /** Read only these collections; one that is new or gone reads the whole list. */
  const some = async (ids: string[]): Promise<void> => {
    const g = ++gen;
    const fresh = (await someMethod(ids).catch(() => ids.map(() => undefined))).map((c) => c && shape(c));
    const known = new Set(store.getState().list.map((c) => c.id));
    if (fresh.some((c) => !c) || ids.some((id) => !known.has(id))) return void (await all());
    for (const c of fresh) if ((readAt.get(c!.id) ?? 0) < g) readAt.set(c!.id, g);
    const byId = new Map(fresh.map((c) => [c!.id, c!]));
    store.setState((st) => ({ list: st.list.map((c) => byId.get(c.id) ?? c) }));
  };
  return { store, all, some, pendingAll: () => pending };
}

/**
 * An outline's requests carry their method and URL (endpoint) flat on the wire; here they get the `request` of a
 * saved request, so the tree, the filter and the pickers read an outline like a whole collection.
 */
function outlineNodes(nodes: CollectionNode[]): CollectionNode[] {
  return nodes.map((n) => {
    if (n.kind === 'folder') return { ...n, items: outlineNodes(n.items ?? []) };
    const flat = n as CollectionNode & { method?: string; url?: string; endpoint?: string };
    if ((n as { request?: unknown }).request) return n;
    return (n.kind === 'graphql' ? { ...n, request: { endpoint: flat.endpoint ?? '' } } : { ...n, request: { method: flat.method ?? 'GET', url: flat.url ?? '' } }) as CollectionNode;
  });
}
const outline = makeList('col.tree', (ids) => call<Array<Collection | undefined>>('col.tree', { ids }), (c) => ({ ...c, items: outlineNodes(c.items ?? []) }));
const whole = makeList('col.list', (ids) => Promise.all(ids.map((id) => call<Collection>('col.get', { id }).catch(() => undefined))));

/** How many mounted views read the whole collections: none, and a change only marks the list stale. */
let wholeUsers = 0;
let wholeStale = false;

/** Fetch the collections now (callers that just saved one can await the fresh list): the outline and, when in use, the whole list. */
export function refreshCollections(): Promise<Collection[]> {
  const o = outline.all();
  if (!wholeUsers) {
    if (whole.store.getState().loaded) wholeStale = true;
    return o;
  }
  return Promise.all([o, whole.all()]).then(([, w]) => w);
}

/** After saving one collection: read it back (callers that go on with the fresh list await it). */
export async function refreshCollection(id: string): Promise<void> {
  if (!wholeUsers && whole.store.getState().loaded) wholeStale = true;
  await Promise.all([outline.some([id]), wholeUsers ? whole.some([id]) : undefined]);
}

/** Methods (`data.changed`) whose changes are not about collections: the lists stay as they are. */
const NOT_COLLECTIONS = /^(lib\.save|env\.\w+|vars\.setInEnvironment|monitor\.\w+|mcp\.\w+)$/;

/** What a `data.changed` means for the collections: nothing, some of them (by id), or all of them. */
export function collectionsTouched(e: { method?: string; collectionId?: string; collectionIds?: string[]; kind?: string; kinds?: string[] } | undefined): 'none' | 'all' | string[] {
  if (!e) return 'all';
  // a run, a dataset, a history entry (`{ kind }`): no collection changed
  if (!e.method) return e.kind ? 'none' : 'all';
  if (NOT_COLLECTIONS.test(e.method)) return 'none';
  if (e.method === 'col.save' && e.collectionId) return [e.collectionId];
  if (e.method === 'disk') {
    if (e.kinds && !e.kinds.includes('collections') && !e.kinds.includes('workspace')) return 'none';
    if (e.collectionIds && !e.kinds?.includes('workspace')) return e.collectionIds.length ? e.collectionIds : 'none';
  }
  return 'all';
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // the changes since the last refresh: the saved collections, or "everything" (an import, a delete, a move, git).
  // The first change refreshes at once (in the next task, so a burst in one task is one refresh); changes that come
  // while it runs are read in one more round after it, not one each.
  let saved = new Set<string>();
  let everything = false;
  let running = false;
  const refresh = async (ids: string[] | 'all') => {
    const useWhole = wholeUsers > 0;
    if (!useWhole && whole.store.getState().loaded) wholeStale = true;
    const lists = useWhole ? [outline, whole] : [outline];
    await Promise.all(
      lists.map((l) => {
        if (ids !== 'all') return l.some(ids);
        // a fetch already under way may have started before this change: read again after it
        const p = l.pendingAll();
        return p ? p.then(() => l.all()) : l.all();
      }),
    );
  };
  const run = async () => {
    try {
      while (everything || saved.size) {
        const ids = [...saved];
        const all = everything;
        saved = new Set();
        everything = false;
        await refresh(all ? 'all' : ids);
      }
    } finally {
      running = false;
    }
  };
  on<Parameters<typeof collectionsTouched>[0]>('data.changed', (e) => {
    const touched = collectionsTouched(e);
    if (touched === 'none') return;
    if (touched === 'all') everything = true;
    else touched.forEach((id) => saved.add(id));
    if (running) return;
    running = true;
    setTimeout(() => void run(), 0);
  });
}

/** The collections' outline (no bodies, headers or scripts), kept up to date: the explorer, breadcrumbs and pickers. */
export function useCollectionTree(): CollectionOutline[] {
  const list = outline.store((s) => s.list);
  useEffect(() => {
    wire();
    if (!outline.store.getState().loaded) void outline.all();
  }, []);
  return list;
}

/** The whole collections, kept up to date while the view is mounted (corrupted files included, with `problem` set). */
export function useCollections(): Collection[] {
  const list = whole.store((s) => s.list);
  useEffect(() => {
    wire();
    wholeUsers++;
    if (!whole.store.getState().loaded || wholeStale) {
      wholeStale = false;
      void whole.all();
    }
    return () => void wholeUsers--;
  }, []);
  return list;
}

/** The whole collections as they are now, without subscribing (event handlers); may be empty or stale when no view reads them. */
export const currentCollections = () => (wholeStale ? [] : whole.store.getState().list);

/** The outline as it is now, without subscribing. */
export const currentCollectionTree = (): CollectionOutline[] => outline.store.getState().list;

/** Whether a collection is an outline (`col.tree`): read it whole before changing it. */
export const isOutline = (c: Collection): boolean => !!(c as CollectionOutline).slim;

/** The whole collection behind an outline (a whole one as it is). */
export const fullCollection = (c: Collection): Promise<Collection> => (isOutline(c) ? call<Collection>('col.get', { id: c.id }) : Promise.resolve(c));
